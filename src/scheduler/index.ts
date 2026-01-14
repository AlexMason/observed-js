/**
 * ExecutionTask represents a single queued action invocation
 */
interface ExecutionTask<T> {
    execute: () => Promise<T> | T;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
}

/**
 * ExecutionScheduler manages concurrency and rate limiting for action execution.
 * 
 * This class is logically separated from ActionBuilder to maintain clean architecture
 * and single responsibility principle.
 */
export class ExecutionScheduler {
    /** Maximum number of concurrent executions (default: 1 = sequential) */
    private concurrencyLimit: number;
    /** Maximum executions per second (default: Infinity = no limit) */
    private rateLimitPerSecond: number;
    /** Currently running execution count */
    private activeExecutions: number = 0;
    /** Queue of pending tasks */
    private queue: ExecutionTask<any>[] = [];
    /** Timestamps of recent executions for rate limiting (sliding window) */
    private executionTimestamps: number[] = [];

    constructor(concurrencyLimit: number = 1, rateLimitPerSecond: number = Infinity) {
        this.concurrencyLimit = concurrencyLimit;
        this.rateLimitPerSecond = rateLimitPerSecond;
    }

    /**
     * Update the concurrency limit
     */
    setConcurrency(limit: number): void {
        this.concurrencyLimit = limit;
        // Try to process queue in case new limit allows more executions
        this.processQueue();
    }

    /**
     * Update the rate limit
     */
    setRateLimit(limit: number): void {
        this.rateLimitPerSecond = limit;
        // Try to process queue in case new limit allows more executions
        this.processQueue();
    }

    /**
     * Schedule a task for execution. Returns a promise that resolves when the task completes.
     */
    schedule<T>(execute: () => Promise<T> | T): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const task: ExecutionTask<T> = { execute, resolve, reject };
            this.queue.push(task);
            this.processQueue();
        });
    }

    /**
     * Check if we can execute based on concurrency limit
     */
    private canExecuteConcurrency(): boolean {
        return this.activeExecutions < this.concurrencyLimit;
    }

    /**
     * Check if we can execute based on rate limit (sliding window algorithm)
     */
    private canExecuteRateLimit(): boolean {
        if (this.rateLimitPerSecond === Infinity) {
            return true;
        }
        
        const now = Date.now();
        // Clean up timestamps older than 1 second
        this.executionTimestamps = this.executionTimestamps.filter(
            ts => now - ts < 1000
        );
        
        return this.executionTimestamps.length < this.rateLimitPerSecond;
    }

    /**
     * Calculate how long to wait before we can execute (for rate limiting)
     */
    private getWaitTime(): number {
        if (this.rateLimitPerSecond === Infinity || this.executionTimestamps.length === 0) {
            return 0;
        }
        
        const now = Date.now();
        // Clean up old timestamps
        this.executionTimestamps = this.executionTimestamps.filter(
            ts => now - ts < 1000
        );
        
        if (this.executionTimestamps.length < this.rateLimitPerSecond) {
            return 0;
        }
        
        // Wait until the oldest timestamp expires
        const oldestTimestamp = Math.min(...this.executionTimestamps);
        return Math.max(0, 1000 - (now - oldestTimestamp) + 1);
    }

    /**
     * Process the queue - execute tasks if limits allow
     */
    private processQueue(): void {
        if (this.queue.length === 0) {
            return;
        }

        // Check concurrency limit
        if (!this.canExecuteConcurrency()) {
            return;
        }

        // Check rate limit
        if (!this.canExecuteRateLimit()) {
            // Schedule retry after wait time
            const waitTime = this.getWaitTime();
            if (waitTime > 0) {
                setTimeout(() => this.processQueue(), waitTime);
            }
            return;
        }

        // Get next task and execute
        const task = this.queue.shift();
        if (!task) {
            return;
        }

        this.executeTask(task);

        // Continue processing queue for parallel execution
        if (this.concurrencyLimit > 1) {
            this.processQueue();
        }
    }

    /**
     * Execute a single task with proper tracking
     */
    private async executeTask<T>(task: ExecutionTask<T>): Promise<void> {
        this.activeExecutions++;
        this.executionTimestamps.push(Date.now());

        try {
            const result = await task.execute();
            task.resolve(result);
        } catch (error) {
            task.reject(error as Error);
        } finally {
            this.activeExecutions--;
            // Process next item in queue
            this.processQueue();
        }
    }

    /**
     * Get current queue length (useful for monitoring)
     */
    getQueueLength(): number {
        return this.queue.length;
    }

    /**
     * Get current active execution count (useful for monitoring)
     */
    getActiveCount(): number {
        return this.activeExecutions;
    }
}

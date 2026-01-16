import { CancellationError } from "../actions/index.js";

/**
 * ExecutionTask represents a single queued action invocation
 */
interface ExecutionTask<T> {
    actionId: string;
    execute: () => Promise<T> | T;
    resolve: (value: T) => void;
    reject: (error: Error) => void;
    controller: AbortController;
    cancelled: boolean;
    cancelReason?: string;
}

/**
 * Shutdown options for the scheduler
 */
export interface ShutdownOptions {
    /** Shutdown mode: graceful waits for running tasks, immediate cancels all */
    mode?: 'graceful' | 'immediate';
    /** Timeout in milliseconds for graceful shutdown (default: 30000) */
    timeout?: number;
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
    /** Map of currently running tasks by actionId */
    private runningTasks: Map<string, ExecutionTask<any>> = new Map();
    /** Whether the scheduler is shutting down */
    private isShuttingDown: boolean = false;

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
     * Schedule a task for execution.
     * @overload Simple form - returns a promise directly (backward compatible)
     */
    schedule<T>(execute: () => Promise<T> | T): Promise<T>;
    /**
     * Schedule a task for execution with cancellation support.
     * @overload Extended form - returns promise with controller and task reference
     */
    schedule<T>(actionId: string, execute: (signal: AbortSignal) => Promise<T> | T): { promise: Promise<T>; controller: AbortController; task: ExecutionTask<T> };
    /**
     * Schedule a task for execution. Returns a promise that resolves when the task completes.
     * 
     * Simple form (backward compatible):
     *   schedule(() => someWork()) - returns Promise<T>
     * 
     * Extended form (with cancellation):
     *   schedule(actionId, (signal) => someWork(signal)) - returns { promise, controller, task }
     */
    schedule<T>(
        actionIdOrExecute: string | (() => Promise<T> | T),
        maybeExecute?: (signal: AbortSignal) => Promise<T> | T
    ): Promise<T> | { promise: Promise<T>; controller: AbortController; task: ExecutionTask<T> } {
        // Determine which overload is being used
        const isSimpleForm = typeof actionIdOrExecute === 'function';
        
        const actionId = isSimpleForm ? `task-${Date.now()}-${Math.random()}` : actionIdOrExecute;
        const executeWithSignal = isSimpleForm 
            ? (_signal: AbortSignal) => (actionIdOrExecute as () => Promise<T> | T)()
            : maybeExecute!;
        
        const controller = new AbortController();
        let task: ExecutionTask<T>;
        
        const promise = new Promise<T>((resolve, reject) => {
            task = { 
                actionId,
                execute: () => executeWithSignal(controller.signal), 
                resolve, 
                reject,
                controller,
                cancelled: false
            };
            this.queue.push(task);
        });
        
        if (isSimpleForm) {
            // Simple form: process immediately for backward compatibility
            this.processQueue();
            return promise;
        }
        
        // Extended form: defer queue processing to next tick to allow caller to attach 
        // error handlers and cancellation handlers first. This prevents unhandled rejection
        // errors when tasks execute immediately.
        queueMicrotask(() => this.processQueue());
        
        return { promise, controller, task: task! };
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
        // Check if task was cancelled while in queue
        if (task.cancelled) {
            return;
        }
        
        this.activeExecutions++;
        this.executionTimestamps.push(Date.now());
        this.runningTasks.set(task.actionId, task);

        try {
            const result = await task.execute();
            if (!task.cancelled) {
                task.resolve(result);
            } else {
                // Task was cancelled while running but completed anyway
                // Reject with CancellationError to signal cancellation
                task.reject(new CancellationError(task.cancelReason, 'running'));
            }
        } catch (error) {
            // Always reject on error, even if cancelled
            // This ensures the promise settles and the caller gets notified
            task.reject(error as Error);
        } finally {
            this.activeExecutions--;
            this.runningTasks.delete(task.actionId);
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
    
    /**
     * Get number of queued tasks
     */
    get queuedCount(): number {
        return this.queue.length;
    }
    
    /**
     * Get number of running tasks
     */
    get runningCount(): number {
        return this.runningTasks.size;
    }
    
    /**
     * Cancel a specific task by actionId
     */
    cancel(actionId: string, reason?: string): boolean {
        // Check if it's in the queue
        const queueIndex = this.queue.findIndex(t => t.actionId === actionId);
        if (queueIndex !== -1) {
            const task = this.queue[queueIndex]!;
            task.cancelled = true;
            task.cancelReason = reason;
            this.queue.splice(queueIndex, 1);
            
            // Reject immediately - the promise has a rejection handler attached in schedule()
            task.reject(new CancellationError(reason, 'queued'));
            return true;
        }
        
        // Check if it's running
        const runningTask = this.runningTasks.get(actionId);
        if (runningTask) {
            runningTask.cancelled = true;
            runningTask.cancelReason = reason;
            runningTask.controller.abort(reason);
            return true;
        }
        
        return false;
    }
    
    /**
     * Cancel all queued tasks (not running)
     */
    clearQueue(reason?: string): number {
        const count = this.queue.length;
        const queueCopy = [...this.queue];
        this.queue = [];
        
        queueCopy.forEach(task => {
            task.cancelled = true;
            task.cancelReason = reason;
            task.reject(new CancellationError(reason, 'queued'));
        });
        
        return count;
    }
    
    /**
     * Shutdown the scheduler
     */
    async shutdown(options?: ShutdownOptions): Promise<void> {
        const { mode = 'graceful', timeout = 30000 } = options || {};
        
        this.isShuttingDown = true;
        
        if (mode === 'immediate') {
            // Cancel everything immediately
            this.clearQueue('Shutdown');
            
            const runningTasksCopy = Array.from(this.runningTasks.values());
            runningTasksCopy.forEach(task => {
                task.cancelled = true;
                task.cancelReason = 'Shutdown';
                task.controller.abort('Shutdown');
            });
            
            return;
        }
        
        // Graceful: cancel queued, wait for running
        this.clearQueue('Shutdown');
        
        if (this.runningTasks.size === 0) {
            return;
        }
        
        const runningPromises = Array.from(this.runningTasks.values()).map(task => 
            Promise.race([
                new Promise((resolve) => {
                    const originalResolve = task.resolve;
                    const originalReject = task.reject;
                    
                    task.resolve = (value) => {
                        originalResolve(value);
                        resolve(undefined);
                    };
                    
                    task.reject = (error) => {
                        originalReject(error);
                        resolve(undefined);
                    };
                })
            ])
        );
        
        // Race between tasks completing and timeout
        await Promise.race([
            Promise.all(runningPromises),
            new Promise((resolve) => setTimeout(resolve, timeout)).then(() => {
                // Force cancel after timeout
                const runningTasksCopy = Array.from(this.runningTasks.values());
                runningTasksCopy.forEach(task => {
                    task.cancelled = true;
                    task.cancelReason = 'Shutdown timeout';
                    task.controller.abort('Shutdown timeout');
                });
            })
        ]);
    }
    
    /**
     * Drain the queue (cancel queued tasks, wait for running to complete)
     */
    async drain(): Promise<void> {
        return this.shutdown({ mode: 'graceful', timeout: 30000 });
    }
}

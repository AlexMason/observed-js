import { ExecutionScheduler } from "../scheduler/index.js";

export type ActionEvent<I> = {
    requestId: string;
    payload: I;
}

type ActionResult<O> = {
    actionId: string;
    data: Promise<O>;
}

type BatchResult<O> = 
    | { actionId: string; index: number; data: O; error: undefined; }
    | { actionId: string; index: number; data: undefined; error: Error; }

// Utility type to infer parameters from a handler function
type InferInput<T> = T extends (...args: infer P) => any ? P : never;

// Utility type to infer return type from a handler function (supports sync and async)
type InferOutput<T> = T extends (...args: any[]) => Promise<infer R> 
    ? R 
    : T extends (...args: any[]) => infer R 
    ? R 
    : never;

export class ActionBuilder<I extends any[], O> {
    /** The execution scheduler for concurrency and rate limiting */
    private scheduler: ExecutionScheduler;
    /** The user-provided handler function */
    private callbackHandler: (...args: I) => O | Promise<O>;

    constructor(handler: (...args: I) => O | Promise<O>) {
        this.callbackHandler = handler;
        this.scheduler = new ExecutionScheduler();
    }

    /**
     * Set the maximum number of concurrent executions
     * @param concurrency Max concurrent executions (default: 1 = sequential)
     */
    setConcurrency(concurrency: number): ActionBuilder<I, O> {
        this.scheduler.setConcurrency(concurrency);
        return this;
    }

    /**
     * Set the rate limit (max executions per second)
     * @param rateLimit Max executions per second (default: Infinity = no limit)
     */
    setRateLimit(rateLimit: number): ActionBuilder<I, O> {
        this.scheduler.setRateLimit(rateLimit);
        return this;
    }

    /**
     * Invoke the action with the given payload
     * Returns immediately with actionId and a promise for the result
     */
    invoke(...payload: I): ActionResult<O> {
        const actionId = crypto.randomUUID();
        
        const data = this.scheduler.schedule(() => 
            this.callbackHandler(...payload)
        );

        return {
            actionId,
            data
        };
    }

    /**
     * Batch invoke - Promise.all style
     * Waits for all invocations to complete and returns results in input order
     * Individual failures don't fail the whole batch
     */
    async invokeAll(payloads: I[]): Promise<BatchResult<O>[]> {
        if (payloads.length === 0) {
            return [];
        }

        const tasks = payloads.map((payload, index) => ({
            actionId: crypto.randomUUID(),
            index,
            promise: this.scheduler.schedule(() => 
                this.callbackHandler(...payload)
            )
        }));
        
        const settledResults = await Promise.allSettled(
            tasks.map(t => t.promise)
        );

        return settledResults.map((result, idx): BatchResult<O> => {
            const task = tasks[idx]!;
            if (result.status === 'fulfilled') {
                return {
                    actionId: task.actionId,
                    index: task.index,
                    data: result.value,
                    error: undefined
                };
            } else {
                return {
                    actionId: task.actionId,
                    index: task.index,
                    data: undefined,
                    error: result.reason
                };
            }
        });
    }

    /**
     * Batch invoke - Async iterator style
     * Yields results as they complete (not in input order)
     * Ideal for processing results as soon as they're available
     */
    async *invokeStream(payloads: I[]): AsyncGenerator<BatchResult<O>, void, unknown> {
        if (payloads.length === 0) {
            return;
        }

        // Create all tasks with tracking info
        const pendingTasks = new Map<string, Promise<BatchResult<O>>>();
        
        for (let index = 0; index < payloads.length; index++) {
            const payload = payloads[index]!;
            const actionId = crypto.randomUUID();
            
            const taskPromise = this.scheduler.schedule(() => 
                this.callbackHandler(...payload)
            ).then(
                (data): BatchResult<O> => ({ actionId, index, data, error: undefined }),
                (error): BatchResult<O> => ({ actionId, index, data: undefined, error })
            );
            
            pendingTasks.set(actionId, taskPromise);
        }

        // Yield results as they complete
        while (pendingTasks.size > 0) {
            // Race all pending tasks
            const result = await Promise.race(pendingTasks.values());
            
            // Remove completed task and yield result
            pendingTasks.delete(result.actionId);
            yield result;
        }
    }

    /**
     * Get current queue length (useful for monitoring/backpressure)
     */
    getQueueLength(): number {
        return this.scheduler.getQueueLength();
    }

    /**
     * Get current active execution count (useful for monitoring)
     */
    getActiveCount(): number {
        return this.scheduler.getActiveCount();
    }
}

// Factory function that infers types from the handler
export function createAction<T extends (...args: any[]) => any>(
    handler: T
): ActionBuilder<InferInput<T>, InferOutput<T>> {
    return new ActionBuilder(handler);
}
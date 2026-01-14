import { ExecutionScheduler } from "../scheduler/index.js";

export type ActionEvent<I> = {
    requestId: string;
    payload: I;
}

/**
 * Context object passed to handlers for attaching data
 */
export interface InvocationContext {
    /** Unique identifier for this invocation */
    readonly actionId: string;
    
    /** 
     * Attach data to this invocation's wide event
     * Supports both primitives and objects (objects are deep-merged)
     */
    attach(key: string, value: unknown): void;
    attach(data: Record<string, unknown>): void;
}

/**
 * Complete wide event record after invocation completes
 */
export interface WideEvent<I extends any[], O> {
    /** Unique invocation identifier */
    actionId: string;
    
    /** Invocation start timestamp (epoch ms) */
    startedAt: number;
    
    /** Invocation end timestamp (epoch ms) */
    completedAt: number;
    
    /** Duration in milliseconds */
    duration: number;
    
    /** Input arguments */
    input: I;
    
    /** Output value (if successful) */
    output?: O;
    
    /** Error (if failed) */
    error?: Error;
    
    /** User-attached data */
    attachments: Record<string, unknown>;
}

/**
 * Callback for receiving wide events
 */
export type EventCallback<I extends any[], O> = (event: WideEvent<I, O>) => void | Promise<void>;

/**
 * Internal implementation of InvocationContext
 */
class InvocationContextImpl implements InvocationContext {
    readonly actionId: string;
    private attachmentsMap: Record<string, unknown> = {};

    constructor(actionId: string) {
        this.actionId = actionId;
    }

    attach(keyOrData: string | Record<string, unknown>, value?: unknown): void {
        if (typeof keyOrData === 'string') {
            // Single key-value pair
            const existingValue = this.attachmentsMap[keyOrData];
            
            // If both existing and new values are objects, deep merge them
            if (
                existingValue &&
                typeof existingValue === 'object' &&
                !Array.isArray(existingValue) &&
                value &&
                typeof value === 'object' &&
                !Array.isArray(value)
            ) {
                this.deepMerge(existingValue as Record<string, unknown>, value as Record<string, unknown>);
            } else {
                // Otherwise just set/overwrite
                this.attachmentsMap[keyOrData] = value;
            }
        } else {
            // Object - deep merge into root
            this.deepMerge(this.attachmentsMap, keyOrData);
        }
    }

    private deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): void {
        for (const key in source) {
            const sourceValue = source[key];
            const targetValue = target[key];
            
            if (
                sourceValue && 
                typeof sourceValue === 'object' && 
                !Array.isArray(sourceValue) &&
                targetValue &&
                typeof targetValue === 'object' &&
                !Array.isArray(targetValue)
            ) {
                // Both are objects, recurse
                this.deepMerge(targetValue as Record<string, unknown>, sourceValue as Record<string, unknown>);
            } else {
                // Overwrite
                target[key] = sourceValue;
            }
        }
    }

    getAttachments(): Record<string, unknown> {
        return { ...this.attachmentsMap };
    }
}

type ActionResult<O> = {
    actionId: string;
    data: Promise<O>;
    eventLogged: Promise<void>;
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
    /** Event callback for wide events */
    private eventCallback?: EventCallback<I, O>;
    /** Whether this action uses context (set by withContext wrapper) */
    private usesContext: boolean = false;

    constructor(handler: (...args: I) => O | Promise<O>) {
        // Check if handler was wrapped with withContext
        if ((handler as any).__usesContext && (handler as any).__originalHandler) {
            this.usesContext = true;
            this.callbackHandler = (handler as any).__originalHandler;
        } else {
            this.callbackHandler = handler;
        }
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
     * Register a callback to receive wide events after each invocation
     * @param callback Function to receive wide events
     */
    onEvent(callback: EventCallback<I, O>): ActionBuilder<I, O> {
        this.eventCallback = callback;
        return this;
    }

    /**
     * Mark this action as using context (internal - called by withContext)
     */
    private setUsesContext(value: boolean): void {
        this.usesContext = value;
    }

    /**
     * Invoke the action with the given payload
     * Returns immediately with actionId and a promise for the result
     */
    invoke(...payload: I): ActionResult<O> {
        const actionId = crypto.randomUUID();
        const startedAt = Date.now();
        const context = new InvocationContextImpl(actionId);
        
        let eventLoggedResolve: () => void;
        let eventLoggedReject: (error: Error) => void;
        const eventLogged = new Promise<void>((resolve, reject) => {
            eventLoggedResolve = resolve;
            eventLoggedReject = reject;
        });

        const data = this.scheduler.schedule(async () => {
            let result: O | undefined;
            let error: Error | undefined;
            
            try {
                if (this.usesContext) {
                    // Call handler with context as first argument
                    result = await (this.callbackHandler as any)(context, ...payload);
                } else {
                    // Call handler without context
                    result = await this.callbackHandler(...payload);
                }
                return result as O;
            } catch (e) {
                error = e as Error;
                throw e;
            } finally {
                // Emit wide event after handler completes (success or failure)
                const completedAt = Date.now();
                const wideEvent = {
                    actionId,
                    startedAt,
                    completedAt,
                    duration: completedAt - startedAt,
                    input: payload,
                    output: result,
                    error,
                    attachments: context.getAttachments()
                } as WideEvent<I, O>;

                // Fire event callback (if registered)
                if (this.eventCallback) {
                    try {
                        await this.eventCallback(wideEvent);
                        eventLoggedResolve!();
                    } catch (callbackError) {
                        // Isolate event callback errors - log but don't propagate
                        console.error('Error in event callback:', callbackError);
                        eventLoggedReject!(callbackError as Error);
                    }
                } else {
                    // No callback registered, resolve immediately
                    eventLoggedResolve!();
                }
            }
        });

        return {
            actionId,
            data,
            eventLogged
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

        const tasks = payloads.map((payload, index) => {
            const actionId = crypto.randomUUID();
            const startedAt = Date.now();
            const context = new InvocationContextImpl(actionId);
            
            return {
                actionId,
                index,
                startedAt,
                context,
                promise: this.scheduler.schedule(async () => {
                    let result: O | undefined;
                    let error: Error | undefined;
                    
                    try {
                        if (this.usesContext) {
                            result = await (this.callbackHandler as any)(context, ...payload);
                        } else {
                            result = await this.callbackHandler(...payload);
                        }
                        return result as O;
                    } catch (e) {
                        error = e as Error;
                        throw e;
                    } finally {
                        // Emit wide event
                        const completedAt = Date.now();
                        const wideEvent = {
                            actionId,
                            startedAt,
                            completedAt,
                            duration: completedAt - startedAt,
                            input: payload,
                            output: result,
                            error,
                            attachments: context.getAttachments()
                        } as WideEvent<I, O>;

                        if (this.eventCallback) {
                            try {
                                await this.eventCallback(wideEvent);
                            } catch (callbackError) {
                                console.error('Error in event callback:', callbackError);
                            }
                        }
                    }
                })
            };
        });
        
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
            const startedAt = Date.now();
            const context = new InvocationContextImpl(actionId);
            
            const taskPromise = this.scheduler.schedule(async () => {
                let result: O | undefined;
                let error: Error | undefined;
                
                try {
                    if (this.usesContext) {
                        result = await (this.callbackHandler as any)(context, ...payload);
                    } else {
                        result = await this.callbackHandler(...payload);
                    }
                    return result as O;
                } catch (e) {
                    error = e as Error;
                    throw e;
                } finally {
                    // Emit wide event
                    const completedAt = Date.now();
                    const wideEvent = {
                        actionId,
                        startedAt,
                        completedAt,
                        duration: completedAt - startedAt,
                        input: payload,
                        output: result,
                        error,
                        attachments: context.getAttachments()
                    } as WideEvent<I, O>;

                    if (this.eventCallback) {
                        try {
                            await this.eventCallback(wideEvent);
                        } catch (callbackError) {
                            console.error('Error in event callback:', callbackError);
                        }
                    }
                }
            }).then(
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
    return new ActionBuilder(handler) as unknown as ActionBuilder<InferInput<T>, InferOutput<T>>;
}

/**
 * Wrapper function to enable context for a handler
 * Returns a modified handler that can be used with createAction
 */
export function withContext<Args extends any[], Output>(
    handler: (ctx: InvocationContext, ...args: Args) => Output | Promise<Output>
): ((...args: Args) => Output | Promise<Output>) & { __usesContext: true; __originalHandler: typeof handler } {
    // Return a wrapper that will be detected by ActionBuilder
    const wrapper = ((...args: Args) => {
        // This will never be called directly - ActionBuilder intercepts it
        throw new Error('withContext handler should not be called directly');
    }) as any;
    
    wrapper.__usesContext = true;
    wrapper.__originalHandler = handler;
    
    return wrapper;
}
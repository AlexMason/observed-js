import { ExecutionScheduler } from "../scheduler/index.js";

export type ActionEvent<I> = {
    requestId: string;
    payload: I;
}

/**
 * Retry configuration options
 */
export interface RetryOptions {
    /** Number of retry attempts (0 = no retries) */
    maxRetries: number;
    /** Backoff strategy */
    backoff: 'linear' | 'exponential';
    /** Base delay in milliseconds (default: 100) */
    baseDelay?: number;
    /** Maximum delay cap in milliseconds (default: 30000) */
    maxDelay?: number;
    /** Add randomness to delay to prevent thundering herd (default: false) */
    jitter?: boolean;
    /** Predicate to determine if an error is retryable (default: all errors are retryable) */
    shouldRetry?: (error: unknown) => boolean;
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
    
    /** Current retry attempt number (0 = original, 1+ = retry) */
    retryAttempt?: number;
    
    /** Total attempts made (only present on final event) */
    totalAttempts?: number;
    
    /** Actual delays used for retries in milliseconds */
    retryDelays?: number[];
    
    /** True if this is a retry attempt */
    isRetry?: boolean;
    
    /** True if another retry will be attempted after this failure */
    willRetry?: boolean;
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
    /** Retry configuration */
    private retryOptions?: RetryOptions;

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
     * Configure retry behavior for failed executions
     * @param options Retry configuration
     */
    setRetry(options: RetryOptions): ActionBuilder<I, O> {
        // Validate configuration
        if (options.maxRetries < 0) {
            throw new Error('maxRetries must be >= 0');
        }
        if (options.baseDelay !== undefined && options.baseDelay < 0) {
            throw new Error('baseDelay must be >= 0');
        }
        if (options.maxDelay !== undefined && options.maxDelay < 0) {
            throw new Error('maxDelay must be >= 0');
        }
        
        this.retryOptions = options;
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
     * Calculate retry delay based on backoff strategy
     */
    private calculateRetryDelay(attemptNumber: number, options: RetryOptions): number {
        const baseDelay = options.baseDelay ?? 100;
        const maxDelay = options.maxDelay ?? 30000;
        
        let delay: number;
        if (options.backoff === 'linear') {
            delay = baseDelay * attemptNumber;
        } else {
            // Exponential backoff
            delay = baseDelay * Math.pow(2, attemptNumber - 1);
        }
        
        // Apply max delay cap
        delay = Math.min(delay, maxDelay);
        
        // Apply jitter if enabled
        if (options.jitter) {
            delay = delay * (0.5 + Math.random() * 0.5);
        }
        
        return Math.floor(delay);
    }

    /**
     * Execute handler with retry logic
     */
    private async executeWithRetry(
        context: InvocationContextImpl,
        payload: I,
        actionId: string,
        startedAt: number,
        emitIntermediateEvents: boolean = false
    ): Promise<{ result: O; retryAttempt: number; retryDelays: number[] }> {
        let result: O | undefined;
        let error: Error | undefined;
        const retryDelays: number[] = [];
        let attemptNumber = 0;
        const maxAttempts = (this.retryOptions?.maxRetries ?? 0) + 1;
        
        while (attemptNumber < maxAttempts) {
            const isRetry = attemptNumber > 0;
            
            try {
                if (this.usesContext) {
                    result = await (this.callbackHandler as any)(context, ...payload);
                } else {
                    result = await this.callbackHandler(...payload);
                }
                
                // Success!
                error = undefined;
                break;
            } catch (e) {
                error = e as Error;
                const isLastAttempt = attemptNumber === maxAttempts - 1;
                
                // Determine if we should retry
                let shouldRetry = false;
                if (!isLastAttempt && this.retryOptions) {
                    if (this.retryOptions.shouldRetry) {
                        try {
                            shouldRetry = this.retryOptions.shouldRetry(error);
                        } catch (predicateError) {
                            console.error('Error in shouldRetry predicate:', predicateError);
                            shouldRetry = false;
                        }
                    } else {
                        shouldRetry = true;
                    }
                }
                
                // Fire intermediate event for failed attempt if requested
                if (emitIntermediateEvents && this.eventCallback) {
                    const completedAt = Date.now();
                    const intermediateEvent: WideEvent<I, O> = {
                        actionId,
                        startedAt,
                        completedAt,
                        duration: completedAt - startedAt,
                        input: payload,
                        error,
                        attachments: context.getAttachments(),
                        retryAttempt: attemptNumber,
                        isRetry,
                        willRetry: shouldRetry,
                        retryDelays: [...retryDelays]
                    };
                    
                    try {
                        await this.eventCallback(intermediateEvent);
                    } catch (callbackError) {
                        console.error('Error in event callback:', callbackError);
                    }
                }
                
                if (!shouldRetry) {
                    throw error;
                }
                
                // Calculate and apply retry delay
                attemptNumber++;
                if (attemptNumber < maxAttempts) {
                    const delay = this.calculateRetryDelay(attemptNumber, this.retryOptions!);
                    retryDelays.push(delay);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
        
        if (!error) {
            return { result: result as O, retryAttempt: attemptNumber, retryDelays };
        }
        
        throw error;
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
            return await this.executeWithRetry(context, payload, actionId, startedAt, true);
        });

        // Attach handlers to emit the final wide event
        data.then(
            async (execResult) => {
                // Success path
                const completedAt = Date.now();
                const wideEvent: WideEvent<I, O> = {
                    actionId,
                    startedAt,
                    completedAt,
                    duration: completedAt - startedAt,
                    input: payload,
                    output: execResult.result,
                    attachments: context.getAttachments(),
                    retryAttempt: execResult.retryAttempt,
                    isRetry: execResult.retryAttempt > 0,
                    totalAttempts: execResult.retryAttempt + 1,
                    retryDelays: execResult.retryDelays
                };

                // Fire event callback (if registered)
                if (this.eventCallback) {
                    try {
                        await this.eventCallback(wideEvent);
                        eventLoggedResolve!();
                    } catch (callbackError) {
                        console.error('Error in event callback:', callbackError);
                        eventLoggedReject!(callbackError as Error);
                    }
                } else {
                    eventLoggedResolve!();
                }
            },
            async (error) => {
                // Error path - don't emit another event since the last intermediate event
                // already covered the final failure
                eventLoggedResolve!();
            }
        );

        return {
            actionId,
            data: data.then(r => r.result),
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
                    let retryAttempt = 0;
                    let retryDelays: number[] = [];
                    
                    try {
                        const execResult = await this.executeWithRetry(context, payload, actionId, startedAt, true);
                        result = execResult.result;
                        retryAttempt = execResult.retryAttempt;
                        retryDelays = execResult.retryDelays;
                        return result;
                    } catch (e) {
                        error = e as Error;
                        throw e;
                    } finally {
                        // Emit final wide event
                        const completedAt = Date.now();
                        const wideEvent = {
                            actionId,
                            startedAt,
                            completedAt,
                            duration: completedAt - startedAt,
                            input: payload,
                            output: result,
                            error,
                            attachments: context.getAttachments(),
                            ...(retryDelays.length > 0 ? {
                                retryAttempt,
                                isRetry: retryAttempt > 0,
                                totalAttempts: retryAttempt + 1,
                                retryDelays
                            } : {})
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
                let retryAttempt = 0;
                let retryDelays: number[] = [];
                
                try {
                    const execResult = await this.executeWithRetry(context, payload, actionId, startedAt, true);
                    result = execResult.result;
                    retryAttempt = execResult.retryAttempt;
                    retryDelays = execResult.retryDelays;
                    return result;
                } catch (e) {
                    error = e as Error;
                    throw e;
                } finally {
                    // Emit final wide event
                    const completedAt = Date.now();
                    const wideEvent = {
                        actionId,
                        startedAt,
                        completedAt,
                        duration: completedAt - startedAt,
                        input: payload,
                        output: result,
                        error,
                        attachments: context.getAttachments(),
                        ...(retryDelays.length > 0 ? {
                            retryAttempt,
                            isRetry: retryAttempt > 0,
                            totalAttempts: retryAttempt + 1,
                            retryDelays
                        } : {})
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
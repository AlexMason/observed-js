import { ExecutionScheduler } from "../scheduler/index.js";
import { AsyncLocalStorage } from "node:async_hooks";

export type ActionEvent<I> = {
    requestId: string;
    payload: I;
}

export type Priority = 'low' | 'normal' | 'high' | 'critical' | number;

export interface InvokeOptions {
    /** Override action default priority */
    priority?: Priority;
    /** Custom metadata for observability */
    metadata?: Record<string, unknown>;
}

export interface ContextWarning {
    type: 'attachment-size' | 'depth';
    message: string;
    actionId: string;
    traceId: string;
    currentSize?: number;
    threshold: number;
    depth: number;
}

export interface ContextWarningOptions {
    /** Max total attachment size in bytes before warning */
    maxAttachmentBytes?: number;
    /** Max nesting depth before warning */
    maxDepth?: number;
    /** Custom warning handler (default: console.warn) */
    onWarning?: (warning: ContextWarning) => void;
}

let globalContextWarningOptions: ContextWarningOptions | undefined;

export const setContextWarningThreshold = (options?: ContextWarningOptions): void => {
    globalContextWarningOptions = options;
};

const resolveContextWarningOptions = (actionOptions?: ContextWarningOptions): ContextWarningOptions | undefined => {
    if (!globalContextWarningOptions && !actionOptions) {
        return undefined;
    }
    const merged: ContextWarningOptions = {};

    if (globalContextWarningOptions?.maxAttachmentBytes !== undefined) {
        merged.maxAttachmentBytes = globalContextWarningOptions.maxAttachmentBytes;
    }
    if (globalContextWarningOptions?.maxDepth !== undefined) {
        merged.maxDepth = globalContextWarningOptions.maxDepth;
    }
    if (actionOptions?.maxAttachmentBytes !== undefined) {
        merged.maxAttachmentBytes = actionOptions.maxAttachmentBytes;
    }
    if (actionOptions?.maxDepth !== undefined) {
        merged.maxDepth = actionOptions.maxDepth;
    }

    const onWarning = actionOptions?.onWarning ?? globalContextWarningOptions?.onWarning;
    if (onWarning) {
        merged.onWarning = onWarning;
    }

    return merged;
};

export interface ParentContext {
    readonly actionId: string;
    readonly attachments: Readonly<Record<string, unknown>>;
    readonly traceId: string;
    readonly depth: number;
    readonly parent: ParentContext | undefined;
}

interface PropagationContext {
    traceId: string;
    actionId: string;
    depth: number;
    parent: PropagationContext | undefined;
    parentContext: ParentContext | undefined;
    invocationContext: InvocationContextImpl;
}

const propagationStore = new AsyncLocalStorage<PropagationContext>();

const getPropagationContext = (): PropagationContext | undefined => propagationStore.getStore();

const buildParentContextSnapshot = (context: PropagationContext): ParentContext => {
    if (context.parentContext) {
        return context.parentContext;
    }
    const snapshot: ParentContext = {
        actionId: context.actionId,
        attachments: context.invocationContext.getAttachments(),
        traceId: context.traceId,
        depth: context.depth,
        parent: context.parent ? buildParentContextSnapshot(context.parent) : undefined
    };
    context.parentContext = snapshot;
    return snapshot;
};

const runWithPropagationContext = <T>(context: PropagationContext, fn: () => T): T => {
    return propagationStore.run(context, fn);
};

const PRIORITY_VALUES: Record<Exclude<Priority, number>, number> = {
    low: 0,
    normal: 50,
    high: 75,
    critical: 100
} as const;

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
};

const isInvokeOptions = (value: unknown): value is InvokeOptions => {
    if (!isPlainObject(value)) {
        return false;
    }
    const maybe = value as Record<string, unknown>;
    const hasPriority = Object.prototype.hasOwnProperty.call(maybe, 'priority');
    const hasMetadata = Object.prototype.hasOwnProperty.call(maybe, 'metadata');
    if (!hasPriority && !hasMetadata) {
        return false;
    }
    if (hasPriority) {
        const p = (maybe as any).priority;
        if (p !== undefined && typeof p !== 'string' && typeof p !== 'number') {
            return false;
        }
    }
    if (hasMetadata) {
        const m = (maybe as any).metadata;
        if (m !== undefined && !isPlainObject(m)) {
            return false;
        }
    }
    return true;
};

const normalizePriority = (priority: Priority | undefined): number => {
    if (priority === undefined) {
        return PRIORITY_VALUES.normal;
    }
    if (typeof priority === 'string') {
        const mapped = PRIORITY_VALUES[priority];
        if (mapped === undefined) {
            throw new Error(`Unknown priority level: ${priority}`);
        }
        return mapped;
    }
    if (typeof priority !== 'number' || !Number.isFinite(priority)) {
        throw new Error('Priority must be a finite number');
    }
    if (priority < 0 || priority > 100) {
        throw new Error('Priority must be in range [0, 100]');
    }
    return priority;
};

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
 * Timeout configuration options
 */
export interface TimeoutOptions {
    /** Timeout duration in milliseconds */
    duration: number;
    /** Whether to throw TimeoutError on timeout (default: true) */
    throwOnTimeout?: boolean;
    /** Whether to provide AbortSignal to handler (default: false) */
    abortSignal?: boolean;
}

/**
 * Error thrown when an operation times out
 */
export class TimeoutError extends Error {
    name = 'TimeoutError';
    duration: number;
    
    constructor(duration: number) {
        super(`Operation timed out after ${duration}ms`);
        this.duration = duration;
    }
}

/**
 * Error thrown when an operation is cancelled
 */
export class CancellationError extends Error {
    name = 'CancellationError';
    reason?: string;
    state: 'queued' | 'running' | 'retry-delay';
    
    constructor(reason?: string, state?: 'queued' | 'running' | 'retry-delay') {
        super(reason || 'Task was cancelled');
        if (reason !== undefined) {
            this.reason = reason;
        }
        this.state = state || 'running';
    }
}

/**
 * Context object passed to handlers for attaching data
 */
export interface InvocationContext {
    /** Unique identifier for this invocation */
    readonly actionId: string;

    /** Trace ID for the invocation tree */
    readonly traceId: string;

    /** Depth in call tree (0 = root) */
    readonly depth: number;

    /** Parent context chain (if nested invocation) */
    readonly parent: ParentContext | undefined;
    
    /** 
     * Attach data to this invocation's wide event
     * Supports both primitives and objects (objects are deep-merged)
     */
    attach(key: string, value: unknown): void;
    attach(data: Record<string, unknown>): void;
    
    /**
     * Set total number of progress steps/items
     */
    setTotal(total: number): void;
    
    /**
     * Report progress with specific completed count
     */
    reportProgress(completed: number, current?: string): void;
    
    /**
     * Increment progress by 1
     */
    incrementProgress(current?: string): void;
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

    /** Resolved priority (0-100). Higher executes first. */
    priority: number;

    /** Custom metadata provided at invoke-time */
    metadata?: Record<string, unknown>;
    
    /** Output value (if successful) */
    output?: O;
    
    /** Error (if failed) */
    error?: Error;
    
    /** User-attached data */
    attachments: Record<string, unknown>;

    /** Trace ID for the invocation tree */
    traceId?: string;

    /** Parent action ID (undefined if root invocation) */
    parentActionId?: string;

    /** Depth in call tree (0 = root) */
    depth?: number;

    /** Child action IDs invoked during this execution */
    childActionIds?: string[];

    /** Full child event objects (nested tree structure) */
    children?: WideEvent<any[], any>[];

    /** Total duration spent in child invocations (ms) */
    childDuration?: number;

    /** Self duration = duration - childDuration */
    selfDuration?: number;

    /** Batch ID for grouping invokeAll/invokeStream items */
    batchId?: string;
    
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
    
    /** Configured timeout duration in milliseconds */
    timeout?: number;
    
    /** Whether this invocation timed out */
    timedOut?: boolean;
    
    /** Actual execution time before timeout (may be slightly over timeout due to cleanup) */
    executionTime?: number;
    
    /** Whether this invocation was cancelled */
    cancelled?: boolean;
    
    /** Reason provided when task was cancelled */
    cancelReason?: string;
    
    /** State when task was cancelled */
    cancelledAt?: 'queued' | 'running' | 'retry-delay';
}

/**
 * Callback for receiving wide events
 */
export type EventCallback<I extends any[], O> = (event: WideEvent<I, O>) => void | Promise<void>;

/**
 * Progress information for an invocation
 */
export interface Progress {
    /** Number of completed steps/items */
    completed: number;
    /** Total number of steps/items */
    total: number;
    /** Completion percentage (0-100) */
    percentage: number;
    /** Description of current step */
    current?: string;
    /** Items per second */
    rate?: number;
    /** Milliseconds remaining (estimated) */
    estimatedTimeRemaining?: number;
    /** Timestamp when started (epoch ms) */
    startTime: number;
    /** Milliseconds since start */
    elapsedTime: number;
}

/**
 * Callback for receiving progress updates
 */
export type ProgressCallback = (progress: Progress) => void | Promise<void>;

/**
 * Configuration for progress callback throttling
 */
export interface ProgressOptions {
    /** Minimum milliseconds between progress callbacks (default: 100) */
    throttle?: number;
}

/**
 * Internal implementation of InvocationContext
 */
class InvocationContextImpl implements InvocationContext {
    readonly actionId: string;
    readonly traceId: string;
    readonly depth: number;
    readonly parent: ParentContext | undefined;
    private attachmentsMap: Record<string, unknown> = {};

    private childActionIds: string[] = [];
    private childEvents: WideEvent<any[], any>[] = [];
    private childDuration: number = 0;

    private warningOptions: ContextWarningOptions | undefined;
    private warnedAttachmentSize: boolean = false;
    private warnedDepth: boolean = false;
    
    // Progress tracking state
    private progressTotal: number = 0;
    private progressCompleted: number = 0;
    private progressStartTime: number = 0;
    private lastProgressEmitTime: number = 0;
    private lastProgressPercentage: number = 0;
    private progressRate: number = 0;
    private progressCallback: ProgressCallback | undefined;
    private progressThrottle: number = 100; // ms
    
    constructor(
        actionId: string,
        progressCallback: ProgressCallback | undefined,
        progressThrottle: number | undefined,
        traceId: string,
        depth: number,
        parent: ParentContext | undefined,
        warningOptions: ContextWarningOptions | undefined
    ) {
        this.actionId = actionId;
        this.traceId = traceId;
        this.depth = depth;
        this.parent = parent;
        this.progressCallback = progressCallback;
        if (progressThrottle !== undefined) {
            this.progressThrottle = progressThrottle;
        }
        this.warningOptions = warningOptions;
        this.progressStartTime = Date.now();
        this.checkDepthWarning();
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

        this.checkAttachmentWarning();
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

    registerChild(actionId: string): void {
        if (!this.childActionIds.includes(actionId)) {
            this.childActionIds.push(actionId);
        }
    }

    addChildEvent(event: WideEvent<any[], any>): void {
        this.childEvents.push(event);
        if (!this.childActionIds.includes(event.actionId)) {
            this.childActionIds.push(event.actionId);
        }
        if (typeof event.duration === 'number') {
            this.childDuration += event.duration;
        }
    }

    getChildActionIds(): string[] {
        return [...this.childActionIds];
    }

    getChildEvents(): WideEvent<any[], any>[] {
        return [...this.childEvents];
    }

    getChildDuration(): number {
        return this.childDuration;
    }

    private checkDepthWarning(): void {
        if (!this.warningOptions?.maxDepth || this.warnedDepth) {
            return;
        }
        if (this.depth > this.warningOptions.maxDepth) {
            this.warnedDepth = true;
            this.emitWarning({
                type: 'depth',
                message: `Context depth ${this.depth} exceeded warning threshold ${this.warningOptions.maxDepth}`,
                actionId: this.actionId,
                traceId: this.traceId,
                threshold: this.warningOptions.maxDepth,
                depth: this.depth
            });
        }
    }

    private checkAttachmentWarning(): void {
        if (!this.warningOptions?.maxAttachmentBytes || this.warnedAttachmentSize) {
            return;
        }
        try {
            const serialized = JSON.stringify(this.attachmentsMap);
            const size = Buffer.byteLength(serialized, 'utf8');
            if (size > this.warningOptions.maxAttachmentBytes) {
                this.warnedAttachmentSize = true;
                this.emitWarning({
                    type: 'attachment-size',
                    message: `Attachment size ${size} bytes exceeded warning threshold ${this.warningOptions.maxAttachmentBytes}`,
                    actionId: this.actionId,
                    traceId: this.traceId,
                    currentSize: size,
                    threshold: this.warningOptions.maxAttachmentBytes,
                    depth: this.depth
                });
            }
        } catch (error) {
            // Ignore serialization errors for warnings
        }
    }

    private emitWarning(warning: ContextWarning): void {
        const handler = this.warningOptions?.onWarning ?? console.warn;
        try {
            handler(warning);
        } catch (error) {
            console.error('Error in context warning handler:', error);
        }
    }
    
    setTotal(total: number): void {
        if (total < 0) {
            throw new Error('Progress total must be >= 0');
        }
        this.progressTotal = total;
        // Reset progress when total is set
        this.progressCompleted = 0;
        this.progressStartTime = Date.now();
        this.lastProgressEmitTime = 0;
        this.lastProgressPercentage = 0;
        this.progressRate = 0;
        // Emit initial progress (0%)
        this.emitProgress();
    }
    
    reportProgress(completed: number, current?: string): void {
        if (completed < 0) {
            throw new Error('Progress completed must be >= 0');
        }
        this.progressCompleted = Math.min(completed, this.progressTotal);
        this.emitProgress(current);
    }
    
    incrementProgress(current?: string): void {
        this.progressCompleted = Math.min(this.progressCompleted + 1, this.progressTotal);
        this.emitProgress(current);
    }
    
    private emitProgress(current?: string): void {
        if (!this.progressCallback || this.progressTotal === 0) {
            return;
        }
        
        const now = Date.now();
        const elapsedTime = now - this.progressStartTime;
        const percentage = this.progressTotal > 0 
            ? Math.round((this.progressCompleted / this.progressTotal) * 100)
            : 0;
        
        // Determine if we should emit
        const isComplete = this.progressCompleted >= this.progressTotal;
        const isStart = this.progressCompleted === 0;
        const timeSinceLastEmit = now - this.lastProgressEmitTime;
        const shouldThrottle = timeSinceLastEmit < this.progressThrottle;
        const significantChange = Math.abs(percentage - this.lastProgressPercentage) >= 5;
        
        // Always emit on 0% or 100%, or if throttle passed, or significant change
        if (!isStart && !isComplete && shouldThrottle && !significantChange) {
            return;
        }
        
        // Calculate rate (items per second) with exponential smoothing
        const currentRate = elapsedTime > 0 ? (this.progressCompleted / (elapsedTime / 1000)) : 0;
        if (this.progressRate === 0) {
            this.progressRate = currentRate;
        } else {
            this.progressRate = 0.7 * this.progressRate + 0.3 * currentRate;
        }
        
        // Calculate ETA
        const remaining = this.progressTotal - this.progressCompleted;
        const estimatedTimeRemaining = this.progressRate > 0
            ? Math.round((remaining / this.progressRate) * 1000)
            : undefined;
        
        const progress: Progress = {
            completed: this.progressCompleted,
            total: this.progressTotal,
            percentage,
            ...(current !== undefined ? { current } : {}),
            ...(this.progressRate > 0 ? { rate: Math.round(this.progressRate * 100) / 100 } : {}),
            ...(estimatedTimeRemaining !== undefined ? { estimatedTimeRemaining } : {}),
            startTime: this.progressStartTime,
            elapsedTime
        };
        
        this.lastProgressEmitTime = now;
        this.lastProgressPercentage = percentage;
        
        // Fire callback (errors in callback are isolated)
        try {
            this.progressCallback(progress);
        } catch (error) {
            console.error('Error in progress callback:', error);
        }
    }
    
    getProgressState(): { completed: number; total: number } {
        return {
            completed: this.progressCompleted,
            total: this.progressTotal
        };
    }
}

type ActionResult<O> = {
    actionId: string;
    data: Promise<O>;
    eventLogged: Promise<void>;
    cancel: (reason?: string) => void;
    cancelled: boolean;
    cancelReason: string | undefined;
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
    /** Timeout configuration */
    private timeoutConfig?: TimeoutOptions;
    /** Whether this action uses abort signal (set by withAbortSignal wrapper) */
    private usesAbortSignal: boolean = false;
    /** Progress callback for all invocations */
    private progressCallback?: ProgressCallback;
    /** Progress throttle in milliseconds */
    private progressThrottle: number = 100;
    /** Track all active invocations for cancelAll support */
    private activeInvocations: Map<string, ActionResult<O>> = new Map();
    /** Default priority for all invocations (0-100) */
    private defaultPriority: number = PRIORITY_VALUES.normal;
    /** Context warning thresholds for this action */
    private contextWarningOptions: ContextWarningOptions | undefined;

    constructor(handler: (...args: I) => O | Promise<O>) {
        // Check if handler was wrapped with withContext
        if ((handler as any).__usesContext && (handler as any).__originalHandler) {
            this.usesContext = true;
            this.callbackHandler = (handler as any).__originalHandler;
        } 
        // Check if handler was wrapped with withAbortSignal
        else if ((handler as any).__usesAbortSignal && (handler as any).__originalHandler) {
            this.usesAbortSignal = true;
            this.callbackHandler = (handler as any).__originalHandler;
        }
        else {
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
     * Set default priority for all invocations of this action.
     * Higher priority executes first; FIFO ordering preserved within same priority.
     */
    setPriority(priority: Priority): ActionBuilder<I, O> {
        this.defaultPriority = normalizePriority(priority);
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
     * Configure timeout for executions
     * @param options Timeout duration in ms or configuration object
     */
    setTimeout(options: number | TimeoutOptions): ActionBuilder<I, O> {
        // Normalize to TimeoutOptions
        const config: TimeoutOptions = typeof options === 'number' 
            ? { duration: options } 
            : options;
        
        // Validate configuration
        if (config.duration <= 0) {
            throw new Error('Timeout duration must be positive');
        }
        
        this.timeoutConfig = config;
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
     * Register a callback to receive progress updates
     * @param callback Function to receive progress updates
     * @param options Progress options (throttle)
     */
    onProgress(callback: ProgressCallback, options?: ProgressOptions): ActionBuilder<I, O> {
        this.progressCallback = callback;
        if (options?.throttle !== undefined) {
            if (options.throttle < 0) {
                throw new Error('Progress throttle must be >= 0');
            }
            this.progressThrottle = options.throttle;
        }
        return this;
    }

    /**
     * Configure context warning thresholds for this action
     */
    setContextWarningThreshold(options?: ContextWarningOptions): ActionBuilder<I, O> {
        this.contextWarningOptions = options;
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
        priority: number,
        metadata: Record<string, unknown> | undefined,
        emitIntermediateEvents: boolean = false,
        signal?: AbortSignal
    ): Promise<{ result: O; retryAttempt: number; retryDelays: number[]; timedOut: boolean; executionTime: number | undefined }> {
        let result: O | undefined;
        let error: Error | undefined;
        const retryDelays: number[] = [];
        let attemptNumber = 0;
        const maxAttempts = (this.retryOptions?.maxRetries ?? 0) + 1;
        let timedOut = false;
        let executionTime: number | undefined;
        
        while (attemptNumber < maxAttempts) {
            // Check for cancellation before each attempt
            if (signal?.aborted) {
                throw new CancellationError(
                    (signal.reason as string) || 'Task was cancelled',
                    attemptNumber === 0 ? 'queued' : 'running'
                );
            }
            
            const isRetry = attemptNumber > 0;
            const attemptStartTime = Date.now();
            
            try {
                // Execute with timeout if configured
                if (this.timeoutConfig) {
                    const timeoutDuration = this.timeoutConfig.duration;
                    const throwOnTimeout = this.timeoutConfig.throwOnTimeout !== false;
                    const useAbortSignal = this.timeoutConfig.abortSignal === true;
                    
                    if (useAbortSignal && this.usesAbortSignal) {
                        // Cooperative cancellation with AbortSignal
                        // Create a combined abort controller for timeout + external cancellation
                        const timeoutController = new AbortController();
                        
                        // Link external cancellation signal to timeout controller
                        if (signal) {
                            if (signal.aborted) {
                                throw new CancellationError(
                                    (signal.reason as string) || 'Task was cancelled',
                                    'running'
                                );
                            }
                            signal.addEventListener('abort', () => {
                                timeoutController.abort(signal.reason);
                            }, { once: true });
                        }
                        
                        const timeoutId = setTimeout(() => {
                            timeoutController.abort(new TimeoutError(timeoutDuration));
                        }, timeoutDuration);
                        
                        try {
                            result = await (this.callbackHandler as any)(timeoutController.signal, ...payload);
                            clearTimeout(timeoutId);
                        } catch (e) {
                            clearTimeout(timeoutId);
                            
                            // Check if it was cancelled vs timeout
                            if (signal?.aborted) {
                                throw new CancellationError(
                                    (signal.reason as string) || 'Task was cancelled',
                                    'running'
                                );
                            }
                            
                            if (timeoutController.signal.aborted || e instanceof TimeoutError) {
                                executionTime = Date.now() - attemptStartTime;
                                timedOut = true;
                                if (throwOnTimeout) {
                                    throw new TimeoutError(timeoutDuration);
                                }
                            } else {
                                throw e;
                            }
                        }
                    } else {
                        // Forced cancellation with Promise.race (timeout + cancellation + handler)
                        const timeoutPromise = new Promise<never>((_, reject) => {
                            setTimeout(() => {
                                reject(new TimeoutError(timeoutDuration));
                            }, timeoutDuration);
                        });
                        
                        const cancellationPromise = signal ? new Promise<never>((_, reject) => {
                            if (signal.aborted) {
                                reject(new CancellationError(
                                    (signal.reason as string) || 'Task was cancelled',
                                    'running'
                                ));
                                return;
                            }
                            signal.addEventListener('abort', () => {
                                reject(new CancellationError(
                                    (signal.reason as string) || 'Task was cancelled',
                                    'running'
                                ));
                            }, { once: true });
                        }) : new Promise<never>(() => {}); // Never resolves if no signal
                        
                        let handlerPromise: Promise<O>;
                        if (this.usesContext) {
                            handlerPromise = Promise.resolve((this.callbackHandler as any)(context, ...payload));
                        } else {
                            handlerPromise = Promise.resolve(this.callbackHandler(...payload));
                        }
                        
                        try {
                            result = await Promise.race([handlerPromise, timeoutPromise, cancellationPromise]);
                        } catch (e) {
                            if (e instanceof CancellationError) {
                                throw e;
                            } else if (e instanceof TimeoutError) {
                                executionTime = Date.now() - attemptStartTime;
                                timedOut = true;
                                if (throwOnTimeout) {
                                    throw e;
                                }
                            } else {
                                throw e;
                            }
                        }
                    }
                } else {
                    // No timeout configured, execute normally
                    // Check for external cancellation
                    if (signal) {
                        const cancellationPromise = new Promise<never>((_, reject) => {
                            if (signal.aborted) {
                                reject(new CancellationError(
                                    (signal.reason as string) || 'Task was cancelled',
                                    'running'
                                ));
                                return;
                            }
                            signal.addEventListener('abort', () => {
                                reject(new CancellationError(
                                    (signal.reason as string) || 'Task was cancelled',
                                    'running'
                                ));
                            }, { once: true });
                        });
                        
                        let handlerPromise: Promise<O>;
                        if (this.usesAbortSignal) {
                            handlerPromise = Promise.resolve((this.callbackHandler as any)(signal, ...payload));
                        } else if (this.usesContext) {
                            handlerPromise = Promise.resolve((this.callbackHandler as any)(context, ...payload));
                        } else {
                            handlerPromise = Promise.resolve(this.callbackHandler(...payload));
                        }
                        
                        try {
                            result = await Promise.race([handlerPromise, cancellationPromise]);
                        } catch (e) {
                            if (e instanceof CancellationError) {
                                throw e;
                            } else {
                                throw e;
                            }
                        }
                    } else {
                        // No signal, execute directly
                        if (this.usesAbortSignal) {
                            // Create a dummy signal that never aborts
                            const dummyController = new AbortController();
                            result = await (this.callbackHandler as any)(dummyController.signal, ...payload);
                        } else if (this.usesContext) {
                            result = await (this.callbackHandler as any)(context, ...payload);
                        } else {
                            result = await this.callbackHandler(...payload);
                        }
                    }
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
                        priority,
                        ...(metadata !== undefined ? { metadata } : {}),
                        error,
                        attachments: context.getAttachments(),
                        traceId: context.traceId,
                        ...(context.parent ? { parentActionId: context.parent.actionId } : {}),
                        depth: context.depth,
                        childActionIds: context.getChildActionIds(),
                        children: context.getChildEvents(),
                        childDuration: context.getChildDuration(),
                        selfDuration: Math.max(0, (completedAt - startedAt) - context.getChildDuration()),
                        retryAttempt: attemptNumber,
                        isRetry,
                        willRetry: shouldRetry,
                        retryDelays: [...retryDelays],
                        ...(this.timeoutConfig ? {
                            timeout: this.timeoutConfig.duration,
                            timedOut,
                            ...(executionTime !== undefined ? { executionTime } : {})
                        } : {})
                    };
                    
                    try {
                        await this.eventCallback(intermediateEvent);
                    } catch (callbackError) {
                        console.error('Error in event callback:', callbackError);
                    }
                }
                
                if (!shouldRetry) {
                    (error as any).__executionDetails = {
                        retryAttempt: attemptNumber,
                        retryDelays: [...retryDelays],
                        timedOut,
                        executionTime
                    };
                    throw error;
                }
                
                // Calculate and apply retry delay
                attemptNumber++;
                if (attemptNumber < maxAttempts) {
                    const delay = this.calculateRetryDelay(attemptNumber, this.retryOptions!);
                    retryDelays.push(delay);
                    
                    // Wait for delay with cancellation support
                    await new Promise<void>((resolve, reject) => {
                        const timeoutId = setTimeout(resolve, delay);
                        
                        // Listen for cancellation during retry delay
                        if (signal) {
                            const abortHandler = () => {
                                clearTimeout(timeoutId);
                                reject(new CancellationError(
                                    (signal.reason as string) || 'Task was cancelled',
                                    'retry-delay'
                                ));
                            };
                            
                            if (signal.aborted) {
                                clearTimeout(timeoutId);
                                reject(new CancellationError(
                                    (signal.reason as string) || 'Task was cancelled',
                                    'retry-delay'
                                ));
                                return;
                            }
                            
                            signal.addEventListener('abort', abortHandler, { once: true });
                        }
                    });
                }
            }
        }
        
        if (!error) {
            return { result: result as O, retryAttempt: attemptNumber, retryDelays, timedOut, executionTime };
        }
        
        throw error;
    }

    /**
     * Invoke the action with the given payload
     * Returns immediately with actionId and a promise for the result
     */
    invoke(...payload: [...I]): ActionResult<O>;
    invoke(...payloadAndOptions: [...I, InvokeOptions]): ActionResult<O>;
    invoke(...payloadAndMaybeOptions: [...I, InvokeOptions?]): ActionResult<O> {
        const lastArg = payloadAndMaybeOptions[payloadAndMaybeOptions.length - 1];
        const options = isInvokeOptions(lastArg) ? (lastArg as InvokeOptions) : undefined;
        const payload = (options
            ? payloadAndMaybeOptions.slice(0, -1)
            : payloadAndMaybeOptions) as unknown as I;

        const invocationMetadata = options?.metadata;
        const priority = normalizePriority(options?.priority ?? this.defaultPriority);

        const parentPropagationContext = getPropagationContext();
        const traceId = parentPropagationContext?.traceId ?? crypto.randomUUID();
        const depth = parentPropagationContext ? parentPropagationContext.depth + 1 : 0;
        const parentContext = parentPropagationContext ? buildParentContextSnapshot(parentPropagationContext) : undefined;
        const warningOptions = resolveContextWarningOptions(this.contextWarningOptions);

        const actionId = crypto.randomUUID();
        const startedAt = Date.now();

        const context = new InvocationContextImpl(
            actionId,
            this.progressCallback,
            this.progressThrottle,
            traceId,
            depth,
            parentContext,
            warningOptions
        );

        if (parentPropagationContext) {
            parentPropagationContext.invocationContext.registerChild(actionId);
        }

        const propagationContext: PropagationContext = {
            traceId,
            actionId,
            depth,
            parent: parentPropagationContext,
            invocationContext: context,
            parentContext: undefined
        };
        
        let eventLoggedResolve: () => void;
        let eventLoggedReject: (error: Error) => void;
        const eventLogged = new Promise<void>((resolve, reject) => {
            eventLoggedResolve = resolve;
            eventLoggedReject = reject;
        });
        
        let isCancelled = false;
        let cancellationReason: string | undefined;
        let cancellationState: 'queued' | 'running' | 'retry-delay' | undefined;

        const { promise: data, controller, task } = this.scheduler.schedule(
            actionId,
            async (signal) => {
                return await runWithPropagationContext(propagationContext, () =>
                    this.executeWithRetry(context, payload, actionId, startedAt, priority, invocationMetadata, true, signal)
                );
            },
            { priority }
        );
        
        // Add catch handler immediately to prevent unhandled rejections
        // This will be overridden by the explicit handlers below
        data.catch(() => {
            // Intentionally empty - errors handled below
        });

        // Attach handlers to emit the final wide event
        data.then(
            async (execResult) => {
                // Success path
                const completedAt = Date.now();
                const childDuration = context.getChildDuration();
                const wideEvent: WideEvent<I, O> = {
                    actionId,
                    startedAt,
                    completedAt,
                    duration: completedAt - startedAt,
                    input: payload,
                    priority,
                    ...(invocationMetadata !== undefined ? { metadata: invocationMetadata } : {}),
                    output: execResult.result,
                    attachments: context.getAttachments(),
                    traceId: context.traceId,
                    ...(context.parent ? { parentActionId: context.parent.actionId } : {}),
                    depth: context.depth,
                    childActionIds: context.getChildActionIds(),
                    children: context.getChildEvents(),
                    childDuration,
                    selfDuration: Math.max(0, (completedAt - startedAt) - childDuration),
                    retryAttempt: execResult.retryAttempt,
                    isRetry: execResult.retryAttempt > 0,
                    totalAttempts: execResult.retryAttempt + 1,
                    retryDelays: execResult.retryDelays,
                    ...(this.timeoutConfig ? {
                        timeout: this.timeoutConfig.duration,
                        timedOut: execResult.timedOut,
                        ...(execResult.executionTime !== undefined ? { executionTime: execResult.executionTime } : {})
                    } : {})
                };

                parentPropagationContext?.invocationContext.addChildEvent(wideEvent as WideEvent<any[], any>);

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
                // Error path - emit cancellation event if cancelled
                const completedAt = Date.now();
                const childDuration = context.getChildDuration();
                const executionDetails = (error as any).__executionDetails as {
                    retryAttempt?: number;
                    retryDelays?: number[];
                    timedOut?: boolean;
                    executionTime?: number;
                } | undefined;

                const wideEvent: WideEvent<I, O> = {
                    actionId,
                    startedAt,
                    completedAt,
                    duration: completedAt - startedAt,
                    input: payload,
                    priority,
                    ...(invocationMetadata !== undefined ? { metadata: invocationMetadata } : {}),
                    error,
                    attachments: context.getAttachments(),
                    traceId: context.traceId,
                    ...(context.parent ? { parentActionId: context.parent.actionId } : {}),
                    depth: context.depth,
                    childActionIds: context.getChildActionIds(),
                    children: context.getChildEvents(),
                    childDuration,
                    selfDuration: Math.max(0, (completedAt - startedAt) - childDuration),
                    ...(executionDetails?.retryAttempt !== undefined ? {
                        retryAttempt: executionDetails.retryAttempt,
                        isRetry: executionDetails.retryAttempt > 0,
                        retryDelays: executionDetails.retryDelays
                    } : {}),
                    ...(this.timeoutConfig ? {
                        timeout: this.timeoutConfig.duration,
                        ...(executionDetails?.timedOut !== undefined ? { timedOut: executionDetails.timedOut } : {}),
                        ...(executionDetails?.executionTime !== undefined ? { executionTime: executionDetails.executionTime } : {})
                    } : {}),
                    ...(error instanceof CancellationError ? {
                        cancelled: true,
                        ...(error.reason !== undefined ? { cancelReason: error.reason } : {}),
                        cancelledAt: error.state
                    } : {})
                };

                parentPropagationContext?.invocationContext.addChildEvent(wideEvent as WideEvent<any[], any>);

                if (error instanceof CancellationError) {
                    if (this.eventCallback) {
                        try {
                            await this.eventCallback(wideEvent);
                        } catch (callbackError) {
                            console.error('Error in event callback:', callbackError);
                        }
                    }
                }
                eventLoggedResolve!();
            }
        );
        
        // Create cancel function
        const cancel = (reason?: string) => {
            if (isCancelled) {
                return; // Already cancelled
            }
            
            // Try to cancel via scheduler first
            const wasCancelled = this.scheduler.cancel(actionId, reason);
            
            if (!wasCancelled) {
                // Task already completed or not found, no-op
                return;
            }
            
            // Only mark as cancelled if scheduler actually cancelled it
            isCancelled = true;
            cancellationReason = reason;
        };
        
        // Create the data promise that extracts just the result
        const dataPromise = data.then(r => r.result);
        // Add catch handler to prevent unhandled rejection - caller will handle errors
        dataPromise.catch(() => {});
        
        const handle: ActionResult<O> = {
            actionId,
            data: dataPromise,
            eventLogged,
            cancel,
            get cancelled() {
                return isCancelled || task.cancelled;
            },
            get cancelReason() {
                return cancellationReason || task.cancelReason;
            }
        };
        
        // Track invocation
        this.activeInvocations.set(actionId, handle);
        
        // Remove from tracking when complete
        data.finally(() => {
            this.activeInvocations.delete(actionId);
        });

        return handle;
    }

    /**
     * Batch invoke - Promise.all style
     * Waits for all invocations to complete and returns results in input order
     * Individual failures don't fail the whole batch
     */
    invokeAll(payloads: I[]): Promise<BatchResult<O>[]>;
    invokeAll(payloads: I[], options?: InvokeOptions): Promise<BatchResult<O>[]>;
    async invokeAll(payloads: I[], options?: InvokeOptions): Promise<BatchResult<O>[]> {
        if (payloads.length === 0) {
            return [];
        }

        const invocationMetadata = options?.metadata;
        const priority = normalizePriority(options?.priority ?? this.defaultPriority);

        const parentPropagationContext = getPropagationContext();
        const traceId = parentPropagationContext?.traceId ?? crypto.randomUUID();
        const depth = parentPropagationContext ? parentPropagationContext.depth + 1 : 0;
        const parentContext = parentPropagationContext ? buildParentContextSnapshot(parentPropagationContext) : undefined;
        const warningOptions = resolveContextWarningOptions(this.contextWarningOptions);
        const batchId = crypto.randomUUID();

        // Create a batch progress tracker if progress callback exists
        let batchCompletedCount = 0;
        const batchStartTime = Date.now();
        let lastBatchProgressEmitTime = 0;
        let lastBatchProgressPercentage = 0;
        let batchProgressRate = 0;
        
        const emitBatchProgress = () => {
            if (!this.progressCallback) {
                return;
            }
            
            const now = Date.now();
            const elapsedTime = now - batchStartTime;
            const percentage = Math.round((batchCompletedCount / payloads.length) * 100);
            
            // Throttle logic
            const isComplete = batchCompletedCount >= payloads.length;
            const isStart = batchCompletedCount === 0;
            const timeSinceLastEmit = now - lastBatchProgressEmitTime;
            const shouldThrottle = timeSinceLastEmit < this.progressThrottle;
            const significantChange = Math.abs(percentage - lastBatchProgressPercentage) >= 5;
            
            if (!isStart && !isComplete && shouldThrottle && !significantChange) {
                return;
            }
            
            // Calculate rate with exponential smoothing
            const currentRate = elapsedTime > 0 ? (batchCompletedCount / (elapsedTime / 1000)) : 0;
            if (batchProgressRate === 0) {
                batchProgressRate = currentRate;
            } else {
                batchProgressRate = 0.7 * batchProgressRate + 0.3 * currentRate;
            }
            
            const remaining = payloads.length - batchCompletedCount;
            const estimatedTimeRemaining = batchProgressRate > 0
                ? Math.round((remaining / batchProgressRate) * 1000)
                : undefined;
            
            const progress: Progress = {
                completed: batchCompletedCount,
                total: payloads.length,
                percentage,
                ...(batchProgressRate > 0 ? { rate: Math.round(batchProgressRate * 100) / 100 } : {}),
                ...(estimatedTimeRemaining !== undefined ? { estimatedTimeRemaining } : {}),
                startTime: batchStartTime,
                elapsedTime
            };
            
            lastBatchProgressEmitTime = now;
            lastBatchProgressPercentage = percentage;
            
            try {
                this.progressCallback(progress);
            } catch (error) {
                console.error('Error in progress callback:', error);
            }
        };
        
        // Emit initial progress (0%)
        if (this.progressCallback) {
            emitBatchProgress();
        }

        const tasks = payloads.map((payload, index) => {
            const actionId = crypto.randomUUID();
            const startedAt = Date.now();
            const context = new InvocationContextImpl(
                actionId,
                undefined,
                undefined,
                traceId,
                depth,
                parentContext,
                warningOptions
            );

            if (parentPropagationContext) {
                parentPropagationContext.invocationContext.registerChild(actionId);
            }

            const propagationContext: PropagationContext = {
                traceId,
                actionId,
                depth,
                parent: parentPropagationContext,
                invocationContext: context,
                parentContext: undefined
            };
            
            const { promise, controller } = this.scheduler.schedule(
                actionId,
                async (signal) => {
                return await runWithPropagationContext(propagationContext, async () => {
                    let result: O | undefined;
                    let error: Error | undefined;
                    let retryAttempt = 0;
                    let retryDelays: number[] = [];
                    let timedOut = false;
                    let executionTime: number | undefined;
                    
                    try {
                        const execResult = await this.executeWithRetry(context, payload, actionId, startedAt, priority, invocationMetadata, true, signal);
                        result = execResult.result;
                        retryAttempt = execResult.retryAttempt;
                        retryDelays = execResult.retryDelays;
                        timedOut = execResult.timedOut;
                        executionTime = execResult.executionTime;
                        return result;
                    } catch (e) {
                        error = e as Error;
                        throw e;
                    } finally {
                        // Update batch progress
                        batchCompletedCount++;
                        emitBatchProgress();
                        
                        // Emit final wide event
                        const completedAt = Date.now();
                        const childDuration = context.getChildDuration();
                        const wideEvent = {
                            actionId,
                            startedAt,
                            completedAt,
                            duration: completedAt - startedAt,
                            input: payload,
                            priority,
                            ...(invocationMetadata !== undefined ? { metadata: invocationMetadata } : {}),
                            output: result,
                            error,
                            attachments: context.getAttachments(),
                            traceId: context.traceId,
                            ...(context.parent ? { parentActionId: context.parent.actionId } : {}),
                            depth: context.depth,
                            childActionIds: context.getChildActionIds(),
                            children: context.getChildEvents(),
                            childDuration,
                            selfDuration: Math.max(0, (completedAt - startedAt) - childDuration),
                            batchId,
                            ...(retryDelays.length > 0 ? {
                                retryAttempt,
                                isRetry: retryAttempt > 0,
                                totalAttempts: retryAttempt + 1,
                                retryDelays
                            } : {}),
                            ...(this.timeoutConfig ? {
                                timeout: this.timeoutConfig.duration,
                                timedOut,
                                ...(executionTime !== undefined ? { executionTime } : {})
                            } : {}),
                            ...(error instanceof CancellationError ? {
                                cancelled: true,
                                cancelReason: error.reason,
                                cancelledAt: error.state
                            } : {})
                        } as WideEvent<I, O>;

                        parentPropagationContext?.invocationContext.addChildEvent(wideEvent as WideEvent<any[], any>);

                        if (this.eventCallback) {
                            try {
                                await this.eventCallback(wideEvent);
                            } catch (callbackError) {
                                console.error('Error in event callback:', callbackError);
                            }
                        }
                    }
                });
                },
                { priority }
            );
            
            return {
                actionId,
                index,
                startedAt,
                context,
                promise,
                controller
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
    invokeStream(payloads: I[]): AsyncGenerator<BatchResult<O>, void, unknown>;
    invokeStream(payloads: I[], options?: InvokeOptions): AsyncGenerator<BatchResult<O>, void, unknown>;
    async *invokeStream(payloads: I[], options?: InvokeOptions): AsyncGenerator<BatchResult<O>, void, unknown> {
        if (payloads.length === 0) {
            return;
        }

        const invocationMetadata = options?.metadata;
        const priority = normalizePriority(options?.priority ?? this.defaultPriority);

        const parentPropagationContext = getPropagationContext();
        const traceId = parentPropagationContext?.traceId ?? crypto.randomUUID();
        const depth = parentPropagationContext ? parentPropagationContext.depth + 1 : 0;
        const parentContext = parentPropagationContext ? buildParentContextSnapshot(parentPropagationContext) : undefined;
        const warningOptions = resolveContextWarningOptions(this.contextWarningOptions);
        const batchId = crypto.randomUUID();

        // Create a batch progress tracker if progress callback exists
        let batchCompletedCount = 0;
        const batchStartTime = Date.now();
        let lastBatchProgressEmitTime = 0;
        let lastBatchProgressPercentage = 0;
        let batchProgressRate = 0;
        
        const emitBatchProgress = () => {
            if (!this.progressCallback) {
                return;
            }
            
            const now = Date.now();
            const elapsedTime = now - batchStartTime;
            const percentage = Math.round((batchCompletedCount / payloads.length) * 100);
            
            // Throttle logic
            const isComplete = batchCompletedCount >= payloads.length;
            const isStart = batchCompletedCount === 0;
            const timeSinceLastEmit = now - lastBatchProgressEmitTime;
            const shouldThrottle = timeSinceLastEmit < this.progressThrottle;
            const significantChange = Math.abs(percentage - lastBatchProgressPercentage) >= 5;
            
            if (!isStart && !isComplete && shouldThrottle && !significantChange) {
                return;
            }
            
            // Calculate rate with exponential smoothing
            const currentRate = elapsedTime > 0 ? (batchCompletedCount / (elapsedTime / 1000)) : 0;
            if (batchProgressRate === 0) {
                batchProgressRate = currentRate;
            } else {
                batchProgressRate = 0.7 * batchProgressRate + 0.3 * currentRate;
            }
            
            const remaining = payloads.length - batchCompletedCount;
            const estimatedTimeRemaining = batchProgressRate > 0
                ? Math.round((remaining / batchProgressRate) * 1000)
                : undefined;
            
            const progress: Progress = {
                completed: batchCompletedCount,
                total: payloads.length,
                percentage,
                ...(batchProgressRate > 0 ? { rate: Math.round(batchProgressRate * 100) / 100 } : {}),
                ...(estimatedTimeRemaining !== undefined ? { estimatedTimeRemaining } : {}),
                startTime: batchStartTime,
                elapsedTime
            };
            
            lastBatchProgressEmitTime = now;
            lastBatchProgressPercentage = percentage;
            
            try {
                this.progressCallback(progress);
            } catch (error) {
                console.error('Error in progress callback:', error);
            }
        };
        
        // Emit initial progress (0%)
        if (this.progressCallback) {
            emitBatchProgress();
        }

        // Create all tasks with tracking info
        const pendingTasks = new Map<string, Promise<BatchResult<O>>>();
        
        for (let index = 0; index < payloads.length; index++) {
            const payload = payloads[index]!;
            const actionId = crypto.randomUUID();
            const startedAt = Date.now();
            const context = new InvocationContextImpl(
                actionId,
                undefined,
                undefined,
                traceId,
                depth,
                parentContext,
                warningOptions
            );

            if (parentPropagationContext) {
                parentPropagationContext.invocationContext.registerChild(actionId);
            }

            const propagationContext: PropagationContext = {
                traceId,
                actionId,
                depth,
                parent: parentPropagationContext,
                invocationContext: context,
                parentContext: undefined
            };
            
            const { promise } = this.scheduler.schedule(
                actionId,
                async (signal) => {
                return await runWithPropagationContext(propagationContext, async () => {
                    let result: O | undefined;
                    let error: Error | undefined;
                    let retryAttempt = 0;
                    let retryDelays: number[] = [];
                    let timedOut = false;
                    let executionTime: number | undefined;
                    
                    try {
                        const execResult = await this.executeWithRetry(context, payload, actionId, startedAt, priority, invocationMetadata, true, signal);
                        result = execResult.result;
                        retryAttempt = execResult.retryAttempt;
                        retryDelays = execResult.retryDelays;
                        timedOut = execResult.timedOut;
                        executionTime = execResult.executionTime;
                        return result;
                    } catch (e) {
                        error = e as Error;
                        throw e;
                    } finally {
                        // Update batch progress
                        batchCompletedCount++;
                        emitBatchProgress();
                        
                        // Emit final wide event
                        const completedAt = Date.now();
                        const childDuration = context.getChildDuration();
                        const wideEvent = {
                            actionId,
                            startedAt,
                            completedAt,
                            duration: completedAt - startedAt,
                            input: payload,
                            priority,
                            ...(invocationMetadata !== undefined ? { metadata: invocationMetadata } : {}),
                            output: result,
                            error,
                            attachments: context.getAttachments(),
                            traceId: context.traceId,
                            ...(context.parent ? { parentActionId: context.parent.actionId } : {}),
                            depth: context.depth,
                            childActionIds: context.getChildActionIds(),
                            children: context.getChildEvents(),
                            childDuration,
                            selfDuration: Math.max(0, (completedAt - startedAt) - childDuration),
                            batchId,
                            ...(retryDelays.length > 0 ? {
                                retryAttempt,
                                isRetry: retryAttempt > 0,
                                totalAttempts: retryAttempt + 1,
                                retryDelays
                            } : {}),
                            ...(this.timeoutConfig ? {
                                timeout: this.timeoutConfig.duration,
                                timedOut,
                                ...(executionTime !== undefined ? { executionTime } : {})
                            } : {}),
                            ...(error instanceof CancellationError ? {
                                cancelled: true,
                                cancelReason: error.reason,
                                cancelledAt: error.state
                            } : {})
                        } as WideEvent<I, O>;

                        parentPropagationContext?.invocationContext.addChildEvent(wideEvent as WideEvent<any[], any>);

                        if (this.eventCallback) {
                            try {
                                await this.eventCallback(wideEvent);
                            } catch (callbackError) {
                                console.error('Error in event callback:', callbackError);
                            }
                        }
                    }
                });
                },
                { priority }
            );
            
            const taskPromise = promise.then(
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
    
    /**
     * Cancel all active invocations of this action
     * @param reasonOrPredicate Reason string or predicate function to filter invocations
     */
    cancelAll(reasonOrPredicate?: string | ((invocation: ActionResult<O>) => boolean)): number {
        let count = 0;
        const invocations = Array.from(this.activeInvocations.values());
        
        for (const invocation of invocations) {
            if (typeof reasonOrPredicate === 'function') {
                if (reasonOrPredicate(invocation)) {
                    invocation.cancel('Cancelled by predicate');
                    count++;
                }
            } else {
                invocation.cancel(reasonOrPredicate);
                count++;
            }
        }
        
        return count;
    }
    
    /**
     * Cancel only queued (not running) invocations
     * @param reason Optional cancellation reason
     */
    clearQueue(reason?: string): number {
        return this.scheduler.clearQueue(reason);
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

/**
 * Wrapper function to enable AbortSignal for a handler
 * Returns a modified handler that can be used with createAction
 */
export function withAbortSignal<Args extends any[], Output>(
    handler: (signal: AbortSignal, ...args: Args) => Output | Promise<Output>
): ((...args: Args) => Output | Promise<Output>) & { __usesAbortSignal: true; __originalHandler: typeof handler } {
    // Return a wrapper that will be detected by ActionBuilder
    const wrapper = ((...args: Args) => {
        // This will never be called directly - ActionBuilder intercepts it
        throw new Error('withAbortSignal handler should not be called directly');
    }) as any;
    
    wrapper.__usesAbortSignal = true;
    wrapper.__originalHandler = handler;
    
    return wrapper;
}
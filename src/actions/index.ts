import { ExecutionScheduler } from "../scheduler/index.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { format } from "node:util";

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

/** Console methods that console capture records */
export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug' | 'trace';

/**
 * One captured console call
 */
export interface ConsoleLogEntry {
    level: ConsoleLevel;
    /** util.format(...args) at call time, truncated to the source invocation's maxMessageLength */
    message: string;
    /** Epoch ms */
    timestamp: number;
    /** Source invocation's retry attempt when logged (0 = original) */
    attempt: number;
    /** Source invocation: the action invocation that made the call (or owns the callback that did) */
    actionId: string;
    /** Present when message was cut to maxMessageLength */
    truncated?: true;
}

/**
 * Console capture configuration
 */
export interface ConsoleCaptureOptions {
    /** Still print captured calls to the terminal (default: true) */
    passthrough?: boolean;
    /** Max entries per contributing invocation in an event's logs; extras counted in logsDropped (default: 1000) */
    maxEntries?: number;
    /** Max message length in UTF-16 code units, applied where the call is made (default: 8192) */
    maxMessageLength?: number;
}

type ResolvedConsoleCapture = Required<ConsoleCaptureOptions> & { enabled: boolean };

const CONSOLE_CAPTURE_DEFAULTS: Required<ConsoleCaptureOptions> = {
    passthrough: true,
    maxEntries: 1000,
    maxMessageLength: 8192
};

/** undefined = default (capture on) */
let globalConsoleCapture: ConsoleCaptureOptions | false | undefined;

const validateConsoleCaptureOptions = (options: ConsoleCaptureOptions | false | undefined): void => {
    if (!options) {
        return;
    }
    if (options.maxEntries !== undefined && (!Number.isInteger(options.maxEntries) || options.maxEntries < 0)) {
        throw new Error('maxEntries must be an integer >= 0');
    }
    if (options.maxMessageLength !== undefined && (!Number.isInteger(options.maxMessageLength) || options.maxMessageLength < 1)) {
        throw new Error('maxMessageLength must be an integer >= 1');
    }
};

/**
 * Set the global console capture default. Capture is on unless set to false;
 * calling with no argument restores the default.
 */
export const setConsoleCapture = (options?: ConsoleCaptureOptions | false): void => {
    validateConsoleCaptureOptions(options);
    globalConsoleCapture = options;
};

/**
 * Resolve an invocation's console capture settings.
 * @param action The action's own setting
 * @param inherited The nearest capturing ancestor's resolved settings
 */
const resolveConsoleCaptureOptions = (
    action: ConsoleCaptureOptions | false | undefined,
    inherited: ResolvedConsoleCapture | undefined
): ResolvedConsoleCapture => {
    const actionOptions = action === false ? undefined : action;
    const globalOptions = globalConsoleCapture === false ? undefined : globalConsoleCapture;
    return {
        enabled: action !== false && (actionOptions !== undefined || inherited !== undefined || globalConsoleCapture !== false),
        passthrough: actionOptions?.passthrough ?? inherited?.passthrough ?? globalOptions?.passthrough ?? CONSOLE_CAPTURE_DEFAULTS.passthrough,
        maxEntries: actionOptions?.maxEntries ?? inherited?.maxEntries ?? globalOptions?.maxEntries ?? CONSOLE_CAPTURE_DEFAULTS.maxEntries,
        maxMessageLength: actionOptions?.maxMessageLength ?? inherited?.maxMessageLength ?? globalOptions?.maxMessageLength ?? CONSOLE_CAPTURE_DEFAULTS.maxMessageLength
    };
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

/** The attempt whose handler is running: its invocation and that attempt's signal */
interface AttemptScope {
    context: InvocationContextImpl;
    signal: AbortSignal;
}

/**
 * Entered around the handler of attempts that have their own signal (timeout configured), so a
 * timed-out attempt that keeps running still reads its own aborted signal after a retry starts.
 */
const attemptStore = new AsyncLocalStorage<AttemptScope>();

/**
 * Owner of console calls made inside a lifecycle callback: the invocation to attribute
 * them to, null to skip capture (library diagnostics), or undefined to use propagationStore.
 */
const captureOwnerStore = new AsyncLocalStorage<InvocationContextImpl | null | undefined>();

/** Report a throwing callback as a library diagnostic: never captured, console.error looked up at call time. */
const reportCallbackError = (diagnostic: string, error: unknown): void => {
    captureOwnerStore.run(null, () => console.error(diagnostic, error));
};

/**
 * Call a synchronous user lifecycle callback with its console output attributed to `owner`.
 * A throw is reported and `fallback` returned; it never propagates.
 */
const callLifecycleCallback = <T>(owner: InvocationContextImpl | null, diagnostic: string, fn: () => T, fallback: T): T => {
    try {
        return captureOwnerStore.run(owner, fn);
    } catch (error) {
        reportCallbackError(diagnostic, error);
        return fallback;
    }
};

/**
 * Await a user lifecycle callback with its console output attributed to `owner`.
 * A throw or rejection is reported; it never propagates.
 */
const callLifecycleCallbackAsync = async (
    owner: InvocationContextImpl,
    diagnostic: string,
    fn: () => void | Promise<void>
): Promise<void> => {
    try {
        await captureOwnerStore.run(owner, fn);
    } catch (error) {
        reportCallbackError(diagnostic, error);
    }
};

const runWithPropagationContext = <T>(context: PropagationContext, fn: () => T): T => {
    // Reset any callback owner so an action invoked from a callback attributes its own output.
    return captureOwnerStore.run(undefined, () => propagationStore.run(context, fn));
};

const CAPTURED_CONSOLE_LEVELS: readonly ConsoleLevel[] = ['log', 'info', 'warn', 'error', 'debug', 'trace'];
let consoleCaptureInstalled = false;
/** Set while forwarding to an original method, so its internal console calls (trace → error) are not recorded twice */
let forwardingConsole = false;

/**
 * Record a console call on its source invocation (the callback owner, or the innermost
 * invocation) and every capturing ancestor. The entry is formatted only if a buffer accepts it.
 * @returns whether the call should still reach the terminal
 */
const recordConsoleCall = (level: ConsoleLevel, args: unknown[]): boolean => {
    const owner = captureOwnerStore.getStore();
    const source = owner === undefined ? propagationStore.getStore()?.invocationContext : owner;
    if (!source || !source.hasCapturingLineage()) {
        return true;
    }
    let entry: ConsoleLogEntry | undefined;
    const getEntry = () => (entry ??= source.createConsoleEntry(level, args));
    for (let ctx: InvocationContextImpl | undefined = source; ctx; ctx = ctx.consoleParent) {
        ctx.appendConsoleEntry(source.actionId, getEntry);
    }
    return source.shouldPrintConsole();
};

/**
 * Patch the captured console methods once. Each wrapper records the call, then forwards
 * to the method that was installed at patch time.
 */
const installConsoleCapture = (): void => {
    if (consoleCaptureInstalled) {
        return;
    }
    consoleCaptureInstalled = true;
    for (const level of CAPTURED_CONSOLE_LEVELS) {
        const original = console[level];
        console[level] = function (...args: unknown[]): void {
            if (forwardingConsole) {
                original.apply(console, args);
                return;
            }
            if (recordConsoleCall(level, args)) {
                forwardingConsole = true;
                try {
                    original.apply(console, args);
                } finally {
                    forwardingConsole = false;
                }
            }
        };
    }
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
     * Aborted when the current attempt times out (reason: TimeoutError) or the invocation
     * is cancelled (reason: the cancel reason). Each retry attempt gets a fresh signal.
     */
    readonly signal: AbortSignal;
    
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

    /** Console output captured during this invocation (and copied from descendants); absent when capture is off for this action */
    logs?: ConsoleLogEntry[];

    /** Console entries dropped because a contributing invocation exceeded maxEntries (only present when > 0) */
    logsDropped?: number;
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
    private childIntervals: [number, number][] = [];

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

    // Console capture state
    readonly consoleParent: InvocationContextImpl | undefined;
    private consoleCapture: ResolvedConsoleCapture;
    private capturingLineage: boolean;
    private consoleLogs: ConsoleLogEntry[] = [];
    private consoleLogsDropped: number = 0;
    private consoleCountBySource: Map<string, number> = new Map();
    private consoleSealed: boolean = false;
    private attempt: number = 0;
    /** Current attempt's signal; set by executeWithRetry before the handler runs */
    private attemptSignal: AbortSignal | undefined;
    
    constructor(
        actionId: string,
        progressCallback: ProgressCallback | undefined,
        progressThrottle: number | undefined,
        traceId: string,
        depth: number,
        parent: ParentContext | undefined,
        warningOptions: ContextWarningOptions | undefined,
        consoleCapture: ResolvedConsoleCapture,
        consoleParent: InvocationContextImpl | undefined
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
        this.consoleCapture = consoleCapture;
        this.consoleParent = consoleParent;
        this.capturingLineage = consoleCapture.enabled || (consoleParent?.hasCapturingLineage() ?? false);
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
        if (typeof event.startedAt === 'number' && typeof event.completedAt === 'number') {
            this.childIntervals.push([event.startedAt, event.completedAt]);
        } else if (typeof event.duration === 'number') {
            const end = Date.now();
            this.childIntervals.push([end - event.duration, end]);
        }
    }

    getChildActionIds(): string[] {
        return [...this.childActionIds];
    }

    getChildEvents(): WideEvent<any[], any>[] {
        return [...this.childEvents];
    }

    /**
     * Wall-clock time during which at least one child was running (union of child
     * intervals), so parallel children are not double counted.
     */
    getChildDuration(): number {
        if (this.childIntervals.length === 0) {
            return 0;
        }
        const sorted = [...this.childIntervals].sort((a, b) => a[0] - b[0]);
        let total = 0;
        let [curStart, curEnd] = sorted[0]!;
        for (let i = 1; i < sorted.length; i++) {
            const [start, end] = sorted[i]!;
            if (start <= curEnd) {
                curEnd = Math.max(curEnd, end);
            } else {
                total += curEnd - curStart;
                curStart = start;
                curEnd = end;
            }
        }
        return total + (curEnd - curStart);
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
        callLifecycleCallback(this, 'Error in context warning handler:', () => handler(warning), undefined);
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
        callLifecycleCallback(this, 'Error in progress callback:', () => this.progressCallback!(progress), undefined);
    }
    
    getProgressState(): { completed: number; total: number } {
        return {
            completed: this.progressCompleted,
            total: this.progressTotal
        };
    }

    /** Resolved capture settings children inherit: own if capturing, else the nearest capturing ancestor's */
    getInheritableConsoleCapture(): ResolvedConsoleCapture | undefined {
        return this.consoleCapture.enabled
            ? this.consoleCapture
            : this.consoleParent?.getInheritableConsoleCapture();
    }

    /** True when this invocation or any ancestor captures console output */
    hasCapturingLineage(): boolean {
        return this.capturingLineage;
    }

    /** Whether a console call made by this invocation should still reach the terminal */
    shouldPrintConsole(): boolean {
        return !this.consoleCapture.enabled || this.consoleSealed || this.consoleCapture.passthrough;
    }

    createConsoleEntry(level: ConsoleLevel, args: unknown[]): ConsoleLogEntry {
        const formatted = format(...args);
        const maxLength = this.consoleCapture.maxMessageLength;
        const truncated = formatted.length > maxLength;
        return Object.freeze({
            level,
            // A plain slice() is a V8 sliced string that keeps the whole formatted message alive;
            // round-tripping through UTF-16 copies the code units so the original can be collected.
            message: truncated ? Buffer.from(formatted.slice(0, maxLength), 'utf16le').toString('utf16le') : formatted,
            timestamp: Date.now(),
            attempt: this.attempt,
            actionId: this.actionId,
            ...(truncated ? { truncated: true as const } : {})
        });
    }

    appendConsoleEntry(sourceActionId: string, getEntry: () => ConsoleLogEntry): void {
        if (!this.consoleCapture.enabled || this.consoleSealed) {
            return;
        }
        const count = this.consoleCountBySource.get(sourceActionId) ?? 0;
        if (count >= this.consoleCapture.maxEntries) {
            this.consoleLogsDropped++;
            return;
        }
        this.consoleLogs.push(getEntry());
        this.consoleCountBySource.set(sourceActionId, count + 1);
    }

    setAttempt(attempt: number): void {
        this.attempt = attempt;
    }

    /** The running attempt's signal when read from inside it; otherwise the latest attempt's */
    get signal(): AbortSignal {
        const scope = attemptStore.getStore();
        if (scope?.context === this) {
            return scope.signal;
        }
        if (!this.attemptSignal) {
            throw new Error('signal accessed before the first attempt');
        }
        return this.attemptSignal;
    }

    setAttemptSignal(signal: AbortSignal): void {
        this.attemptSignal = signal;
    }

    /** Seal the buffer (later calls skip it) and return the fields for the final event */
    finalizeConsole(): { logs?: ConsoleLogEntry[]; logsDropped?: number } {
        this.consoleSealed = true;
        return this.getConsoleLogFields();
    }

    getConsoleLogFields(): { logs?: ConsoleLogEntry[]; logsDropped?: number } {
        if (!this.consoleCapture.enabled) {
            return {};
        }
        return {
            logs: [...this.consoleLogs],
            ...(this.consoleLogsDropped > 0 ? { logsDropped: this.consoleLogsDropped } : {})
        };
    }
}

export type ActionResult<I extends any[], O> = {
    actionId: string;
    data: Promise<O>;
    /** Resolves to the error `data` rejects with, or undefined on success (never rejects) */
    error: Promise<Error | undefined>;
    /** Resolves to the invocation's final event once onEvent has run (onEvent errors are logged, never rejected) */
    event: Promise<WideEvent<I, O>>;
    cancel: (reason?: string) => void;
    cancelled: boolean;
    cancelReason: string | undefined;
}

/** One batch item's outcome; `event` is the item's final event (the one passed to onEvent) */
export type BatchResult<I extends any[], O> =
    | { actionId: string; index: number; data: O; error: undefined; event: WideEvent<I, O>; }
    | { actionId: string; index: number; data: undefined; error: Error; event: WideEvent<I, O>; }

/** Retry/timeout details of a run that reached a result or a terminal failure in executeWithRetry */
type ExecutionDetails = {
    retryAttempt: number;
    retryDelays: number[];
    timedOut: boolean;
    executionTime: number | undefined;
};

/** Read the details executeWithRetry attaches to a terminal failure; absent when the run never got that far */
const executionDetailsOf = (error: unknown): ExecutionDetails | undefined =>
    (error as { __executionDetails?: ExecutionDetails } | null)?.__executionDetails;

/** One invocation's identity and invoke options, shared by its retry events and its final event */
type InvocationRun<I extends any[]> = {
    context: InvocationContextImpl;
    payload: I;
    startedAt: number;
    priority: number;
    metadata: Record<string, unknown> | undefined;
    batchId: string | undefined;
};

// Utility type to infer parameters from a handler function
type InferInput<T> = T extends (...args: infer P) => any ? P : never;

// A batch item for invokeAll/invokeStream is the handler's single argument.
// Zero-arg handlers take `undefined` items; multi-arg handlers can't be batched.
type BatchItem<I extends any[]> =
    I extends [] ? undefined
    : I extends [infer A] ? A
    : I extends [(infer A)?] ? A | undefined
    : never;

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
    /** Retry configuration */
    private retryOptions?: RetryOptions;
    /** Timeout configuration */
    private timeoutConfig?: TimeoutOptions;
    /** Progress callback for all invocations */
    private progressCallback?: ProgressCallback;
    /** Progress throttle in milliseconds */
    private progressThrottle: number = 100;
    /** Track all active invocations for cancelAll support */
    private activeInvocations: Map<string, ActionResult<I, O>> = new Map();
    /** Default priority for all invocations (0-100) */
    private defaultPriority: number = PRIORITY_VALUES.normal;
    /** Context warning thresholds for this action */
    private contextWarningOptions: ContextWarningOptions | undefined;
    /** Console capture setting for this action (undefined = inherit/global default) */
    private consoleCaptureOptions: ConsoleCaptureOptions | false | undefined;

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
     * Configure console capture for this action (on by default globally).
     * Pass false to turn capture off for this action's own events.
     */
    captureConsole(options: ConsoleCaptureOptions | false = {}): ActionBuilder<I, O> {
        validateConsoleCaptureOptions(options);
        this.consoleCaptureOptions = options;
        return this;
    }

    /**
     * Resolve console capture for an invocation under the given parent, installing
     * the console patch the first time an invocation captures.
     */
    private resolveInvocationConsoleCapture(parent: PropagationContext | undefined): ResolvedConsoleCapture {
        const consoleCapture = resolveConsoleCaptureOptions(
            this.consoleCaptureOptions,
            parent?.invocationContext.getInheritableConsoleCapture()
        );
        if (consoleCapture.enabled) {
            installConsoleCapture();
        }
        return consoleCapture;
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
     * Execute handler with retry logic. Attempts that will be retried are delivered to onEvent here;
     * the terminal outcome is left to the caller's final event (see emitFinalEvent).
     */
    private async executeWithRetry(
        run: InvocationRun<I>,
        signal: AbortSignal
    ): Promise<ExecutionDetails & { result: O }> {
        const { context, payload } = run;
        let result: O | undefined;
        let error: Error | undefined;
        const retryDelays: number[] = [];
        let attemptNumber = 0;
        const maxAttempts = (this.retryOptions?.maxRetries ?? 0) + 1;
        let timedOut = false;
        let executionTime: number | undefined;
        
        while (attemptNumber < maxAttempts) {
            // Check for cancellation before each attempt
            if (signal.aborted) {
                throw new CancellationError(
                    (signal.reason as string) || 'Task was cancelled',
                    attemptNumber === 0 ? 'queued' : 'running'
                );
            }
            
            const isRetry = attemptNumber > 0;
            context.setAttempt(attemptNumber);
            const attemptStartTime = Date.now();

            try {
                result = await this.runAttempt(context, payload, signal);
                error = undefined;
                break;
            } catch (e) {
                // The attempt's own timeout rejects with the same TimeoutError that aborted ctx.signal
                if (e instanceof TimeoutError && context.signal.reason === e) {
                    executionTime = Date.now() - attemptStartTime;
                    timedOut = true;
                    if (this.timeoutConfig?.throwOnTimeout === false) {
                        result = undefined;
                        error = undefined;
                        break;
                    }
                }
                error = e as Error;
                const isLastAttempt = attemptNumber === maxAttempts - 1;
                
                // Determine if we should retry
                let shouldRetry = false;
                if (!isLastAttempt && this.retryOptions) {
                    if (this.retryOptions.shouldRetry) {
                        const predicate = this.retryOptions.shouldRetry;
                        const failure = error;
                        shouldRetry = callLifecycleCallback(context, 'Error in shouldRetry predicate:', () => predicate(failure), false);
                    } else {
                        shouldRetry = true;
                    }
                }
                
                const details: ExecutionDetails = {
                    retryAttempt: attemptNumber,
                    retryDelays: [...retryDelays],
                    timedOut,
                    executionTime
                };

                // Deliver the failed attempt that will be retried; a terminal failure gets the final event instead
                if (shouldRetry && this.eventCallback) {
                    const retryEvent: WideEvent<I, O> = {
                        ...this.buildEventBase(run),
                        error,
                        retryAttempt: attemptNumber,
                        isRetry,
                        willRetry: true,
                        retryDelays: details.retryDelays,
                        ...this.timeoutFields(details)
                    };

                    await callLifecycleCallbackAsync(context, 'Error in event callback:', () => this.eventCallback!(retryEvent));
                }
                
                if (!shouldRetry) {
                    Object.assign(error, { __executionDetails: details });
                    throw error;
                }
                
                // Calculate and apply retry delay
                attemptNumber++;
                if (attemptNumber < maxAttempts) {
                    const delay = this.calculateRetryDelay(attemptNumber, this.retryOptions!);
                    retryDelays.push(delay);
                    
                    // Wait for delay with cancellation support. The concurrency slot is released
                    // during the back-off, and a slot + rate-limit permit is re-acquired afterwards.
                    await this.scheduler.suspend(context.actionId, () => new Promise<void>((resolve, reject) => {
                        const timeoutId = setTimeout(() => {
                            signal.removeEventListener('abort', abortHandler);
                            resolve();
                        }, delay);
                        const abortHandler = () => {
                            clearTimeout(timeoutId);
                            reject(new CancellationError(
                                (signal.reason as string) || 'Task was cancelled',
                                'retry-delay'
                            ));
                        };
                        
                        // Listen for cancellation during retry delay
                        if (signal.aborted) {
                            abortHandler();
                            return;
                        }
                        signal.addEventListener('abort', abortHandler, { once: true });
                    }));
                }
            }
        }
        
        if (!error) {
            return { result: result as O, retryAttempt: attemptNumber, retryDelays, timedOut, executionTime };
        }
        
        throw error;
    }

    /**
     * Run one attempt: set ctx.signal, then settle with the handler, a cancellation, or the timeout,
     * whichever comes first. A timeout aborts ctx.signal with the same TimeoutError it rejects with.
     */
    private runAttempt(context: InvocationContextImpl, payload: I, signal: AbortSignal): Promise<O> {
        const cancelled = () => new CancellationError((signal.reason as string) || 'Task was cancelled', 'running');
        if (signal.aborted) {
            return Promise.reject(cancelled());
        }

        const timeout = this.timeoutConfig;
        const attempt = timeout ? new AbortController() : undefined;
        if (attempt) {
            // The link stays after the attempt, so a cancel also aborts earlier attempts' signals
            signal.addEventListener('abort', () => attempt.abort(signal.reason), { once: true });
        }
        context.setAttemptSignal(attempt?.signal ?? signal);

        let timerId: NodeJS.Timeout | undefined;
        let onAbort: () => void = () => {};
        return new Promise<O>((resolve, reject) => {
            onAbort = () => reject(cancelled());
            signal.addEventListener('abort', onAbort, { once: true });
            if (timeout && attempt) {
                timerId = setTimeout(() => {
                    const error = new TimeoutError(timeout.duration);
                    attempt.abort(error);
                    reject(error);
                }, timeout.duration);
            }
            // A handler that fails after a cancel reports the cancellation
            const fail = (e: unknown) => reject(signal.aborted ? cancelled() : e);
            try {
                const output = attempt
                    ? attemptStore.run({ context, signal: attempt.signal }, () => this.callbackHandler(...payload))
                    : this.callbackHandler(...payload);
                Promise.resolve(output).then(resolve, fail);
            } catch (e) {
                fail(e);
            }
        }).finally(() => {
            clearTimeout(timerId);
            signal.removeEventListener('abort', onAbort);
        });
    }

    /**
     * Invoke the action with the given payload
     * Returns immediately with actionId and a promise for the result
     */
    invoke(...payload: [...I]): ActionResult<I, O>;
    invoke(...payloadAndOptions: [...I, InvokeOptions]): ActionResult<I, O>;
    invoke(...payloadAndMaybeOptions: [...I, InvokeOptions?]): ActionResult<I, O> {
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
        const consoleCapture = this.resolveInvocationConsoleCapture(parentPropagationContext);

        const actionId = crypto.randomUUID();
        const startedAt = Date.now();

        const context = new InvocationContextImpl(
            actionId,
            this.progressCallback,
            this.progressThrottle,
            traceId,
            depth,
            parentContext,
            warningOptions,
            consoleCapture,
            parentPropagationContext?.invocationContext
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
        
        let isCancelled = false;
        let cancellationReason: string | undefined;
        let cancellationState: 'queued' | 'running' | 'retry-delay' | undefined;

        const run: InvocationRun<I> = { context, payload, startedAt, priority, metadata: invocationMetadata, batchId: undefined };
        const { promise: data, task } = this.scheduler.schedule(
            actionId,
            async (signal) => {
                return await runWithPropagationContext(propagationContext, () => this.executeWithRetry(run, signal));
            },
            { priority }
        );

        // One final event per invocation, on every outcome; never rejects
        const event = data.then(
            (execResult) => this.emitFinalEvent(run, { output: execResult.result }, execResult),
            (error: Error) => this.emitFinalEvent(run, { error }, executionDetailsOf(error))
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
        
        const handle: ActionResult<I, O> = {
            actionId,
            data: dataPromise,
            error: data.then(() => undefined, (error: Error) => error),
            event,
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
        // Use then(cleanup, cleanup): finally() would return a derived promise that
        // re-rejects with the action's error and surfaces as an unhandled rejection.
        const untrack = () => {
            this.activeInvocations.delete(actionId);
        };
        data.then(untrack, untrack);

        return handle;
    }

    /**
     * Batch invoke - Promise.all style
     * Waits for all invocations to complete and returns results in input order
     * Individual failures don't fail the whole batch
     * Each item is the handler's single argument: `invokeAll([a, b])` runs `handler(a)`, `handler(b)`
     */
    invokeAll(payloads: BatchItem<I>[]): Promise<BatchResult<I, O>[]>;
    invokeAll(payloads: BatchItem<I>[], options?: InvokeOptions): Promise<BatchResult<I, O>[]>;
    async invokeAll(payloads: BatchItem<I>[], options?: InvokeOptions): Promise<BatchResult<I, O>[]> {
        return Promise.all(this.startBatch(payloads, options));
    }

    /**
     * Batch invoke - Async iterator style
     * Yields results as they complete (not in input order)
     * Ideal for processing results as soon as they're available
     * Each item is the handler's single argument: `invokeStream([a, b])` runs `handler(a)`, `handler(b)`
     */
    invokeStream(payloads: BatchItem<I>[]): AsyncGenerator<BatchResult<I, O>, void, unknown>;
    invokeStream(payloads: BatchItem<I>[], options?: InvokeOptions): AsyncGenerator<BatchResult<I, O>, void, unknown>;
    async *invokeStream(payloads: BatchItem<I>[], options?: InvokeOptions): AsyncGenerator<BatchResult<I, O>, void, unknown> {
        const pending = new Map(this.startBatch(payloads, options).map((result, index) => [index, result]));
        while (pending.size > 0) {
            const result = await Promise.race(pending.values());
            pending.delete(result.index);
            yield result;
        }
    }

    /**
     * Schedule one invocation per batch item. Each promise settles (never rejects) with the item's
     * result and its final event, once onEvent has run.
     */
    private startBatch(payloads: BatchItem<I>[], options: InvokeOptions | undefined): Promise<BatchResult<I, O>>[] {
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
        const consoleCapture = this.resolveInvocationConsoleCapture(parentPropagationContext);
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
            
            callLifecycleCallback(parentPropagationContext?.invocationContext ?? null, 'Error in progress callback:', () => this.progressCallback!(progress), undefined);
        };
        
        // Emit initial progress (0%)
        emitBatchProgress();

        // Items that never ran deliver their final events one at a time, so clearing a large
        // queue (or shutting down) doesn't call onEvent for every item at once
        let unstartedDelivery: Promise<unknown> = Promise.resolve();

        return payloads.map((item, index) => {
            const payload = [item] as unknown as I;
            const actionId = crypto.randomUUID();
            const context = new InvocationContextImpl(
                actionId,
                undefined,
                undefined,
                traceId,
                depth,
                parentContext,
                warningOptions,
                consoleCapture,
                parentPropagationContext?.invocationContext
            );
            const run: InvocationRun<I> = { context, payload, startedAt: Date.now(), priority, metadata: invocationMetadata, batchId };

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
            
            // Set once the item has run. The scheduler can still reject a task that ran (cancelled
            // after its handler finished), so a rejection alone doesn't mean the item never ran.
            let ranEvent: WideEvent<I, O> | undefined;

            const { promise } = this.scheduler.schedule(
                actionId,
                (signal) => runWithPropagationContext(propagationContext, async () => {
                    let outcome: { output: O } | { error: Error };
                    let details: ExecutionDetails | undefined;
                    try {
                        const execResult = await this.executeWithRetry(run, signal);
                        outcome = { output: execResult.result };
                        details = execResult;
                    } catch (error) {
                        outcome = { error: error as Error };
                        details = executionDetailsOf(error);
                    }

                    batchCompletedCount++;
                    emitBatchProgress();

                    ranEvent = await this.emitFinalEvent(run, outcome, details);
                    if ('error' in outcome) {
                        throw outcome.error;
                    }
                    return { data: outcome.output, event: ranEvent };
                }),
                { priority }
            );

            return promise.then(
                ({ data, event }): BatchResult<I, O> => ({ actionId, index, data, error: undefined, event }),
                async (error: Error): Promise<BatchResult<I, O>> => {
                    let event = ranEvent;
                    if (!event) {
                        const delivery = unstartedDelivery.then(() => this.emitFinalEvent(run, { error }, undefined));
                        unstartedDelivery = delivery;
                        event = await delivery;
                    }
                    return { actionId, index, data: undefined, error, event };
                }
            );
        });
    }

    /** Fields every event of `run` shares, including a snapshot of its captured logs */
    private buildEventBase(run: InvocationRun<I>) {
        const { context, startedAt } = run;
        const completedAt = Date.now();
        const childDuration = context.getChildDuration();
        return {
            actionId: context.actionId,
            startedAt,
            completedAt,
            duration: completedAt - startedAt,
            input: run.payload,
            priority: run.priority,
            ...(run.metadata !== undefined ? { metadata: run.metadata } : {}),
            attachments: context.getAttachments(),
            ...context.getConsoleLogFields(),
            traceId: context.traceId,
            ...(context.parent ? { parentActionId: context.parent.actionId } : {}),
            depth: context.depth,
            childActionIds: context.getChildActionIds(),
            children: context.getChildEvents(),
            childDuration,
            selfDuration: Math.max(0, (completedAt - startedAt) - childDuration),
            ...(run.batchId !== undefined ? { batchId: run.batchId } : {})
        };
    }

    private timeoutFields(details: ExecutionDetails | undefined) {
        if (!this.timeoutConfig) {
            return {};
        }
        return {
            timeout: this.timeoutConfig.duration,
            ...(details ? { timedOut: details.timedOut } : {}),
            ...(details?.executionTime !== undefined ? { executionTime: details.executionTime } : {})
        };
    }

    /**
     * Build the invocation's one final event (sealing its console buffer), add it to the parent's
     * children and deliver it to onEvent. `details` is absent when the run never reached a result or
     * terminal failure (cancelled while queued or during a retry delay, scheduler shut down).
     */
    private async emitFinalEvent(
        run: InvocationRun<I>,
        outcome: { output: O } | { error: Error },
        details: ExecutionDetails | undefined
    ): Promise<WideEvent<I, O>> {
        run.context.finalizeConsole();
        const failed = 'error' in outcome;
        const error = failed ? outcome.error : undefined;
        const event: WideEvent<I, O> = {
            ...this.buildEventBase(run),
            ...(failed ? { error: outcome.error } : { output: outcome.output }),
            ...(details ? {
                retryAttempt: details.retryAttempt,
                isRetry: details.retryAttempt > 0,
                totalAttempts: details.retryAttempt + 1,
                retryDelays: details.retryDelays,
                ...(failed ? { willRetry: false } : {})
            } : {}),
            ...this.timeoutFields(details),
            ...(error instanceof CancellationError ? {
                cancelled: true,
                ...(error.reason !== undefined ? { cancelReason: error.reason } : {}),
                cancelledAt: error.state
            } : {})
        };

        run.context.consoleParent?.addChildEvent(event);

        if (this.eventCallback) {
            await callLifecycleCallbackAsync(run.context, 'Error in event callback:', () => this.eventCallback!(event));
        }
        return event;
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
    cancelAll(reasonOrPredicate?: string | ((invocation: ActionResult<I, O>) => boolean)): number {
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
 * The running invocation's context: call it from a handler or any function the handler calls
 * (sync or async). A nested action gets its own context, with `parent` linking to the caller.
 * Behavior inside lifecycle callbacks (onEvent, onProgress, shouldRetry) is unspecified.
 * @throws Error when called outside an action invocation
 */
export function getContext(): InvocationContext {
    const store = propagationStore.getStore();
    if (!store) {
        throw new Error('getContext() must be called during an action invocation (inside a handler or a function it calls)');
    }
    return store.invocationContext;
}
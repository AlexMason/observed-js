# Cancellation

## Purpose

Add the ability to cancel queued or in-flight tasks manually, enabling user-initiated cancellations, resource cleanup, and graceful shutdown scenarios. Cancellation provides external control over task execution beyond automatic timeout behavior.

## API Design

### Invocation-Level Cancellation

Each invocation returns a cancellable handle:

```typescript
const invocation = action.invoke(input);

// Cancel this specific invocation
invocation.cancel();

// Or cancel with reason
invocation.cancel("User navigated away");

// Check if cancelled
if (invocation.cancelled) {
  console.log("Already cancelled");
}

// Result handling
try {
  const result = await invocation.data;
} catch (error) {
  if (error instanceof CancellationError) {
    console.log("Task was cancelled:", error.reason);
  }
}
```

**Return type enhancement**:
```typescript
interface InvocationHandle<T> {
  actionId: string;
  data: Promise<T>;
  
  // New cancellation API
  cancel(reason?: string): void;
  cancelled: boolean;
  cancelReason?: string;
}
```

### Action-Level Cancellation

Cancel all pending/running invocations for an action:

```typescript
const action = createAction(handler);

// Multiple invocations
action.invoke(input1);
action.invoke(input2);
action.invoke(input3);

// Cancel all invocations of this action
action.cancelAll("Shutting down");

// Or cancel with filter
action.cancelAll((invocation) => {
  return invocation.metadata.priority === "low";
});
```

**New ActionBuilder methods**:
```typescript
class ActionBuilder<TInput, TOutput> {
  // ... existing methods
  
  cancelAll(reason?: string): void;
  cancelAll(predicate: (invocation: InvocationHandle<TOutput>) => boolean): void;
  
  clearQueue(): void;  // Cancel only queued (not running) invocations
}
```

### Scheduler-Level Cancellation

Cancel everything in the scheduler (for shutdown scenarios):

```typescript
// Cancel all tasks across all actions using this scheduler
scheduler.shutdown({ 
  mode: 'graceful',      // 'graceful' | 'immediate'
  timeout: 5000          // ms to wait for graceful shutdown
});

// Or drain queue (finish running, cancel queued)
scheduler.drain();
```

**New ExecutionScheduler methods**:
```typescript
class ExecutionScheduler {
  // ... existing methods
  
  shutdown(options?: ShutdownOptions): Promise<void>;
  drain(): Promise<void>;
  
  get queuedCount(): number;    // Number of queued tasks
  get runningCount(): number;   // Number of running tasks
}

interface ShutdownOptions {
  mode?: 'graceful' | 'immediate';  // default: 'graceful'
  timeout?: number;                  // default: 30000 (30s)
}
```

## Behavior Specifications

### Cancellation States

Tasks can be in one of these states:
1. **Queued**: Waiting in scheduler queue
2. **Running**: Currently executing handler
3. **Completed**: Handler finished (success/error)
4. **Cancelled**: Explicitly cancelled

```typescript
enum InvocationState {
  QUEUED = 'queued',
  RUNNING = 'running', 
  COMPLETED = 'completed',
  CANCELLED = 'cancelled'
}
```

### Queued Task Cancellation

When cancelling a queued task:
1. Remove from scheduler queue immediately
2. Reject the `data` promise with `CancellationError`
3. Fire cancellation event (if `onEvent()` registered)
4. Release queue slot (allow next task to proceed)

**Behavior**: Instant, no handler execution.

### Running Task Cancellation

When cancelling a running task:
1. Mark invocation as cancelled
2. Trigger AbortController (if handler supports it)
3. Wait for handler to complete or abort
4. Reject `data` promise with `CancellationError`
5. Fire cancellation event
6. Release concurrency slot

**Behavior**: 
- **Cooperative**: Handler receives abort signal, can cleanup gracefully
- **Non-cooperative**: Handler may continue running (JS limitation), but promise is rejected
- Concurrency slot released once handler completes or abort is processed

### CancellationError

```typescript
class CancellationError extends Error {
  name = 'CancellationError';
  reason?: string;
  state: 'queued' | 'running';  // State when cancelled
  
  constructor(reason?: string, state?: 'queued' | 'running') {
    super(reason || 'Task was cancelled');
    this.reason = reason;
    this.state = state || 'running';
  }
}
```

### Integration with AbortSignal

Cancellation uses AbortController under the hood:

```typescript
const action = createAction(
  withAbortSignal(async (signal, userId: string) => {
    // signal.aborted becomes true on cancel
    const response = await fetch(`/api/users/${userId}`, { signal });
    
    // Or check manually
    if (signal.aborted) {
      throw new CancellationError(signal.reason);
    }
    
    return response.json();
  })
);

const invocation = action.invoke("user123");

// Later...
invocation.cancel("User logged out");
// → signal.aborted = true
// → fetch() aborts
// → CancellationError thrown
```

**Key points**:
- If handler uses `withAbortSignal`, cancellation is cooperative
- If handler doesn't use signal, cancellation is forced (promise rejects but handler may continue)
- Signal is automatically created for every invocation (even without `withAbortSignal`)

### Integration with Retry

Cancellation during retry sequence:

```typescript
const action = createAction(handler)
  .setRetry({ maxRetries: 3, baseDelay: 1000 });

const invocation = action.invoke(input);

// Timeline:
// 0ms: Attempt 1 starts
// 500ms: Attempt 1 fails
// 500-1500ms: Retry delay
// 800ms: invocation.cancel() called
// → Delay is cancelled immediately
// → CancellationError thrown
// → No retry attempt 2
```

**Behavior**:
- Cancellation during handler execution → abort current attempt
- Cancellation during retry delay → cancel delay, no more retries
- `shouldRetry` is NOT checked for cancellations (cancellation overrides retry)

### Integration with Timeout

Timeout and cancellation are complementary:

```typescript
const action = createAction(handler).setTimeout(5000);
const invocation = action.invoke(input);

// Whichever happens first:
// - Manual cancel → CancellationError
// - Timeout → TimeoutError
```

**Priority**: Manual cancellation > Timeout > Completion

If cancelled while timeout timer is running:
1. Clear timeout timer
2. Throw CancellationError (not TimeoutError)
3. Fire cancellation event

### Integration with Batch Operations

Cancel entire batch or individual invocations:

```typescript
// invokeAll with cancellation
const invocations = action.invokeAll([input1, input2, input3]);

// Cancel specific invocation
invocations[1].cancel();

// Results:
// invocations[0].data → success/error
// invocations[1].data → CancellationError
// invocations[2].data → success/error
```

**invokeStream with cancellation**:
```typescript
const stream = action.invokeStream([input1, input2, input3]);

// Cancel remaining items
for await (const result of stream) {
  if (result.success && result.data.shouldStop) {
    // Cancel rest of batch
    stream.cancel();
    break;
  }
}
```

**New stream API**:
```typescript
interface BatchStream<T> extends AsyncIterableIterator<BatchResult<T>> {
  cancel(reason?: string): void;  // Cancel remaining items
  cancelled: boolean;
}
```

### Wide Event Logging

Cancellation events should provide full context:

```typescript
interface ActionEvent {
  // ... existing fields
  cancelled?: boolean;           // Whether invocation was cancelled
  cancelReason?: string;         // Reason provided to cancel()
  cancelledAt?: 'queued' | 'running' | 'retry-delay';  // State when cancelled
  partialResult?: unknown;       // Result if handler was partway through
}
```

**Event structure for cancellation**:
```typescript
{
  actionId: "abc123",
  timestamp: 1234567890,
  duration: 1523,              // Time until cancellation
  input: ["user123"],
  error: CancellationError,
  cancelled: true,
  cancelReason: "User navigated away",
  cancelledAt: "running",
  attachments: { /* context before cancellation */ }
}
```

**Important**: Attachments made via `ctx.attach()` before cancellation **are preserved**.

## Implementation Considerations

### AbortController per Invocation

Every invocation gets an AbortController:

```typescript
class Invocation<T> {
  actionId: string;
  data: Promise<T>;
  controller: AbortController;
  
  cancel(reason?: string): void {
    if (this.cancelled) return;
    
    this.controller.abort(new CancellationError(reason));
    this.cancelled = true;
    this.cancelReason = reason;
  }
  
  cancelled: boolean = false;
  cancelReason?: string;
}
```

### Queue Management

Scheduler must track invocations:

```typescript
class ExecutionScheduler {
  private queuedTasks: Map<string, Invocation<any>>;
  private runningTasks: Map<string, Invocation<any>>;
  
  cancel(actionId: string): void {
    // Remove from queue if queued
    const queued = this.queuedTasks.get(actionId);
    if (queued) {
      this.queuedTasks.delete(actionId);
      queued.cancel();
      return;
    }
    
    // Abort if running
    const running = this.runningTasks.get(actionId);
    if (running) {
      running.cancel();
    }
  }
}
```

### Memory Management

- AbortController garbage collected after invocation completes
- Cancelled tasks removed from queue immediately
- Running tasks cleaned up after handler completes/aborts
- No persistent references to cancelled invocations

### Graceful Shutdown

```typescript
async shutdown(options: ShutdownOptions): Promise<void> {
  const { mode = 'graceful', timeout = 30000 } = options;
  
  if (mode === 'immediate') {
    // Cancel everything immediately
    this.queuedTasks.forEach(inv => inv.cancel('Shutdown'));
    this.runningTasks.forEach(inv => inv.cancel('Shutdown'));
    return;
  }
  
  // Graceful: cancel queued, wait for running
  this.queuedTasks.forEach(inv => inv.cancel('Shutdown'));
  
  const runningPromises = Array.from(this.runningTasks.values()).map(inv => inv.data);
  
  // Race between running tasks completing and timeout
  await Promise.race([
    Promise.allSettled(runningPromises),
    delay(timeout).then(() => {
      // Force cancel after timeout
      this.runningTasks.forEach(inv => inv.cancel('Shutdown timeout'));
    })
  ]);
}
```

## Edge Cases

### Cancel Already Completed Task
```typescript
const invocation = action.invoke(input);
const result = await invocation.data;  // Completes

invocation.cancel();  // No-op, already completed
// Does not throw, does not fire event
```

**Behavior**: Idempotent, no effect if already completed.

### Cancel Already Cancelled Task
```typescript
invocation.cancel("Reason 1");
invocation.cancel("Reason 2");  // No-op

console.log(invocation.cancelReason);  // "Reason 1" (first reason kept)
```

**Behavior**: Idempotent, first cancel wins.

### Cancel During Event Callback
```typescript
const action = createAction(handler).onEvent((event) => {
  // Event callback runs after completion
  // Cancel here has no effect on current invocation
});
```

**Behavior**: No effect, event callbacks run after invocation completes.

### CancelAll During Batch
```typescript
const action = createAction(handler);

const batch = action.invokeAll([1, 2, 3, 4, 5]);

// Cancel all while batch is running
action.cancelAll();

// batch results will include CancellationErrors for remaining items
```

**Behavior**: Cancels queued items, aborts running items, completed items unaffected.

### Cancellation in Nested Actions
```typescript
const actionA = createAction(async (input) => {
  const invocationB = actionB.invoke(input);
  return invocationB.data;  // Wait for nested action
});

const invocation = actionA.invoke(input);
invocation.cancel();  // Only cancels actionA, not actionB
```

**Behavior**: Cancellation is scoped to single invocation, doesn't propagate to nested actions automatically. User must cancel nested invocations manually if needed.

## Testing Strategy

### Unit Tests
- ✅ Cancel queued task → removed from queue, CancellationError thrown
- ✅ Cancel running task → abort triggered, CancellationError thrown
- ✅ Cancel during retry delay → delay cancelled, no more retries
- ✅ Cancel completed task → no-op, idempotent
- ✅ Cancel already cancelled → idempotent, first reason kept
- ✅ Cancellation event fired with metadata
- ✅ Attachments preserved in cancellation event
- ✅ AbortSignal integration → signal.aborted = true
- ✅ Batch cancellation → individual items cancelled
- ✅ Stream cancellation → remaining items cancelled

### Integration Tests
- ✅ Cancellation + concurrency → slot released immediately
- ✅ Cancellation + rate limiting → rate limit unaffected
- ✅ Cancellation + timeout → cancel takes priority
- ✅ Cancellation + retry → stops retry sequence
- ✅ action.cancelAll() → cancels all invocations
- ✅ scheduler.shutdown() graceful → waits for running tasks
- ✅ scheduler.shutdown() immediate → cancels everything

## Examples

### Basic Cancellation
```typescript
const action = createAction(async (query: string) => {
  return await searchDatabase(query);
});

const invocation = action.invoke("slow query");

// User clicks cancel button
document.getElementById('cancel').addEventListener('click', () => {
  invocation.cancel("User cancelled");
});

try {
  const results = await invocation.data;
} catch (error) {
  if (error instanceof CancellationError) {
    console.log("Search cancelled:", error.reason);
  }
}
```

### Cancellation with AbortSignal
```typescript
const action = createAction(
  withAbortSignal(async (signal, url: string) => {
    const response = await fetch(url, { signal });
    return response.json();
  })
);

const invocation = action.invoke("https://api.example.com/data");

// Cancel after 2 seconds
setTimeout(() => invocation.cancel("Taking too long"), 2000);
```

### Cancel Low Priority Tasks
```typescript
const action = createAction(handler)
  .setConcurrency(5)
  .attachMetadata({ priority: 'low' });  // Custom metadata

// Under load, cancel low priority tasks
if (serverLoad > 0.8) {
  action.cancelAll("Server overloaded");
}
```

### Graceful Shutdown
```typescript
// Application shutdown handler
process.on('SIGTERM', async () => {
  console.log("Shutting down gracefully...");
  
  await scheduler.shutdown({ 
    mode: 'graceful',
    timeout: 10000  // Wait 10s for tasks to complete
  });
  
  console.log("All tasks completed or cancelled");
  process.exit(0);
});
```

### Cancel Stream on Condition
```typescript
const stream = action.invokeStream(urls);

for await (const result of stream) {
  if (result.success) {
    console.log("Processed:", result.data);
    
    if (result.data.contains("STOP")) {
      stream.cancel("Stop condition met");
      break;
    }
  }
}
```

### Nested Cancellation
```typescript
const fetchUser = createAction(
  withAbortSignal(async (signal, userId) => {
    return await fetch(`/api/users/${userId}`, { signal });
  })
);

const enrichUser = createAction(
  withAbortSignal(async (signal, userId) => {
    const user = await fetchUser.invoke(userId).data;
    
    // Propagate cancellation to nested fetch
    signal.addEventListener('abort', () => {
      // Could cancel nested operations here if needed
    });
    
    const enriched = await enrichData(user, { signal });
    return enriched;
  })
);

const invocation = enrichUser.invoke("user123");

// Cancels enrichUser, but fetchUser may already be running
invocation.cancel();
```

## Open Questions

1. **Should cancellation propagate to nested actions automatically?**
   Currently it doesn't. Could track parent-child relationships and cascade cancellations.
   
   **Recommendation**: Start without auto-propagation (simpler), add if needed.

2. **Should we provide cancellation tokens?**
   ```typescript
   const token = action.createCancellationToken();
   action.invoke(input, { cancelToken: token });
   action.invoke(input2, { cancelToken: token });
   
   token.cancel();  // Cancels both
   ```
   Useful for grouping related invocations.
   
   **Recommendation**: Future enhancement, not MVP.

3. **Should cancellation fire intermediate event before completion?**
   Currently fires one event when cancellation completes. Could fire immediate event when cancel() called.
   
   **Recommendation**: Single event is simpler, cancellation is usually fast.

4. **Should batch operations return handle with cancel()?**
   ```typescript
   const batch = action.invokeAll([...]);
   batch.cancel();  // Cancel entire batch
   ```
   
   **Recommendation**: Yes, add to stream API (already designed above), consider for invokeAll.

## Migration Path

Adding cancellation is opt-in:
- Existing code continues working (no breaking changes)
- InvocationHandle gains new methods (non-breaking addition)
- Handlers without AbortSignal support still work (forced cancellation)
- New tests added alongside existing suites

## Future Enhancements

1. **Cancellation tokens**: Group multiple invocations for batch cancellation
2. **Cancellation propagation**: Automatic parent-child cancellation chains
3. **Cancellation hooks**: Callbacks for cleanup on cancellation
4. **Cancellation deadlines**: Automatically cancel after timestamp
5. **Cancellation priorities**: High-priority cancellations preempt others

## Design Principles Alignment

✅ **Safe defaults**: Tasks run to completion unless explicitly cancelled  
✅ **Composability**: Works with retry, timeout, concurrency, rate limiting  
✅ **Type safety**: CancellationError is typed, state tracked  
✅ **Observability first**: Rich cancellation metadata in events  
✅ **Error isolation**: Cancellations don't break queue or other tasks  
✅ **Progressive enhancement**: Opt-in feature, handlers can support AbortSignal  

This design enables critical control flow patterns while maintaining the library's core philosophy of safe, observable, composable async execution.

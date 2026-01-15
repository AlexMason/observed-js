# Timeouts

## Purpose

Add timeout capabilities to action handlers to prevent tasks from running indefinitely. This ensures resource cleanup, enforces SLAs, and prevents cascading failures when downstream services hang. Timeouts are essential for production reliability and resource management.

## API Design

### Builder Method

```typescript
const action = createAction(handler)
  .setTimeout(5000);  // milliseconds

// Or with more configuration
const action = createAction(handler)
  .setTimeout({
    duration: 5000,
    throwOnTimeout: true,    // default: true
    abortSignal: true         // default: false (provide AbortSignal to handler)
  });
```

**Name rationale**: `setTimeout` follows the established pattern of `setConcurrency`, `setRateLimit`, and `setRetry`. Simple duration number for common case, object for advanced config.

### Configuration Options

```typescript
interface TimeoutOptions {
  duration: number;              // Timeout in milliseconds
  throwOnTimeout?: boolean;      // Whether to throw TimeoutError (default: true)
  abortSignal?: boolean;         // Whether to provide AbortSignal to handler (default: false)
}

class TimeoutError extends Error {
  name = 'TimeoutError';
  duration: number;
  
  constructor(duration: number) {
    super(`Operation timed out after ${duration}ms`);
    this.duration = duration;
  }
}
```

### Handler Integration

**Option 1: Transparent timeout (default)**
```typescript
// Handler doesn't know about timeout
const action = createAction(async (userId: string) => {
  return await slowOperation(userId);  // Will be killed if exceeds timeout
}).setTimeout(5000);
```

**Option 2: AbortSignal integration**
```typescript
// Handler receives AbortSignal for cooperative cancellation
const action = createAction(
  withAbortSignal(async (signal, userId: string) => {
    const response = await fetch(`/api/users/${userId}`, { signal });
    return response.json();
  })
).setTimeout({ duration: 5000, abortSignal: true });
```

**Name rationale**: `withAbortSignal` is similar to `withContext` — it's a wrapper that adds abort signal as first parameter.

## Behavior Specifications

### Timeout Mechanics

1. **Timer starts** when handler begins execution (not when queued)
2. **Timer ends** when handler completes or timeout is reached
3. **Promise rejection** occurs if timeout is reached first
4. **Cleanup** happens immediately on timeout (handler may still be running)

### Timeout vs. Completion Race

```typescript
// Whichever completes first wins
const result = await Promise.race([
  handlerPromise,
  timeoutPromise
]);
```

If handler completes first: return result  
If timeout occurs first: throw `TimeoutError`

### Integration with Retry

Timeouts and retries work together naturally:

```typescript
const action = createAction(handler)
  .setTimeout(5000)           // Each attempt has 5s timeout
  .setRetry({
    maxRetries: 3,
    backoff: 'exponential',
    shouldRetry: (error) => {
      // Retry on timeouts
      return error instanceof TimeoutError;
    }
  });
```

**Behavior**:
- Each retry attempt gets a fresh timeout timer
- Timeout errors can trigger retries (if `shouldRetry` allows)
- Total execution time = (timeout × totalAttempts) + retry delays
- Retry delays do NOT count toward timeout (timeout is per-attempt)

### Integration with Scheduler

- Timeout is **per-invocation**, not per-queue-slot
- Concurrency slot is held during timeout
- After timeout, slot is released immediately
- Rate limit timestamp is recorded at execution start (not timeout)

### Integration with Cancellation

Timeouts and cancellation are complementary:
- **Timeout**: Automatic time-based cancellation
- **Cancellation**: Manual/external cancellation trigger
- Both use same underlying abort mechanism
- If both configured, whichever occurs first wins

### Wide Event Logging

Timeout metadata should be captured in events:

```typescript
interface ActionEvent {
  // ... existing fields
  timeout?: number;           // Configured timeout duration (ms)
  timedOut?: boolean;         // Whether this invocation timed out
  executionTime?: number;     // Actual execution time before timeout
}
```

**Event structure for timeout**:
```typescript
{
  actionId: "abc123",
  timestamp: 1234567890,
  duration: 5001,              // Slightly over timeout due to cleanup
  input: ["user123"],
  error: TimeoutError,
  timeout: 5000,
  timedOut: true,
  executionTime: 5000,
  attachments: { /* partial context before timeout */ }
}
```

**Important**: Attachments made via `ctx.attach()` before timeout **are preserved** in the timeout event.

## Implementation Considerations

### Cooperative vs. Forced Cancellation

**Forced cancellation** (default):
- Handler cannot prevent timeout
- Promise is rejected immediately
- Handler may continue running in background (JS limitation)
- Use for uncooperative code

**Cooperative cancellation** (with AbortSignal):
- Handler checks `signal.aborted` or listens to `signal.addEventListener('abort', ...)`
- Handler can cleanup resources properly
- More graceful, but requires handler cooperation
- Use for HTTP requests, async operations that support signals

### AbortController Implementation

```typescript
const controller = new AbortController();
const signal = controller.signal;

// Start timeout timer
const timeoutId = setTimeout(() => {
  controller.abort(new TimeoutError(duration));
}, duration);

try {
  // Handler receives signal
  const result = await handler(signal, ...args);
  clearTimeout(timeoutId);
  return result;
} catch (error) {
  clearTimeout(timeoutId);
  if (error instanceof TimeoutError || signal.aborted) {
    throw new TimeoutError(duration);
  }
  throw error;
}
```

### Memory Management

- Clear timeout timer on completion to prevent memory leaks
- AbortController is garbage collected after invocation completes
- No persistent references to timed-out handlers

## Edge Cases

### Timeout of 0
```typescript
.setTimeout(0)  // Throws error: "Timeout duration must be positive"
```

Validation error thrown at configuration time.

### Very Long Timeouts
```typescript
.setTimeout(Number.MAX_SAFE_INTEGER)  // Valid but effectively infinite
```

No upper bound validation — user's responsibility.

### Timeout During Retry Delay
Timeout does NOT apply during retry delays:
```typescript
const action = createAction(handler)
  .setTimeout(1000)
  .setRetry({ maxRetries: 3, baseDelay: 5000 });

// Timeline:
// 0ms: Start attempt 1 (timeout starts)
// 500ms: Attempt 1 fails
// 500ms-5500ms: Retry delay (timeout does NOT apply)
// 5500ms: Start attempt 2 (fresh timeout starts)
```

Retry delays are NOT execution time, so timeout timer is paused.

### Timeout in Batch Operations

Each invocation in a batch gets its own timeout:
```typescript
const results = await action.invokeAll([input1, input2, input3]);
// input1 times out → result[0] has TimeoutError
// input2 succeeds → result[1] has data
// input3 times out → result[2] has TimeoutError
```

Individual timeouts don't cancel the batch.

### Interaction with Event Callbacks

`.onEvent()` callbacks are NOT subject to timeout:
```typescript
const action = createAction(handler)
  .setTimeout(1000)
  .onEvent(async (event) => {
    await slowLogging(event);  // Can take longer than 1000ms, no timeout
  });
```

Event callbacks run after invocation completes, so timeout doesn't apply.

## Testing Strategy

### Unit Tests
- ✅ Handler completes before timeout → returns result
- ✅ Handler exceeds timeout → throws TimeoutError
- ✅ Timeout metadata in events (timeout, timedOut, executionTime)
- ✅ Attachments preserved in timeout events
- ✅ Timeout with retry → each attempt gets fresh timeout
- ✅ Timeout in batch operations → individual results
- ✅ AbortSignal provided when enabled
- ✅ Validation: negative/zero timeout throws

### Integration Tests
- ✅ Timeout + concurrency → slots released on timeout
- ✅ Timeout + rate limiting → rate limit timestamp at start
- ✅ Timeout + retry + shouldRetry → timeout errors retried if allowed
- ✅ Timeout during retry delay → delay not counted

## Examples

### Basic Timeout
```typescript
const action = createAction(async (url: string) => {
  return await fetch(url).then(r => r.json());
}).setTimeout(5000);

try {
  const data = await action.invoke("https://slow-api.com/data").data;
} catch (error) {
  if (error instanceof TimeoutError) {
    console.log("Request timed out after 5s");
  }
}
```

### Timeout with Retry
```typescript
const action = createAction(apiCall)
  .setTimeout(3000)
  .setRetry({
    maxRetries: 3,
    backoff: 'exponential',
    shouldRetry: (error) => error instanceof TimeoutError
  });

// Will retry up to 3 times if timeout occurs
// Each retry gets a fresh 3s timeout
```

### Cooperative Timeout with AbortSignal
```typescript
const action = createAction(
  withAbortSignal(async (signal, userId: string) => {
    const response = await fetch(`/api/users/${userId}`, { signal });
    
    // Can also check signal manually
    if (signal.aborted) {
      throw new Error("Aborted");
    }
    
    return response.json();
  })
).setTimeout({ duration: 5000, abortSignal: true });
```

### Database Query with Timeout
```typescript
const queryAction = createAction(
  withContext(async (ctx, query: string) => {
    ctx.attach("query", query);
    
    const result = await db.execute(query);
    ctx.attach("rowCount", result.rows.length);
    
    return result;
  })
)
.setTimeout(10000)  // 10s max for any query
.setConcurrency(10);  // Connection pool size

// If query times out, attachments still captured in event
```

## Open Questions

1. **Should timeout be configurable per-invocation?**
   ```typescript
   action.invoke(input, { timeout: 2000 });  // Override default
   ```
   Potentially useful, but adds complexity. Could be follow-up feature.

2. **Should we provide timeout remaining to handler?**
   ```typescript
   withTimeout(async (timeoutRemaining, input) => {
     // Handler can check how much time is left
   })
   ```
   Nice-to-have for long operations that want to short-circuit.

3. **Should timeout fire intermediate event?**
   Currently timeout fires one final event (with timeout metadata). Could fire intermediate event when timeout starts, similar to retry.
   
   Probably not needed — timeout is instant, not progressive like retry.

## Migration Path

Adding `.setTimeout()` is completely opt-in:
- Existing actions without timeout continue working
- No breaking changes to API
- Timeout defaults to infinity (no timeout) if not configured
- New tests added alongside existing test suites

## Future Enhancements

1. **Adaptive timeouts**: Adjust timeout based on P95 latency
2. **Timeout policies**: Different timeouts for different error states
3. **Timeout budgets**: Distributed timeout across retry attempts
4. **Deadline propagation**: Accept upstream deadline and propagate downstream

## Design Principles Alignment

✅ **Safe defaults**: No timeout by default (infinite time)  
✅ **Composability**: Works seamlessly with retry, concurrency, rate limiting  
✅ **Type safety**: `TimeoutError` is typed, options validated  
✅ **Observability first**: Rich timeout metadata in events  
✅ **Error isolation**: Timeouts don't break queue or other tasks  
✅ **Progressive enhancement**: Opt-in feature, no breaking changes  

This design maintains the library's philosophy while adding critical production-ready timeout capabilities.

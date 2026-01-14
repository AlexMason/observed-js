# Retry with Backoff

## Purpose

Add retry logic to action handlers when errors occur, with configurable backoff strategies (linear/exponential), jitter, and max retry attempts. This enables fault-tolerant execution patterns for transient failures.

## API Design

### Builder Method

```typescript
const action = createAction(handler)
  .setRetry({
    maxRetries: 3,
    backoff: 'exponential',
    baseDelay: 100,      // milliseconds
    maxDelay: 10000,     // cap for exponential growth
    jitter: true         // add randomness to prevent thundering herd
  });
```

**Name rationale**: `setRetry` follows the established pattern of `setConcurrency` and `setRateLimit`.

### Configuration Options

```typescript
interface RetryOptions {
  maxRetries: number;        // Number of retry attempts (0 = no retries)
  backoff: 'linear' | 'exponential';
  baseDelay?: number;        // Base delay in ms (default: 100)
  maxDelay?: number;         // Maximum delay cap in ms (default: 30000)
  jitter?: boolean;          // Add randomness to delay (default: false)
  shouldRetry?: (error: unknown) => boolean;  // Predicate to determine if error is retryable
}
```

### Backoff Calculations

**Linear backoff**:
```
delay = baseDelay * attemptNumber
```

**Exponential backoff**:
```
delay = min(baseDelay * 2^attemptNumber, maxDelay)
```

**Jitter** (when enabled):
```
delay = delay * (0.5 + random(0, 0.5))  // 50-100% of calculated delay
```

## Behavior Specifications

### Retry Attempts
- Attempt 0 = original execution
- Attempts 1-N = retries (up to `maxRetries`)
- Total executions = 1 + maxRetries

### Failure Conditions
- If all retries exhausted, throw the **last error** encountered
- Each retry gets a fresh execution context
- Delay occurs **before** each retry attempt (not after failure)

### Integration with Scheduler
- Retries happen **within** a single scheduled task slot
- One invocation = one queue slot, regardless of retry count
- **Retry delays count toward rate limiting** — the concurrency slot remains occupied during delays
- Concurrency slot is held for the entire retry sequence (including delays)
- This means a retry with long delays will block other tasks from using that concurrency slot

### Wide Event Logging

**Event lifecycle expansion**: Fire events for each retry attempt, not just final result.

Retry metadata should be captured in events:
```typescript
interface ActionEvent {
  // ... existing fields
  retryAttempt?: number;      // 0 = original, 1+ = retry number
  totalAttempts?: number;     // Total attempts made (known at final event)
  retryDelays?: number[];     // Actual delays used (ms)
  isRetry?: boolean;          // True for retry attempts
  willRetry?: boolean;        // True if another retry will be attempted after this failure
}
```

**Event types during retry lifecycle**:
1. **Initial attempt fails** → event with `retryAttempt: 0`, `willRetry: true`, `error: Error`
2. **Delay before retry** → (no event, just waiting)
3. **Retry attempt fails** → event with `retryAttempt: N`, `willRetry: true/false`, `error: Error`
4. **Final success** → event with `retryAttempt: N`, `output: Result`, `totalAttempts: N+1`
5. **Final failure** → event with `retryAttempt: N`, `error: Error`, `totalAttempts: N+1`, `willRetry: false`

This provides full visibility into the retry lifecycle for observability.

### Selective Retry

Use the `shouldRetry` predicate to control which errors are retryable:

```typescript
const action = createAction(handler)
  .setRetry({
    maxRetries: 3,
    shouldRetry: (error) => {
      // Retry on network errors, but not validation errors
      return error instanceof NetworkError;
    }
  });
```

**Behavior**:
- If `shouldRetry` returns `false`, no retry is attempted (throw immediately)
- If `shouldRetry` returns `true`, retry according to backoff strategy
- If `shouldRetry` is not provided, **all errors are retried** (default behavior)
- `shouldRetry` is called with the caught error for each failure

**Common patterns**:
```typescript
// Retry only on specific error types
shouldRetry: (error) => error instanceof NetworkError || error instanceof TimeoutError

// Retry on HTTP 5xx, but not 4xx
shouldRetry: (error) => error instanceof HttpError && error.status >= 500

// Retry on specific error codes
shouldRetry: (error) => ['ECONNRESET', 'ETIMEDOUT'].includes(error.code)
```

### Error Handling
- Errors in retry logic itself should be logged but not crash the system
- If retry configuration is invalid, throw synchronously during action creation
- If `shouldRetry` throws, treat it as `false` (don't retry) and log the error

## Implementation Notes

1. **Where to implement**: Retry logic should live in the scheduler's task execution flow, not in ActionBuilder directly
2. **Delay mechanism**: Use `await new Promise(resolve => setTimeout(resolve, delay))`
3. **Random jitter**: Use `Math.random()` for simplicity
4. **Defaults**: Consider sensible defaults (e.g., maxRetries=0, backoff='exponential', baseDelay=100)

## Example Usage

### Basic retry
```typescript
const action = createAction(flakyCacheQuery)
  .setRetry({ maxRetries: 3 });
```

### Exponential backoff with jitter
```typescript
const action = createAction(apiCall)
  .setRetry({
    maxRetries: 5,
    backoff: 'exponential',
    baseDelay: 200,
    maxDelay: 10000,
    jitter: true
  })
  .setConcurrency(10);
```

### Linear backoff
```typescript
const action = createAction(dbQuery)
  .setRetry({
    maxRetries: 3,
    backoff: 'linear',
    baseDelay: 500
  });
```

### Selective retry on network errors
```typescript
const action = createAction(apiCall)
  .setRetry({
    maxRetries: 5,
    backoff: 'exponential',
    jitter: true,
    shouldRetry: (error) => {
      // Only retry on transient failures
      return error instanceof NetworkError || 
             error instanceof TimeoutError ||
             (error instanceof HttpError && error.status >= 500);
    }
  });
```

## Testing Strategy

1. **Basic retry behavior**: Handler fails N times, succeeds on attempt N+1
2. **Exhausted retries**: Handler always fails, verify last error is thrown
3. **Backoff timing**: Verify linear vs exponential delays are calculated correctly
4. **Jitter**: Verify delays vary when jitter is enabled
5. **No retries**: Verify maxRetries=0 means immediate failure
6. **Wide events**: Verify retry metadata is captured in events
7. **Intermediate events**: Verify events fire for each retry attempt with correct lifecycle flags
8. **Scheduler integration**: Verify retries block concurrency slots and count toward rate limiting
9. **Context isolation**: Verify each retry gets fresh context
10. **Selective retry**: Verify `shouldRetry` predicate controls retry behavior
11. **Non-retryable errors**: Verify errors that fail `shouldRetry` throw immediately
12. **shouldRetry errors**: Verify errors in `shouldRetry` itself are handled gracefully

## Design Principles Alignment

- **Default to safe**: maxRetries defaults to 0 (no retries unless explicitly enabled)
- **Wide events**: Retry attempts and delays are fully observable
- **Errors don't break queue**: Failed retries are isolated to individual tasks
- **Builder pattern**: Fluent API with chainable configuration

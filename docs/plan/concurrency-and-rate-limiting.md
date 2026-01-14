# Concurrency and Rate Limiting for Actions

## Feature Overview

Enable Actions to control execution flow through configurable concurrency limits and rate limiting. This allows fine-grained control over how actions execute while maintaining clean separation of concerns.

## Requirements

### Functional Requirements

1. **Concurrent Execution**
   - Allow multiple action invocations to run simultaneously
   - Configurable via `setConcurrency(n)` where `n` is max concurrent executions
   - Default: 1 (sequential execution)

2. **Rate Limiting**
   - Limit number of action executions per time window
   - Configurable via `setRateLimit(n)` where `n` is max executions per second
   - Default: No limit (or effectively unlimited)

3. **Combined Behavior**
   - Support both concurrency and rate limiting simultaneously
   - Rate limit takes precedence over concurrency when both are set
   - Queue executions that exceed limits

4. **Default Behavior**
   - Actions run sequentially (one after another) by default
   - Each invocation starts immediately after the previous completes
   - No artificial delays unless configured

5. **Batch Invocation**
   - Support invoking actions with multiple payloads at once
   - Two batch result modes:
     - `Promise.all` style: Wait for all to complete, return array of results
     - Async iterator style: Yield results as they complete (stream)
   - Batch invocations respect concurrency and rate limiting
   - Individual batch items can fail independently

### Non-Functional Requirements

1. **Clean Architecture**
   - Execution control logic separated from ActionBuilder
   - Dedicated execution manager/scheduler component
   - No tight coupling between action logic and flow control

2. **Reliability**
   - Queued executions maintain order (FIFO)
   - No dropped invocations
   - Proper error handling doesn't break the queue

3. **Performance**
   - Minimal overhead for default (sequential) mode
   - Efficient queue management for high-throughput scenarios
   - No memory leaks from long-running queues

## Architecture

### Component Separation

```
ActionBuilder (public API)
    ↓
ExecutionScheduler (internal - manages flow control)
    ↓
Action Handler (user-defined function)
```

### Key Components

#### 1. ExecutionScheduler
**Responsibility:** Manages execution timing and concurrency

**Properties:**
- `concurrencyLimit: number` - Max concurrent executions
- `rateLimit: number` - Max executions per second
- `activeExecutions: number` - Current running count
- `executionQueue: Queue<ExecutionTask>` - Pending invocations
- `executionTimestamps: number[]` - Recent execution times for rate limiting

**Methods:**
- `schedule(task: ExecutionTask): Promise<T>` - Schedule a task
- `canExecute(): boolean` - Check if execution is allowed
- `executeNext(): void` - Process next queued task
- `trackExecution(): void` - Record execution timestamp

#### 2. ExecutionTask
**Responsibility:** Encapsulates a single action invocation

**Properties:**
- `handler: Function` - The action handler to execute
- `args: any[]` - Arguments to pass to handler
- `resolve: Function` - Promise resolver
- `reject: Function` - Promise rejector

### Implementation Strategy

#### Phase 1: Core Scheduler
1. Create `ExecutionScheduler` class
2. Implement basic queue management
3. Add concurrency tracking
4. Integrate with ActionBuilder

#### Phase 2: Concurrency Control
1. Implement max concurrent execution limit
2. Queue management for pending tasks
3. Automatic queue processing on completion
4. Testing witBatch Invocation
1. Implement `invokeAll()` method for Promise.all style
2. Implement `invokeStream()` method for async iterator style
3. Batch result tracking and aggregation
4. Error handling for partial batch failures

#### Phase 5: h various concurrency levels

#### Phase 3: Rate Limiting
1. Implement sliding window rate limiter
2. Track execution timestamps
3. Calculate wait times based on rate limit
4. Integration with concurrency control

#### Phase 4: Optimization & Polish
1. Performance optimization
2. Memory manag
```typescript
const action = createAction(handler)
    .setConcurrency(5)      // Max 5 concurrent executions
    .setRateLimit(100);     // Max 100 executions per second

// Single invocation
const result = action.invoke(arg1, arg2);

// Batch invocation - Promise.all style (wait for all)
const results = await action.invokeAll([
    [arg1a, arg2a],
    [arg1b, arg2b],
    [arg1c, arg2c]
]);
// results: Array<{ actionId: string, data: O, error?: Error }>

// Batch invocation - Stream style (yield as completed)
for await (const result of action.invokeStream([
    [arg1a, arg2a],
    [arg1b, arg2b],
    [arg1c, arg2c]
])) {
    console.log(`Completed ${result.actionId}:`, result.data);
    // Results arrive as they complete, not in order
}
```typescript
const action = createAction(handler)
    .setConcurrency(5)      // Max 5 concurrent executions
    .setRateLimit(100);     // Max 100 executions per second

const result = action.invoke(arg1, arg2);
```

### Internal Changes
```typescript
    
    // Batch invocation - wait for all to complete
    async invokeAll(payloads: I[]): Promise<BatchResult<O>[]> {
        const tasks = payloads.map(payload => ({
            actionId: crypto.randomUUID(),
            promise: this.scheduler.schedule(() => 
                this.callbackHandler(...payload)
            )
        }));
        
        return Promise.allSettled(tasks.map(t => t.promise))
            .then(results => results.map((result, idx) => ({
                actionId: tasks[idx].actionId,
                data: result.status === 'fulfilled' ? result.value : undefined,
                error: result.status === 'rejected' ? result.reason : undefined
            })));
    }
    
    // Batch invocation - stream results as they complete
    async* invokeStream(payloads: I[]): AsyncGenerator<BatchResult<O>> {
        const tasks = payloads.map(payload => {
            const actionId = crypto.randomUUID();
            const promise = this.scheduler.schedule(() => 
                this.callbackHandler(...payload)
            ).then(
                data => ({ actionId, data, error: undefined }),
                error => ({ actionId, data: undefined, error })
            );
            return promise;
        });
        
        // Yield results as they complete
        while (tasks.length > 0) {
            const result = await Promise.race(tasks);
            yield result;
            const idx = tasks.findIndex(t => 
                t.then(r => r.actionId === result.actionId)
            );
            tasks.splice(idx, 1);
        }
    }
}

type BatchResult<O> = {
    actionId: string;
    data?: O;
    error?: Error;
class ActionBuilder<I extends any[], O> {
    private scheduler: ExecutionScheduler;
    
    constructor(handler: (...args: I) => O | Promise<O>) {
        this.callbackHandler = handler
- Batch invocations with various batch sizes
- Stream results yielding in completion order
- Partial batch failures;
        this.scheduler = new ExecutionScheduler(
            handler,
            this.concurrency,
            this.rateLimit
        );
    }
    
    invoke(...payload: I): ActionResult<O> {
        const requestId = crypto.randomUUID();
        
        // Delegate to scheduler instead of direct execution
        const data = this.scheduler.schedule(() => 
            this.callbackHandler(...payload)
        );
        
        return {
            actionId: requestId,
            data
        };
    }
}
```

## Implementation Details

### Concurrency Algorithm
```
On invoke():
1. Check if activeExecutions < concurrencyLimit
2. If yes: Execute immediately, increment activeExecutions
3. If no: Add to executionQueue
7. **Empty batch**: `invokeAll([])` and `invokeStream([])` should handle gracefully
8. **Large batches**: Should respect concurrency/rate limits
9. **Mixed success/failure in batch**: Should return both successful and failed results
10. **Stream cancellation**: What happens if iteration stops early?
4. On completion: Decrement activeExecutions, executeNext()
```

### Rate Limiting Algorithm (Sliding Window)
```
On schedule():
1. Rem`invokeAll()` returns all results respecting limits
- [ ] `invokeStream()` yields results as they complete
- [ ] Batch invocations respect concurrency and rate limits
- [ ] Partial batch failures handled gracefully
- [ ] ove timestamps older than 1 second
2. If timestamps.length < rateLimit: Allow execution
3. If at limit: Calculate wait time until oldest timestamp expires
4. Schedule execution after wait time
```3-4 hours (batch invocation)
- Phase 5: 2-3 hours (optimization & polish)

**Total: 13-18lgorithm
```
On schedule():
1. Check rate limit first
2. If rate limited: Queue with delay
3. If not rate limited: Check concurrency
4. If concurrent slots available: Execute
5. If no slots: Add to queue
```

## Testing Strategy

### Unit Tests
- ExecutionScheduler in isolation
- Concurrency limit enforcement
- Rate limit accuracy
- Queue management (FIFO ordering)

### Integration Tests
- ActionBuilder with scheduler
- Multiple concurrent invocations
- Rate limiting over time
- Combined concurrency + rate limiting

### Performance Tests
- High-throughput scenarios
- Memory usage with large queues
- Latency measurements
- Edge cases (0 concurrency, extreme rate limits)

## Edge Cases

1. **Concurrency = 0**: Should queue all executions (never execute)
2. **RateLimit = 0**: Should queue all executions (never execute)
3. **Very high limits**: Should behave like unlimited
4. **Handler throws error**: Should not break queue processing
5. **Rapid invoke() calls**: Should handle backpressure gracefully
6. **Long-running handlers**: Concurrency should still work correctly

## Success Criteria

- [ ] Actions execute sequentially by default
- [ ] Concurrency limit accurately enforced
- [ ] Rate limit accurately enforced (±5% tolerance)
- [ ] Queued invocations maintain order
- [ ] No memory leaks over 10,000+ invocations
- [ ] Error in one execution doesn't affect others
- [ ] Performance overhead < 1ms for default mode
- [Batch Invocation Details

### invokeAll() - Promise.all Style

**Use Case:** When you need all results before proceeding

**Behavior:**
- Submits all payloads to scheduler at once
- Waits for all executions to complete
- Returns array of results in same order as input
- Each result includes success/failure status
- Respects concurrency and rate limits

**Example:**
```typescript
const results = await action.invokeAll([
    ["task1", true],
    ["task2", false],
    ["task3", true]
]);

results.forEach((result, idx) => {
    if (result.error) {
        console.error(`Task ${idx} failed:`, result.error);
    } else {
        console.log(`Task ${idx} succeeded:`, result.data);
    }
});
```

### invokeStream() - Async Iterator Style

**Use Case:** When you want to process results as they complete (streaming)

**Behavior:**
- Submits all payloads to scheduler at once
- Yields results as each execution completes
- Results arrive in completion order (not input order)
- Can start processing early results while others run
- Memory efficient for large batches
- Respects concurrency and rate limits

**Example:**
```typescript
for await (const result of action.invokeStream(payloads)) {
    if (result.error) {
        console.error(`Failed ${result.actionId}:`, result.error);
    } else {
        // Process result immediately, don't wait for others
        await processResult(result.data);
    }
}
```

### Comparison

| Feature | invoke() | invokeAll() | invokeStream() |
|---------|----------|-------------|----------------|
| Batch size | 1 | Multiple | Multiple |
| Result timing | Immediate | All at once | As completed |
| Result order | N/A | Input order | Completion order |
| Memory | Low | High (stores all) | Low (yields) |
| Processing | Single | Batch | Stream |

## Future Enhancements

- Priority queues for important actions
- Backpressure signals when queue is full
- Metrics/observability (queue size, execution times)
- Cancellation support for queued tasks
- Adaptive rate limiting based on errors
- Batch retry policies
- Progress tracking for large batche
- Phase 4: 2-3 hours

**Total: 10-14 hours**

## Future Enhancements

- Priority queues for important actions
- Backpressure signals when queue is full
- Metrics/observability (queue size, execution times)
- Cancellation support for queued tasks
- Batch execution modes
- Adaptive rate limiting based on errors

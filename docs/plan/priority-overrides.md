# Priority Overrides

## Purpose

Add priority-based task scheduling to enable high-priority tasks to execute before lower-priority ones in the queue. This is essential for user-facing operations that should take precedence over background jobs, critical alerts, and tiered service levels.

## API Design

### Builder-Level Priority (Default)

Set default priority for all invocations of an action:

```typescript
const backgroundJob = createAction(handler)
  .setConcurrency(10)
  .setPriority('low');  // or 'normal' | 'high' | 'critical'

const userFacingAction = createAction(handler)
  .setConcurrency(10)  
  .setPriority('high');  // Higher priority = executes first
```

**Name rationale**: `setPriority()` follows established pattern. Accepts string levels for readability.

### Invocation-Level Priority (Override)

Override priority for specific invocations:

```typescript
const action = createAction(handler).setPriority('normal');

// Most invocations use 'normal' priority
action.invoke(input1);
action.invoke(input2);

// High-priority invocation jumps the queue
action.invoke(input3, { priority: 'critical' });

// Low-priority invocation goes to back
action.invoke(input4, { priority: 'low' });
```

**New invoke signature**:
```typescript
class ActionBuilder<TInput, TOutput> {
  invoke(...args: TInput, options?: InvokeOptions): InvocationHandle<TOutput>;
  invokeAll(payloads: TInput[], options?: InvokeOptions): InvocationHandle<TOutput>[];
  invokeStream(payloads: TInput[], options?: InvokeOptions): AsyncIterableIterator<BatchResult<TOutput>>;
}

interface InvokeOptions {
  priority?: Priority;      // Override action's default priority
  metadata?: Record<string, unknown>;  // Custom metadata for observability
}
```

### Priority Levels

```typescript
type Priority = 'low' | 'normal' | 'high' | 'critical';

// Numeric mapping (internal)
const PRIORITY_VALUES = {
  low: 0,
  normal: 50,
  high: 75,
  critical: 100
} as const;
```

**Rationale**: 
- String-based for readability (avoid magic numbers)
- Four levels cover most use cases without overwhelming users
- Numeric mapping allows future expansion (e.g., custom numeric priorities)
- Default is 'normal' (50) — safe middle ground

### Numeric Priority (Advanced)

For fine-grained control:

```typescript
const action = createAction(handler)
  .setPriority(60);  // Custom numeric priority (0-100)

action.invoke(input, { priority: 85 });  // Override with custom number
```

**Type expansion**:
```typescript
type Priority = 'low' | 'normal' | 'high' | 'critical' | number;
```

**Validation**: Priority must be in range [0, 100]. Values outside throw error at configuration time.

## Behavior Specifications

### Queue Ordering

Scheduler maintains a **priority queue** instead of FIFO:

1. Tasks with higher priority value execute first
2. Within same priority, tasks execute in FIFO order (insertion order preserved)
3. Running tasks are NOT preempted by higher-priority tasks (no interruption)
4. New high-priority tasks wait for available concurrency slots

**Example timeline**:
```typescript
const action = createAction(handler).setConcurrency(1);

// T=0ms: Invoke normal priority (starts immediately)
action.invoke(input1, { priority: 'normal' });

// T=10ms: Invoke low priority (queued)
action.invoke(input2, { priority: 'low' });

// T=20ms: Invoke high priority (jumps ahead of input2)
action.invoke(input3, { priority: 'high' });

// T=30ms: Invoke critical priority (jumps ahead of input3)
action.invoke(input4, { priority: 'critical' });

// Execution order: input1 → input4 → input3 → input2
```

### Priority Queue Data Structure

Use a **min-heap** or **sorted insertion** for efficient queue management:

```typescript
class PriorityQueue<T> {
  private items: Array<{ priority: number; insertOrder: number; task: T }> = [];
  private insertCounter = 0;
  
  enqueue(task: T, priority: number): void {
    this.items.push({ 
      priority: -priority,  // Negative for max-heap behavior
      insertOrder: this.insertCounter++, 
      task 
    });
    this.items.sort((a, b) => {
      // Higher priority first, then FIFO within same priority
      if (a.priority !== b.priority) return a.priority - b.priority;
      return a.insertOrder - b.insertOrder;
    });
  }
  
  dequeue(): T | undefined {
    return this.items.shift()?.task;
  }
  
  remove(predicate: (task: T) => boolean): boolean {
    const index = this.items.findIndex(item => predicate(item.task));
    if (index === -1) return false;
    this.items.splice(index, 1);
    return true;
  }
  
  get size(): number {
    return this.items.length;
  }
}
```

**Performance**: O(n log n) for enqueue, O(1) for dequeue, O(n) for remove. Sufficient for typical queue sizes (<10k).

### Integration with Concurrency

Priority affects queue order, NOT concurrency limits:

```typescript
const action = createAction(handler)
  .setConcurrency(3)   // Max 3 parallel
  .setPriority('normal');

// 10 high-priority invocations
for (let i = 0; i < 10; i++) {
  action.invoke(input, { priority: 'high' });
}

// Still only 3 run in parallel
// But all 10 high-priority tasks execute before any normal/low priority
```

**Behavior**: 
- Concurrency limit is global across all priorities
- Priority determines which queued task runs when a slot opens
- No priority-based concurrency allocation (no "2 slots for high, 1 slot for low")

### Integration with Rate Limiting

Priority does NOT bypass rate limits:

```typescript
const action = createAction(handler)
  .setRateLimit(10)     // Max 10/second
  .setPriority('normal');

// High-priority task still respects rate limit
action.invoke(input, { priority: 'critical' });
// Will execute when rate limit allows, but ahead of lower priorities
```

**Behavior**:
- Rate limit is global across all priorities
- Priority determines order within rate-limited queue
- High-priority tasks don't get extra rate limit budget

### Integration with Retry

Priority persists through retry attempts:

```typescript
const action = createAction(handler)
  .setRetry({ maxRetries: 3 })
  .setPriority('normal');

// High-priority invocation
const invocation = action.invoke(input, { priority: 'high' });

// If fails and retries:
// - Retry attempts maintain 'high' priority
// - Retry delay respects priority (high-priority retries jump queue)
```

**Behavior**:
- Original priority is preserved across retries
- Retry delays do NOT change priority
- Retried tasks re-enter queue at original priority

### Integration with Cancellation

Priority of cancelled tasks is irrelevant:

```typescript
const invocation = action.invoke(input, { priority: 'critical' });
invocation.cancel();
// Removed from queue immediately, priority doesn't matter
```

**Behavior**: Cancellation always takes precedence over priority.

### Integration with Timeout

Priority does NOT affect timeout duration:

```typescript
const action = createAction(handler)
  .setTimeout(5000)
  .setPriority('normal');

// Critical priority task gets same 5s timeout
action.invoke(input, { priority: 'critical' });
```

**Behavior**: Timeout is per-task, not priority-based.

### Priority in Batch Operations

Batch operations inherit priority:

```typescript
// All items in batch get 'high' priority
const results = await action.invokeAll(
  [input1, input2, input3],
  { priority: 'high' }
);

// Individual items within batch maintain FIFO order relative to each other
// But entire batch executes before lower-priority tasks
```

**Behavior**:
- All items in batch get same priority
- Items within batch maintain insertion order
- Batch as a whole is prioritized relative to other batches

### Wide Event Logging

Priority metadata should be captured in events:

```typescript
interface ActionEvent {
  // ... existing fields
  priority?: Priority;              // Priority level used
  priorityValue?: number;           // Numeric priority value
  queuePosition?: number;           // Position in queue when enqueued
  queueWaitTime?: number;           // Time spent in queue (ms)
  wasStarved?: boolean;             // Whether task was starved by higher priorities
}
```

**Event structure with priority**:
```typescript
{
  actionId: "abc123",
  timestamp: 1234567890,
  duration: 523,
  input: ["user123"],
  output: { data: "..." },
  priority: "high",
  priorityValue: 75,
  queuePosition: 3,        // Was 3rd in queue when enqueued
  queueWaitTime: 150,      // Waited 150ms before executing
  wasStarved: false        // Not starved (would be true if waited abnormally long)
}
```

### Starvation Detection

Low-priority tasks can be starved if high-priority tasks keep arriving:

```typescript
// Optional: Age-based priority boost to prevent starvation
const action = createAction(handler)
  .setPriority('normal')
  .setStarvationPrevention({
    enabled: true,
    maxWaitTime: 30000,    // 30s max wait
    priorityBoost: 25      // Boost priority by 25 after maxWaitTime
  });
```

**Behavior** (optional feature for future):
- Tasks waiting > maxWaitTime get priority boost
- Ensures low-priority tasks eventually execute
- Logged in events (`wasStarved: true`)

**Recommendation**: Start without starvation prevention (simpler), add if needed.

## Implementation Considerations

### Scheduler Queue Replacement

Replace FIFO queue with priority queue:

```typescript
class ExecutionScheduler {
  // Before: private queue: Task[] = [];
  // After:
  private queue: PriorityQueue<Task>;
  
  async schedule(task: Task, priority: number = 50): Promise<void> {
    this.queue.enqueue(task, priority);
    await this.processQueue();
  }
  
  private async processQueue(): Promise<void> {
    while (this.queue.size > 0 && this.canExecute()) {
      const task = this.queue.dequeue();
      if (task) {
        await this.execute(task);
      }
    }
  }
}
```

### Priority Propagation

Priority flows from builder → invocation → scheduler:

```typescript
class ActionBuilder<TInput, TOutput> {
  private defaultPriority: number = 50;  // 'normal'
  
  setPriority(priority: Priority): this {
    this.defaultPriority = priorityToNumber(priority);
    return this;
  }
  
  invoke(...args: TInput, options?: InvokeOptions): InvocationHandle<TOutput> {
    const priority = options?.priority !== undefined 
      ? priorityToNumber(options.priority)
      : this.defaultPriority;
      
    return this.scheduler.schedule({
      handler: this.handler,
      args,
      priority,
      actionId: generateId(),
      // ...
    });
  }
}

function priorityToNumber(priority: Priority): number {
  if (typeof priority === 'number') {
    if (priority < 0 || priority > 100) {
      throw new Error('Priority must be between 0 and 100');
    }
    return priority;
  }
  return PRIORITY_VALUES[priority];
}
```

### Memory Management

Priority queue doesn't increase memory overhead significantly:
- Each task stores: priority (number) + insertOrder (number) + task object
- Overhead: ~16 bytes per task
- For 10k tasks: ~160KB extra memory (negligible)

### Performance Considerations

Sorting overhead:
- Insertion: O(n log n) worst case (could optimize to O(log n) with proper heap)
- Dequeue: O(1)
- For typical queues (<1000 tasks), sorting is fast enough (<1ms)

**Future optimization**: Use binary heap for O(log n) insertion if queue sizes grow large.

## Edge Cases

### Same Priority, Different Insertion Times
```typescript
action.invoke(input1, { priority: 'high' });  // T=0
action.invoke(input2, { priority: 'high' });  // T=10
action.invoke(input3, { priority: 'high' });  // T=20

// Execution order: input1 → input2 → input3 (FIFO within priority)
```

**Behavior**: Insertion order is tiebreaker.

### Priority Override on Action with Default Priority
```typescript
const action = createAction(handler).setPriority('low');

action.invoke(input1);  // Uses 'low'
action.invoke(input2, { priority: 'critical' });  // Overrides to 'critical'

// Execution order: input2 → input1
```

**Behavior**: Invocation-level priority always overrides action-level priority.

### Dynamic Priority Changes
```typescript
const action = createAction(handler).setPriority('normal');

action.invoke(input1);  // 'normal' priority

action.setPriority('high');  // Change default

action.invoke(input2);  // 'high' priority (new default)

// Already queued tasks (input1) keep original priority
```

**Behavior**: Priority changes affect future invocations only, not queued tasks.

### Priority in Nested Actions
```typescript
const actionB = createAction(handlerB).setPriority('low');

const actionA = createAction(async (input) => {
  // actionA is 'high', but actionB is still 'low'
  return actionB.invoke(input).data;
}).setPriority('high');

actionA.invoke(input);
// actionA executes with 'high' priority
// actionB executes with 'low' priority (independent schedulers)
```

**Behavior**: Priorities are per-action, not inherited across nested actions.

### Priority with Empty Queue
```typescript
const action = createAction(handler)
  .setConcurrency(5)
  .setPriority('normal');

// First invocation with 'critical' priority
action.invoke(input, { priority: 'critical' });

// Queue is empty, executes immediately regardless of priority
```

**Behavior**: Priority only matters when queue has multiple tasks. Empty queue = immediate execution.

### Invalid Priority Values
```typescript
action.setPriority(150);  // Throws: "Priority must be between 0 and 100"
action.setPriority(-10);  // Throws: "Priority must be between 0 and 100"
action.invoke(input, { priority: 'ultra' });  // TypeScript error
```

**Behavior**: Validation at configuration time, TypeScript prevents invalid strings.

## Testing Strategy

### Unit Tests
- ✅ High priority executes before low priority
- ✅ FIFO order within same priority level
- ✅ Priority override on invocation
- ✅ Default priority ('normal') when not specified
- ✅ Numeric priority validation (0-100)
- ✅ Priority persists through retry
- ✅ Priority in batch operations
- ✅ Priority metadata in events (priority, queuePosition, queueWaitTime)
- ✅ Cancellation removes from priority queue
- ✅ Dynamic priority changes affect future invocations only

### Integration Tests
- ✅ Priority + concurrency → order preserved, limit enforced
- ✅ Priority + rate limiting → order preserved, rate enforced
- ✅ Priority + retry → priority maintained across retries
- ✅ Priority + timeout → timeout not affected by priority
- ✅ Priority + cancellation → cancellation immediate regardless of priority
- ✅ Mixed priorities across multiple actions

### Performance Tests
- ✅ Large queue (10k tasks) with mixed priorities → <100ms to enqueue
- ✅ Frequent priority switches → no memory leaks
- ✅ Priority queue dequeue performance → O(1)

## Examples

### User-Facing vs. Background Tasks
```typescript
const backgroundSync = createAction(syncDatabase)
  .setConcurrency(2)
  .setPriority('low');

const userRequest = createAction(handleUserRequest)
  .setConcurrency(10)
  .setPriority('high');

// User requests always execute before background syncs
userRequest.invoke(request);
backgroundSync.invoke();
```

### Dynamic Priority Based on User Tier
```typescript
const apiCall = createAction(handler).setPriority('normal');

function invoke(userId: string, data: unknown) {
  const user = getUser(userId);
  
  const priority = user.isPremium ? 'high' : 'normal';
  
  return apiCall.invoke(data, { priority });
}
```

### Critical Alerts
```typescript
const sendNotification = createAction(handler)
  .setConcurrency(5)
  .setPriority('normal');

// Regular notification
sendNotification.invoke({ type: 'info', message: '...' });

// Critical security alert
sendNotification.invoke(
  { type: 'security', message: 'Intrusion detected!' },
  { priority: 'critical' }
);
```

### Load Shedding
```typescript
const action = createAction(handler)
  .setConcurrency(10)
  .setPriority('normal');

// Under high load, only accept high-priority tasks
if (getQueueSize() > 1000) {
  action.invoke(input, { priority: 'low' }).cancel();
  throw new Error('Server overloaded, only accepting critical requests');
}
```

### Priority with Retry
```typescript
const apiCall = createAction(handler)
  .setPriority('normal')
  .setRetry({ 
    maxRetries: 3,
    backoff: 'exponential'
  });

// High-priority call that may retry
const invocation = apiCall.invoke(data, { priority: 'high' });

// Retries maintain 'high' priority
// Retry delays don't affect priority
```

### Observability with Priority
```typescript
const action = createAction(
  withContext(async (ctx, input) => {
    ctx.attach('startTime', Date.now());
    const result = await process(input);
    ctx.attach('processingTime', Date.now() - ctx.attachments.startTime);
    return result;
  })
)
.setPriority('normal')
.onEvent((event) => {
  if (event.queueWaitTime > 10000 && event.priority === 'high') {
    logger.warn('High priority task waited too long', {
      actionId: event.actionId,
      waitTime: event.queueWaitTime,
      queuePosition: event.queuePosition
    });
  }
});
```

## Open Questions

1. **Should we support dynamic priority adjustment for queued tasks?**
   ```typescript
   const invocation = action.invoke(input, { priority: 'normal' });
   // Later, before execution
   invocation.setPriority('high');  // Re-prioritize in queue
   ```
   Useful but complex (need to maintain invocation handles in queue).
   
   **Recommendation**: Future enhancement, not MVP.

2. **Should we support priority-based concurrency allocation?**
   ```typescript
   .setConcurrency({
     high: 5,    // 5 slots for high priority
     normal: 3,  // 3 slots for normal
     low: 2      // 2 slots for low
   })
   ```
   Prevents low-priority tasks from blocking high-priority slots.
   
   **Recommendation**: Interesting but complex. Consider for v2.

3. **Should we automatically detect and warn about starvation?**
   Currently events include `wasStarved` but no active prevention.
   
   **Recommendation**: Add detection first (events), prevention later if needed.

4. **Should priority affect retry behavior?**
   ```typescript
   .setRetry({
     maxRetries: { high: 5, normal: 3, low: 1 }  // More retries for high priority
   })
   ```
   
   **Recommendation**: Not needed for MVP. Priority determines order, not behavior.

## Migration Path

Adding priority is opt-in and backward compatible:
- Default priority is 'normal' (50) — same behavior as current FIFO
- Existing code without priority works unchanged
- Priority only affects execution order when specified
- Scheduler queue replacement is internal (no API changes)
- New tests added alongside existing suites

**Zero breaking changes**: Actions without priority continue working exactly as before.

## Future Enhancements

1. **Dynamic priority adjustment**: Change priority of queued tasks
2. **Priority-based concurrency allocation**: Separate slots per priority level
3. **Starvation prevention**: Automatic priority boosting for old tasks
4. **Priority inheritance**: Nested actions inherit parent priority
5. **Priority budgets**: Limit total high-priority executions per time window
6. **Weighted priority**: Non-linear priority values (e.g., critical = 10x normal)

## Design Principles Alignment

✅ **Safe defaults**: Default 'normal' priority maintains FIFO behavior  
✅ **Composability**: Works seamlessly with retry, timeout, concurrency, rate limiting  
✅ **Type safety**: Priority types validated, TypeScript support  
✅ **Observability first**: Rich priority metadata in events  
✅ **Error isolation**: Priority doesn't affect error handling  
✅ **Progressive enhancement**: Opt-in feature, zero breaking changes  

Priority overrides add critical scheduling control while maintaining the library's core philosophy of safe, observable, composable async execution.

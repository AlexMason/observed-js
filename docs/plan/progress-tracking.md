# Progress Tracking

## Purpose

Add progress visibility for long-running batch operations and individual invocations. This enables UX updates (progress bars, status indicators), monitoring of large jobs, and understanding task completion rates. Progress tracking is essential for user-facing features and operational visibility.

## API Design

### Progress Callbacks

Register progress callbacks at action or invocation level:

```typescript
// Action-level progress tracking (all invocations)
const action = createAction(handler)
  .onProgress((progress) => {
    console.log(`${progress.completed}/${progress.total} (${progress.percentage}%)`);
  });

// Invocation-level progress (single invocation)
const invocation = action.invoke(input, {
  onProgress: (progress) => {
    updateProgressBar(progress.percentage);
  }
});
```

**Name rationale**: `.onProgress()` follows `.onEvent()` pattern. Callback-based for streaming updates.

### Progress Object

```typescript
interface Progress {
  completed: number;        // Number of completed steps/items
  total: number;            // Total number of steps/items
  percentage: number;       // Completion percentage (0-100)
  current?: string;         // Description of current step
  rate?: number;            // Items per second
  estimatedTimeRemaining?: number;  // Milliseconds remaining (estimated)
  startTime: number;        // Timestamp when started
  elapsedTime: number;      // Milliseconds since start
}
```

### Handler Progress Reporting

Handlers can report progress using context:

```typescript
const action = createAction(
  withContext(async (ctx, items: string[]) => {
    ctx.setTotal(items.length);  // Set total progress items
    
    const results = [];
    for (let i = 0; i < items.length; i++) {
      ctx.reportProgress(i + 1, `Processing ${items[i]}`);
      // or: ctx.incrementProgress(`Processing ${items[i]}`);
      
      const result = await processItem(items[i]);
      results.push(result);
    }
    
    return results;
  })
).onProgress((progress) => {
  console.log(`Progress: ${progress.percentage}%`);
});
```

**Context API additions**:
```typescript
interface InvocationContext {
  // ... existing methods (attach, etc.)
  
  // Progress tracking
  setTotal(total: number): void;
  reportProgress(completed: number, current?: string): void;
  incrementProgress(current?: string): void;  // completed++
}
```

### Batch Progress Tracking

Automatic progress for batch operations:

```typescript
const action = createAction(handler);

// invokeAll with progress
const results = await action.invokeAll(
  items,
  {
    onProgress: (progress) => {
      // Automatically tracks completion of batch items
      console.log(`Batch: ${progress.completed}/${progress.total}`);
    }
  }
);

// invokeStream with progress
const stream = action.invokeStream(
  items,
  {
    onProgress: (progress) => {
      // Updates as each item completes
      console.log(`Stream: ${progress.completed}/${progress.total}`);
    }
  }
);
```

**Behavior**:
- For `invokeAll`: Progress updates as each item completes
- For `invokeStream`: Progress updates as items are yielded
- Total is automatically set to `items.length`
- No manual progress reporting needed for batches

### Nested Progress (Advanced)

Handlers with sub-tasks can report nested progress:

```typescript
const action = createAction(
  withContext(async (ctx, files: string[]) => {
    ctx.setTotal(files.length);
    
    for (let i = 0; i < files.length; i++) {
      // Create nested progress for this file
      const fileProgress = ctx.createSubProgress(1);  // This file = 1 unit of parent
      
      fileProgress.setTotal(100);  // File has 100 chunks
      
      await processFile(files[i], (chunk) => {
        fileProgress.incrementProgress();  // Updates parent proportionally
      });
      
      ctx.reportProgress(i + 1);
    }
  })
).onProgress((progress) => {
  // Receives aggregated progress across all files
  console.log(`Overall: ${progress.percentage}%`);
});
```

**Context API for nested progress**:
```typescript
interface InvocationContext {
  createSubProgress(weight: number): SubProgressContext;
}

interface SubProgressContext {
  setTotal(total: number): void;
  reportProgress(completed: number, current?: string): void;
  incrementProgress(current?: string): void;
}
```

**Calculation**: Parent progress = sum of (child progress × child weight) / total weight

**Recommendation**: Start without nested progress (complex), add if needed.

## Behavior Specifications

### Progress Calculation

**Simple progress** (no handler reporting):
```typescript
// Batch operation
action.invokeAll([1, 2, 3, 4, 5]);
// Progress: 0/5 → 1/5 → 2/5 → 3/5 → 4/5 → 5/5
// Percentage: 0% → 20% → 40% → 60% → 80% → 100%
```

**Handler-reported progress**:
```typescript
withContext(async (ctx, items) => {
  ctx.setTotal(items.length);
  
  for (let i = 0; i < items.length; i++) {
    await process(items[i]);
    ctx.incrementProgress();  // Manual increment
  }
})
// Progress: 0/10 → 1/10 → 2/10 → ... → 10/10
```

**Mixed progress** (handler reports sub-steps):
```typescript
withContext(async (ctx, items) => {
  ctx.setTotal(items.length * 100);  // Each item has 100 sub-steps
  
  for (const item of items) {
    for (let step = 0; step < 100; step++) {
      await processStep(item, step);
      ctx.incrementProgress();  // Fine-grained progress
    }
  }
})
// Progress: 0/500 → 1/500 → 2/500 → ... → 500/500
```

### Progress Update Frequency

Avoid spamming progress callbacks:

```typescript
// Built-in throttling (max 10 updates/second)
ctx.reportProgress(50);  // Fires callback
ctx.reportProgress(51);  // Throttled (too soon)
ctx.reportProgress(52);  // Throttled
// ... 100ms passes
ctx.reportProgress(53);  // Fires callback
```

**Throttling behavior**:
- Max 10 progress callbacks per second (configurable)
- Always fire on 0% and 100%
- Always fire on significant percentage changes (>5%)
- Buffer intermediate updates

**Configuration**:
```typescript
const action = createAction(handler)
  .onProgress((progress) => { ... }, { 
    throttle: 100  // ms between updates (default: 100)
  });
```

### Rate and ETA Calculation

Automatically calculate completion rate and estimated time:

```typescript
interface Progress {
  rate?: number;                  // Items per second (calculated)
  estimatedTimeRemaining?: number; // ms remaining (calculated)
}

// Calculation:
// rate = completed / (elapsedTime / 1000)
// estimatedTimeRemaining = (total - completed) / rate * 1000
```

**Smoothing**: Use exponential moving average to smooth rate fluctuations:
```typescript
// Instead of: rate = completed / elapsed
// Use: rate = 0.7 * previousRate + 0.3 * currentRate
```

### Integration with Retry

Progress persists across retry attempts:

```typescript
const action = createAction(
  withContext(async (ctx, items) => {
    ctx.setTotal(items.length);
    
    for (const item of items) {
      await processItem(item);  // May throw
      ctx.incrementProgress();
    }
  })
).setRetry({ maxRetries: 3 });

const invocation = action.invoke([1, 2, 3, 4, 5], {
  onProgress: (progress) => console.log(progress)
});

// Timeline:
// Attempt 1: 0/5 → 1/5 → 2/5 → [error at item 3]
// Retry delay...
// Attempt 2: 0/5 → 1/5 → 2/5 → 3/5 → 4/5 → 5/5 ✓

// Progress resets on retry (each attempt is fresh)
```

**Behavior**: Progress resets to 0 on retry (each attempt is independent).

**Alternative**: Accumulate progress across retries (more complex, requires state management).

**Recommendation**: Reset on retry (simpler), document behavior clearly.

### Integration with Concurrency

Progress updates for concurrent tasks:

```typescript
const action = createAction(handler)
  .setConcurrency(5)
  .onProgress((progress) => {
    // Updates as tasks complete across all 5 concurrent slots
  });

action.invokeAll([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);

// Progress: 0/10 → 5/10 (first 5 complete) → 10/10
// Note: Updates are NOT in strict order (concurrency)
```

**Behavior**: Progress updates reflect completion, not execution order.

### Integration with Cancellation

Progress stops on cancellation:

```typescript
const invocation = action.invoke(items, {
  onProgress: (progress) => {
    if (progress.completed > 50) {
      invocation.cancel("Halfway is enough");
    }
  }
});

// Progress: 0/100 → 10/100 → ... → 51/100 → [cancelled]
// No more progress updates after cancellation
```

**Behavior**: Cancellation immediately stops progress updates.

### Integration with Timeout

Progress continues until timeout:

```typescript
const action = createAction(
  withContext(async (ctx, items) => {
    ctx.setTotal(items.length);
    
    for (const item of items) {
      await slowProcess(item);  // May exceed timeout
      ctx.incrementProgress();
    }
  })
).setTimeout(5000);

const invocation = action.invoke([1, 2, 3, 4, 5], {
  onProgress: (progress) => console.log(progress)
});

// Progress: 0/5 → 1/5 → 2/5 → [timeout] → TimeoutError
// Progress stopped at 2/5 (40%)
```

**Behavior**: Timeout stops progress immediately, final progress reflects partial completion.

### Wide Event Logging

Progress metadata in final events:

```typescript
interface ActionEvent {
  // ... existing fields
  progress?: {
    completed: number;
    total: number;
    percentage: number;
    rate?: number;
    partialCompletion?: boolean;  // True if stopped before 100%
  };
}
```

**Event structure with progress**:
```typescript
{
  actionId: "abc123",
  timestamp: 1234567890,
  duration: 5234,
  input: [[1, 2, 3, 4, 5]],
  output: [...],
  progress: {
    completed: 5,
    total: 5,
    percentage: 100,
    rate: 0.95,  // ~1 item/second
    partialCompletion: false
  }
}
```

**For errors** (timeout, cancellation):
```typescript
{
  actionId: "abc456",
  error: TimeoutError,
  progress: {
    completed: 2,
    total: 5,
    percentage: 40,
    rate: 0.4,
    partialCompletion: true  // Stopped early
  }
}
```

## Implementation Considerations

### Progress State Management

Store progress state in invocation context:

```typescript
class InvocationContextImpl implements InvocationContext {
  private progressTotal?: number;
  private progressCompleted: number = 0;
  private progressStartTime: number = Date.now();
  private lastProgressUpdate: number = 0;
  private progressCallback?: (progress: Progress) => void;
  
  setTotal(total: number): void {
    this.progressTotal = total;
    this.fireProgress();
  }
  
  reportProgress(completed: number, current?: string): void {
    this.progressCompleted = completed;
    this.fireProgress(current);
  }
  
  incrementProgress(current?: string): void {
    this.progressCompleted++;
    this.fireProgress(current);
  }
  
  private fireProgress(current?: string): void {
    if (!this.progressCallback || this.progressTotal === undefined) return;
    
    const now = Date.now();
    
    // Throttle updates (except 0% and 100%)
    const percentage = (this.progressCompleted / this.progressTotal) * 100;
    if (percentage !== 0 && percentage !== 100) {
      if (now - this.lastProgressUpdate < 100) return;  // 100ms throttle
    }
    
    this.lastProgressUpdate = now;
    
    const elapsedTime = now - this.progressStartTime;
    const rate = this.progressCompleted / (elapsedTime / 1000);
    const remaining = this.progressTotal - this.progressCompleted;
    const estimatedTimeRemaining = rate > 0 ? (remaining / rate) * 1000 : undefined;
    
    this.progressCallback({
      completed: this.progressCompleted,
      total: this.progressTotal,
      percentage: Math.round(percentage * 100) / 100,  // 2 decimal places
      current,
      rate: Math.round(rate * 100) / 100,
      estimatedTimeRemaining: estimatedTimeRemaining ? Math.round(estimatedTimeRemaining) : undefined,
      startTime: this.progressStartTime,
      elapsedTime
    });
  }
}
```

### Batch Progress Tracking

Automatically track batch progress:

```typescript
async invokeAll<TInput>(
  payloads: TInput[],
  options?: InvokeOptions
): Promise<InvocationHandle<TOutput>[]> {
  const total = payloads.length;
  let completed = 0;
  
  const progressCallback = options?.onProgress;
  
  const fireProgress = () => {
    if (!progressCallback) return;
    
    progressCallback({
      completed,
      total,
      percentage: (completed / total) * 100,
      startTime: startTime,
      elapsedTime: Date.now() - startTime,
      // ... calculate rate, ETA
    });
  };
  
  const startTime = Date.now();
  fireProgress();  // 0% update
  
  const invocations = payloads.map(payload => this.invoke(payload));
  
  // Track completion
  invocations.forEach(inv => {
    inv.data.finally(() => {
      completed++;
      fireProgress();
    });
  });
  
  return invocations;
}
```

### Memory Management

- Progress state is per-invocation (no global state)
- Garbage collected after invocation completes
- Throttling prevents callback spam
- No persistent references to completed invocations

## Edge Cases

### setTotal() Never Called
```typescript
withContext(async (ctx) => {
  // No ctx.setTotal()
  ctx.incrementProgress();  // No-op, no total set
})
```

**Behavior**: Progress methods are no-ops if total is not set. No error thrown.

### Progress Exceeds Total
```typescript
withContext(async (ctx) => {
  ctx.setTotal(5);
  
  for (let i = 0; i < 10; i++) {
    ctx.incrementProgress();  // Eventually exceeds 5
  }
})
```

**Behavior**: 
- Allow progress > total (don't throw error)
- Percentage caps at 100%
- Log warning if exceeds by >10%

### Progress Called After Completion
```typescript
withContext(async (ctx) => {
  ctx.setTotal(5);
  ctx.reportProgress(5);  // 100%
  
  // Later...
  ctx.incrementProgress();  // After 100%
})
```

**Behavior**: Allow updates after 100% (progress can go to 101%, etc.). Useful for handlers that continue work after "completion".

### Rapid Progress Updates
```typescript
withContext(async (ctx) => {
  ctx.setTotal(1000000);
  
  for (let i = 0; i < 1000000; i++) {
    ctx.incrementProgress();  // 1M updates
  }
})
```

**Behavior**: Throttling prevents callback spam. Only ~10 updates/second regardless of how many times `incrementProgress()` is called.

### Progress in Nested Actions
```typescript
const actionB = createAction(
  withContext(async (ctx) => {
    ctx.setTotal(10);
    // ... progress updates
  })
);

const actionA = createAction(
  withContext(async (ctx) => {
    ctx.setTotal(5);
    
    for (let i = 0; i < 5; i++) {
      await actionB.invoke().data;  // Nested action
      ctx.incrementProgress();
    }
  })
).onProgress((progress) => {
  // Only sees actionA's progress, not actionB's
});
```

**Behavior**: Progress is per-action, not inherited across nested actions. Each action tracks its own progress.

### Progress with Empty Batch
```typescript
action.invokeAll([], { 
  onProgress: (progress) => console.log(progress) 
});

// Fires: { completed: 0, total: 0, percentage: 0 }
```

**Behavior**: Empty batch fires one progress update (0/0, 0%). Percentage is 0 (not NaN or 100).

## Testing Strategy

### Unit Tests
- ✅ Manual progress reporting with `setTotal()` and `incrementProgress()`
- ✅ Percentage calculation accuracy
- ✅ Rate calculation (items/second)
- ✅ ETA calculation
- ✅ Throttling (max 10 updates/second)
- ✅ Always fire on 0% and 100%
- ✅ Progress metadata in final events
- ✅ Progress resets on retry
- ✅ Progress stops on cancellation/timeout
- ✅ Progress exceeds total (allowed, capped at 100%)
- ✅ Empty batch progress (0/0)

### Integration Tests
- ✅ Batch progress tracking (`invokeAll`, `invokeStream`)
- ✅ Progress + concurrency → updates reflect completion order
- ✅ Progress + retry → resets on each attempt
- ✅ Progress + timeout → stops at partial completion
- ✅ Progress + cancellation → stops immediately
- ✅ Nested actions → independent progress tracking

## Examples

### Simple Progress Bar
```typescript
const action = createAction(
  withContext(async (ctx, items: string[]) => {
    ctx.setTotal(items.length);
    
    for (const item of items) {
      await processItem(item);
      ctx.incrementProgress();
    }
  })
);

const invocation = action.invoke(items, {
  onProgress: (progress) => {
    updateProgressBar(progress.percentage);
    console.log(`ETA: ${progress.estimatedTimeRemaining}ms`);
  }
});
```

### Batch Processing with Progress
```typescript
const processFiles = createAction(async (file: string) => {
  return await readAndProcess(file);
});

const results = await processFiles.invokeAll(
  files,
  {
    onProgress: (progress) => {
      console.log(`Processing: ${progress.completed}/${progress.total} files`);
      console.log(`Rate: ${progress.rate} files/sec`);
      console.log(`ETA: ${Math.round(progress.estimatedTimeRemaining / 1000)}s`);
    }
  }
);
```

### Nested Progress (Advanced)
```typescript
const processFile = createAction(
  withContext(async (ctx, file: string) => {
    const chunks = await readFileChunks(file);
    ctx.setTotal(chunks.length);
    
    for (const chunk of chunks) {
      await processChunk(chunk);
      ctx.incrementProgress(`Processing chunk ${chunks.indexOf(chunk)}`);
    }
  })
);

const processBatch = createAction(
  withContext(async (ctx, files: string[]) => {
    ctx.setTotal(files.length);
    
    for (const file of files) {
      await processFile.invoke(file).data;
      ctx.incrementProgress(`Completed ${file}`);
    }
  })
).onProgress((progress) => {
  // Top-level progress across all files
  console.log(`Overall: ${progress.percentage}%`);
  console.log(`Current: ${progress.current}`);
});
```

### Real-Time Dashboard Updates
```typescript
const action = createAction(handler);

const stream = action.invokeStream(items, {
  onProgress: (progress) => {
    // Send to WebSocket for real-time dashboard
    websocket.send(JSON.stringify({
      type: 'progress',
      data: progress
    }));
  }
});

for await (const result of stream) {
  // Process results as they complete
}
```

### Progress with Cancellation
```typescript
const invocation = action.invoke(largeDataset, {
  onProgress: (progress) => {
    console.log(`Progress: ${progress.percentage}%`);
    
    // Cancel if taking too long
    if (progress.estimatedTimeRemaining > 60000) {  // >1 minute remaining
      invocation.cancel("Taking too long");
    }
  }
});
```

### Progress Event Logging
```typescript
const action = createAction(
  withContext(async (ctx, items) => {
    ctx.setTotal(items.length);
    
    for (const item of items) {
      await process(item);
      ctx.incrementProgress();
      ctx.attach('lastProcessed', item);
    }
  })
)
.onEvent((event) => {
  if (event.progress) {
    logger.info('Task completed', {
      actionId: event.actionId,
      completed: event.progress.completed,
      total: event.progress.total,
      rate: event.progress.rate,
      duration: event.duration
    });
  }
})
.onProgress((progress) => {
  // Real-time progress updates (during execution)
  logger.debug('Task progress', progress);
});
```

## Open Questions

1. **Should we support nested/hierarchical progress automatically?**
   Currently each action tracks its own progress independently. Automatic aggregation across nested actions would be complex but useful.
   
   **Recommendation**: Start without nested progress, add if strongly requested.

2. **Should progress updates be pausable?**
   ```typescript
   ctx.pauseProgress();   // Stop firing progress callbacks
   ctx.resumeProgress();  // Resume firing
   ```
   Useful for handlers that have long non-progress periods.
   
   **Recommendation**: Not needed for MVP. Handlers can control updates manually.

3. **Should we provide progress snapshots?**
   ```typescript
   const snapshot = invocation.getProgress();  // Get current progress without callback
   ```
   Useful for polling-based UIs.
   
   **Recommendation**: Nice-to-have, but callbacks are more efficient. Consider for v2.

4. **Should progress persist across retries?**
   Current design resets progress on retry. Alternative: accumulate progress across attempts (0/5 → 2/5 → [retry] → 2/5 → 5/5).
   
   **Recommendation**: Reset on retry (simpler, clearer semantics). Document clearly.

## Migration Path

Adding progress tracking is completely opt-in:
- Existing code without progress works unchanged
- No breaking changes to API
- Progress callbacks are optional
- Context methods (`setTotal`, `incrementProgress`) are no-ops if no callback registered
- New tests added alongside existing suites

**Zero breaking changes**: Actions without progress continue working exactly as before.

## Future Enhancements

1. **Nested/hierarchical progress**: Automatic aggregation across nested actions
2. **Progress snapshots**: Polling-based progress queries
3. **Progress persistence**: Save/restore progress for long-running jobs
4. **Progress checkpoints**: Resume from last checkpoint on failure
5. **Progress streams**: Stream progress updates via AsyncIterator
6. **Weighted progress**: Different items contribute different amounts to total progress

## Design Principles Alignment

✅ **Safe defaults**: No progress tracking unless explicitly enabled  
✅ **Composability**: Works seamlessly with retry, timeout, concurrency, cancellation  
✅ **Type safety**: Progress types fully typed, validated  
✅ **Observability first**: Rich progress metadata in events and callbacks  
✅ **Error isolation**: Progress callbacks don't affect handler execution  
✅ **Progressive enhancement**: Opt-in feature, zero breaking changes  

Progress tracking adds critical visibility for long-running operations while maintaining the library's philosophy of safe, observable, composable async execution.

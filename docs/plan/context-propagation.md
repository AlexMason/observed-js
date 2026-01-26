# Context Propagation (Nested Invocation Tracking)

## Purpose

Automatically establish parent-child relationships between nested action invocations, enabling distributed tracing-style observability without requiring manual context passing. When action A invokes action B during execution, B's events should automatically reference A as their parent.

## Motivation

In real-world applications, actions often call other actions:

```typescript
const fetchUser = createAction(async (userId: string) => {
    return await db.users.findById(userId);
});

const processOrder = createAction(async (orderId: string) => {
    const order = await db.orders.findById(orderId);
    const user = await fetchUser.invoke(order.userId).data;  // Nested invocation
    return { order, user };
});
```

Currently, these invocations are completely independent—there's no way to correlate `fetchUser`'s event with `processOrder`'s event. This makes debugging and tracing difficult:

- Which `fetchUser` call was triggered by which `processOrder`?
- How much of `processOrder`'s duration was spent in `fetchUser`?
- If `fetchUser` fails, which parent operation was affected?

## Requirements

### Functional Requirements

1. **Automatic Parent Detection**
   - When an action is invoked during another action's execution, automatically detect the parent
   - No explicit context passing or wrapping required
   - Works regardless of call depth (A → B → C → D)

2. **Event Correlation**
   - Child events include `parentActionId` referencing the parent invocation
   - Parent events include `childActionIds` array listing all child invocations
   - Support `traceId` that remains constant across entire call tree

3. **Nested Event Tree**
   - Parent events include full `children` array with complete child `WideEvent` objects
   - Enables single-listener observability without requiring event callbacks on every action
   - Tree is recursive—children contain their own children, etc.

4. **Span Timing**
   - Track when child execution started relative to parent
   - Enable calculation of "self time" vs "child time" in parent

4. **Attachment Inheritance (Optional)**
   - Child can optionally access parent's attachments
   - Child attachments do NOT propagate up by default (explicit merge required)

### Non-Functional Requirements

1. **Zero Overhead When Not Nested**
   - Single invocations should have negligible overhead
   - AsyncLocalStorage lookup is O(1)

2. **No API Changes Required**
   - Existing code automatically gains parent-child tracking
   - Opt-out available if needed

3. **Memory Safety**
   - Parent context should not prevent child garbage collection
   - No memory leaks from circular references

## API Design

### Automatic Context Propagation (Primary)

Context propagates automatically via `AsyncLocalStorage`:

```typescript
import { createAction, withContext } from "observed";

const childAction = createAction(
    withContext(async (ctx, itemId: string) => {
        ctx.attach("itemId", itemId);
        // ctx.parentActionId is automatically set if called from within another action
        return await fetchItem(itemId);
    })
).onEvent((event) => {
    console.log(event);
    // {
    //   actionId: "child-123",
    //   parentActionId: "parent-456",  // <-- Automatically set
    //   traceId: "trace-789",          // <-- Same as parent's traceId
    //   ...
    // }
});

const parentAction = createAction(
    withContext(async (ctx, userId: string) => {
        ctx.attach("userId", userId);
        
        // Child invocation automatically inherits context
        const item = await childAction.invoke("item-1").data;
        const item2 = await childAction.invoke("item-2").data;
        
        return { item, item2 };
    })
).onEvent((event) => {
    console.log(event);
    // {
    //   actionId: "parent-456",
    //   traceId: "trace-789",
    //   childActionIds: ["child-123", "child-124"],  // <-- Automatically populated
    //   childDuration: 150,  // <-- Total time spent in children
    //   children: [                                  // <-- Full nested event objects
    //     { actionId: "child-123", input: ["item-1"], output: {...}, ... },
    //     { actionId: "child-124", input: ["item-2"], output: {...}, ... }
    //   ],
    //   ...
    // }
});
```

### Nested Event Tree (Single Listener Observability)

The `children` field contains the full `WideEvent` objects for all child invocations, enabling complete observability from a single parent listener:

```typescript
// No need to add .onEvent() to every action—just listen at the top level
const processOrder = createAction(
    withContext(async (ctx, orderId: string) => {
        const order = await fetchOrder.invoke(orderId).data;
        const user = await fetchUser.invoke(order.userId).data;
        const items = await fetchItems.invokeAll(order.itemIds.map(id => [id]));
        return { order, user, items };
    })
).onEvent((event) => {
    // Single listener captures EVERYTHING that happened
    logger.info("order.processed", {
        orderId: event.input[0],
        duration: event.duration,
        selfDuration: event.selfDuration,
        // Full tree of child events available for inspection
        children: event.children,
        // Recursively contains grandchildren, etc.
    });
    
    // Walk the tree for custom analysis
    function countEvents(e: WideEvent<any[], any>): number {
        return 1 + (e.children?.reduce((sum, c) => sum + countEvents(c), 0) ?? 0);
    }
    console.log(`Total operations: ${countEvents(event)}`);
});
```

This enables several observability patterns:

1. **Single-point logging** — Listen only on entry-point actions, get full visibility
2. **Tree analysis** — Calculate aggregate metrics across the call tree
3. **Selective detail** — Log summary at parent level, full tree only on errors
4. **Export to external systems** — Ship entire trace trees to logging infrastructure

```typescript
// Log full tree only on failure
.onEvent((event) => {
    if (event.error) {
        // Include full child tree for debugging
        errorLogger.error("operation.failed", event);
    } else {
        // Just summary for successful operations
        logger.info("operation.success", {
            actionId: event.actionId,
            duration: event.duration,
            childCount: event.children?.length ?? 0
        });
    }
});
```

### Accessing Parent Context

Child handlers can access the full parent chain by traversing `ctx.parent`:

```typescript
const grandchildAction = createAction(
    withContext(async (ctx, itemId: string) => {
        // Access immediate parent's attachments (read-only)
        const parentUserId = ctx.parent?.attachments.userId;
        
        // Traverse up the full chain to access any ancestor
        const grandparentTenant = ctx.parent?.parent?.attachments.tenantId;
        
        // Helper to collect all ancestor attachments
        function getAncestorAttachments(context: typeof ctx): Record<string, unknown>[] {
            const chain: Record<string, unknown>[] = [];
            let current = context.parent;
            while (current) {
                chain.push(current.attachments);
                current = current.parent;
            }
            return chain;
        }
        
        // Check nesting depth
        console.log(`Depth: ${ctx.depth}`);  // 0 = root, 1 = first child, etc.
        
        // Access trace ID (same across entire tree)
        console.log(`Trace: ${ctx.traceId}`);
        
        return await fetchItem(itemId);
    })
);
```

### Opting Out of Propagation

Sometimes you want a "fresh" context that doesn't inherit:

```typescript
const isolatedAction = createAction(
    withContext(async (ctx, data: string) => {
        // This action creates a new trace, not linked to parent
        return process(data);
    })
).setContextPropagation(false);  // Opt-out

// Alternative: per-invocation opt-out
await action.invoke(data, { isolated: true }).data;
```

### External Trace Integration

Support injecting external trace context (e.g., from HTTP headers):

```typescript
// Inject trace context from incoming request
const result = await action.invoke(data, {
    traceContext: {
        traceId: req.headers['x-trace-id'],
        parentSpanId: req.headers['x-span-id']
    }
}).data;
```

## Extended WideEvent Type

```typescript
interface WideEvent<I extends any[], O> {
    // Existing fields...
    actionId: string;
    startedAt: number;
    completedAt: number;
    duration: number;
    input: I;
    output?: O;
    error?: Error;
    attachments: Record<string, unknown>;
    
    // New context propagation fields
    /** Trace ID - constant across entire call tree */
    traceId: string;
    
    /** Parent action ID (undefined if root invocation) */
    parentActionId?: string;
    
    /** Depth in call tree (0 = root) */
    depth: number;
    
    /** Child action IDs invoked during this execution */
    childActionIds?: string[];
    
    /** 
     * Full child event objects (nested tree structure).
     * Enables full observability from a single parent listener.
     */
    children?: WideEvent<any[], any>[];
    
    /** Total duration spent in child invocations (ms) */
    childDuration?: number;
    
    /** Self duration = duration - childDuration */
    selfDuration?: number;
    
    /** Span ID for distributed tracing integration */
    spanId?: string;
    
    /** Batch ID for grouping invokeAll/invokeStream items */
    batchId?: string;
}
```

## Extended InvocationContext Type

```typescript
interface InvocationContext {
    // Existing fields...
    readonly actionId: string;
    attach(key: string, value: unknown): void;
    attach(data: Record<string, unknown>): void;
    
    // New propagation fields
    /** Trace ID for this invocation tree */
    readonly traceId: string;
    
    /** Depth in call tree (0 = root) */
    readonly depth: number;
    
    /** Parent context (if nested invocation) */
    readonly parent?: ParentContext;
    
    /** Register a child invocation (called automatically) */
    registerChild(childActionId: string, startTime: number): void;
    
    /** Mark child completion (called automatically) */
    completeChild(childActionId: string, endTime: number): void;
}

interface ParentContext {
    /** Parent's action ID */
    readonly actionId: string;
    
    /** Parent's attachments (read-only snapshot) */
    readonly attachments: Readonly<Record<string, unknown>>;
    
    /** Parent's trace ID */
    readonly traceId: string;
    
    /** Parent's depth in the call tree */
    readonly depth: number;
    
    /** Grandparent context (for traversing full chain) */
    readonly parent?: ParentContext;
}
```

## Architecture

### Component Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        AsyncLocalStorage                         │
│                    (PropagationContext store)                    │
└─────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│                       ActionBuilder.invoke()                     │
│                                                                  │
│  1. Check AsyncLocalStorage for parent context                   │
│  2. Create new PropagationContext (inherits traceId or new)      │
│  3. Run handler within AsyncLocalStorage.run(context, ...)       │
│  4. On child invoke: parent.registerChild() called automatically │
│  5. On completion: emit WideEvent with propagation fields        │
└─────────────────────────────────────────────────────────────────┘
```

### New Internal Types

```typescript
/**
 * Internal context stored in AsyncLocalStorage
 */
interface PropagationContext {
    /** Trace ID for entire tree */
    traceId: string;
    
    /** Current action ID */
    actionId: string;
    
    /** Depth in tree */
    depth: number;
    
    /** Reference to InvocationContextImpl for child registration */
    invocationContext: InvocationContextImpl;
    
    /** Parent propagation context (for accessing parent attachments) */
    parent?: PropagationContext;
}

/**
 * Global AsyncLocalStorage instance
 */
const propagationStore = new AsyncLocalStorage<PropagationContext>();
```

### Execution Flow

```
Parent invoke("user-1")
    │
    ├── Check propagationStore.getStore() → undefined (root)
    │
    ├── Create PropagationContext {
    │       traceId: "trace-new-uuid",
    │       actionId: "parent-uuid",
    │       depth: 0
    │   }
    │
    ├── propagationStore.run(context, async () => {
    │       │
    │       │   // Handler execution
    │       │   await childAction.invoke("item-1").data
    │       │       │
    │       │       ├── Check propagationStore.getStore() → parent context!
    │       │       │
    │       │       ├── Create child PropagationContext {
    │       │       │       traceId: "trace-new-uuid",  // inherited
    │       │       │       actionId: "child-uuid",
    │       │       │       depth: 1,
    │       │       │       parent: parentContext
    │       │       │   }
    │       │       │
    │       │       ├── parent.invocationContext.registerChild("child-uuid")
    │       │       │
    │       │       ├── propagationStore.run(childContext, handler)
    │       │       │
    │       │       └── parent.invocationContext.completeChild("child-uuid")
    │       │
    │       └── return result
    │   })
    │
    └── Emit WideEvent with childActionIds, childDuration, etc.
```

## Implementation Plan

### Phase 1: Core Infrastructure

1. **Add AsyncLocalStorage instance** (`src/propagation.ts`)
   ```typescript
   import { AsyncLocalStorage } from 'async_hooks';
   
   export interface PropagationContext { ... }
   export const propagationStore = new AsyncLocalStorage<PropagationContext>();
   export function getCurrentContext(): PropagationContext | undefined;
   export function runWithContext<T>(ctx: PropagationContext, fn: () => T): T;
   ```

2. **Extend InvocationContextImpl**
   - Add `traceId`, `depth`, `parent` properties
   - Add `registerChild()` and `completeChild()` methods
   - Track child invocation times for duration calculation

3. **Modify ActionBuilder.invoke()**
   - Check for parent context via `propagationStore.getStore()`
   - Create new `PropagationContext` with inherited/new traceId
   - Wrap handler execution in `propagationStore.run()`
   - Register with parent context if nested

### Phase 2: Event Enhancement

1. **Extend WideEvent type**
   - Add `traceId`, `parentActionId`, `depth`
   - Add `childActionIds`, `childDuration`, `selfDuration`

2. **Update event emission**
   - Populate new fields from `InvocationContextImpl`
   - Calculate `selfDuration = duration - childDuration`

### Phase 3: API Surface

1. **Extend InvocationContext interface**
   - Expose `traceId`, `depth`, `parent` as readonly
   - Parent attachments available via `ctx.parent?.attachments`

2. **Add opt-out mechanism**
   - `setContextPropagation(false)` on ActionBuilder
   - `{ isolated: true }` in InvokeOptions

3. **Add external trace injection**
   - `{ traceContext: { traceId, parentSpanId } }` in InvokeOptions

### Phase 4: Testing & Documentation

1. **Unit tests**
   - Nested invocation tracking
   - Deep nesting (3+ levels)
   - Concurrent nested invocations
   - Isolated invocations
   - External trace injection
   - Memory leak verification

2. **Examples**
   - `examples/14-context-propagation.ts`
   - Real-world nested operation scenario

## Edge Cases & Considerations

### Concurrent Children

When a parent spawns multiple children concurrently:

```typescript
const parent = createAction(withContext(async (ctx, ids: string[]) => {
    // All three run concurrently
    const results = await Promise.all(
        ids.map(id => childAction.invoke(id).data)
    );
    return results;
}));
```

All children should correctly reference the same parent. Since each child gets its own `PropagationContext` but shares the same `parent` reference, this works naturally.

### Recursive Actions

An action that calls itself:

```typescript
const factorial = createAction(withContext(async (ctx, n: number) => {
    if (n <= 1) return 1;
    return n * await factorial.invoke(n - 1).data;
}));
```

This should work correctly, with each recursive call incrementing depth and maintaining the same traceId.

### Cross-Scheduler Invocations

Different actions may use different schedulers. Context should propagate regardless of scheduler boundaries since `AsyncLocalStorage` tracks by async execution context, not by scheduler.

### Batch Operations

For `invokeAll()` and `invokeStream()`:

```typescript
const parent = createAction(withContext(async (ctx, userId: string) => {
    // Batch of children
    const results = await childAction.invokeAll([
        ["item-1"],
        ["item-2"],
        ["item-3"]
    ]);
    return results;
}));
```

Each batch item is a separate child with its own `actionId`, all sharing:
- The same `parentActionId` (the parent invocation)
- The same `traceId` (the trace root)
- The same `batchId` (unique to this `invokeAll` call)

The `batchId` allows grouping related batch items in logs:

```typescript
// All three events will have the same batchId
// {
//   actionId: "child-1",
//   parentActionId: "parent-xyz",
//   batchId: "batch-abc",
//   ...
// }
```

### Error in Child

If a child throws, the parent should still record the child invocation:

```typescript
// Parent event should include child-123 in childActionIds
// even though child-123 failed
```

### Memory Management

The `PropagationContext` holds references to parent contexts. To prevent memory leaks:

1. Only store parent reference during active execution
2. Clear parent reference when child completes
3. Parent's `attachments` snapshot is a shallow copy, not a live reference

### Non-Action Async Operations

Context should persist across normal async operations:

```typescript
const action = createAction(withContext(async (ctx) => {
    await someNonObservedAsyncWork();
    
    // Child should still see parent context
    await childAction.invoke(data).data;
}));
```

This works because `AsyncLocalStorage` maintains context across all async operations in the same execution flow.

## Alternative Approaches Considered

### Manual Context Passing

```typescript
const childAction = createAction(async (ctx: Context, itemId: string) => {
    // Requires explicit ctx passing everywhere
});

const parentAction = createAction(async (ctx: Context, userId: string) => {
    await childAction.invoke(ctx, "item-1").data;  // Must pass ctx
});
```

**Rejected because:** Requires changing all handler signatures and invocation sites. Breaks the "no weird wrapping" requirement.

### Global Context Stack

```typescript
// Push/pop context manually
observed.pushContext({ traceId });
try {
    await action.invoke(data).data;
} finally {
    observed.popContext();
}
```

**Rejected because:** Error-prone, requires manual management, doesn't integrate with async/await naturally.

### Decorator Pattern

```typescript
@traced
class MyActions {
    @action
    async fetchUser(userId: string) { ... }
}
```

**Rejected because:** Requires class-based approach, doesn't fit functional style of library.

## Design Decisions

1. **Attachments do NOT propagate down by default**
   - Child must explicitly access via `ctx.parent?.attachments`
   - Full parent chain is traversable: `ctx.parent?.parent?.attachments` etc.
   - This keeps behavior explicit and avoids confusion about data origin

2. **`invokeAll` items share a batch ID**
   - All items from the same `invokeAll()` or `invokeStream()` call share a `batchId`
   - Useful for understanding batch boundaries in logs and grouping related work
   - `batchId` is a UUID generated per batch call

3. **OpenTelemetry integration is OUT OF SCOPE**
   - This library has zero third-party dependencies by design
   - OTel integration could be a separate addon package (`observed-otel`)
   - The architecture exposes enough hooks (`traceId`, `spanId`, `parentActionId`) for users to integrate manually

4. **Context size warning threshold**
   - Configurable warning threshold for attachment size
   - Non-throwing warning emitted when threshold exceeded
   - Helps catch memory issues with deep nesting without breaking execution

## Context Size Limits

To prevent memory issues with deep nesting or large attachments, a configurable warning threshold is available:

```typescript
import { setContextWarningThreshold } from "observed";

// Warn if total attachment size exceeds 100KB (default: no limit)
setContextWarningThreshold({
    maxAttachmentBytes: 100 * 1024,
    maxDepth: 50,
    onWarning: (warning) => {
        console.warn(`Context warning: ${warning.message}`, {
            actionId: warning.actionId,
            currentSize: warning.currentSize,
            threshold: warning.threshold,
            depth: warning.depth
        });
    }
});

// Per-action override
const action = createAction(handler)
    .setContextWarningThreshold({ maxAttachmentBytes: 50 * 1024 });
```

### Warning Types

```typescript
interface ContextWarning {
    type: 'attachment-size' | 'depth';
    message: string;
    actionId: string;
    traceId: string;
    currentSize?: number;  // bytes, for attachment-size warnings
    threshold: number;
    depth: number;
}

interface ContextWarningOptions {
    /** Max total attachment size in bytes before warning */
    maxAttachmentBytes?: number;
    
    /** Max nesting depth before warning */
    maxDepth?: number;
    
    /** Custom warning handler (default: console.warn) */
    onWarning?: (warning: ContextWarning) => void;
}
```

**Behavior:**
- Warnings are non-throwing—execution continues normally
- Default handler logs to `console.warn`
- Size is estimated via `JSON.stringify` (cheap approximation)
- Warnings are emitted at most once per threshold breach per invocation

## Success Metrics

1. **Automatic correlation** - 100% of nested invocations correctly linked
2. **Zero explicit passing** - No code changes required for basic correlation
3. **Performance** - <1% overhead for non-nested invocations
4. **Memory stability** - No memory growth with deep nesting after completion

## References

- [Node.js AsyncLocalStorage](https://nodejs.org/api/async_context.html)
- [W3C Trace Context](https://www.w3.org/TR/trace-context/)

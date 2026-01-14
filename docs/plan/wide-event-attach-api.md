# Wide Event Logging: Attach API

## Feature Overview

Enable **wide event logging** by exposing an `attach` API that allows users to join contextual data to an invocation during execution. This data can then be collected and logged on their side, supporting rich, structured observability.

## Motivation

Wide events are the core intention of `observed`. Rather than scattered log lines, wide events capture everything relevant to an operation in a single, structured record:

- Request metadata (actionId, timestamps, duration)
- Input payload
- Output result or error
- **User-attached context** (the focus of this feature)

The attach API enables users to progressively build context throughout handler execution—database query timings, external API responses, business logic decisions—all correlated to one invocation.

## Requirements

### Functional Requirements

1. **Context Object Injection**
   - Handler receives a context object as an additional parameter
   - Context provides an `attach(key, value)` method for joining data
   - Attachments accumulate throughout handler execution

2. **Event Collection**
   - After invocation completes, users can access the complete wide event
   - Wide event includes: actionId, input, output/error, duration, and all attachments
   - Support both success and error scenarios

3. **Event Subscription**
   - Users can register a callback to receive wide events
   - Callback fires after each invocation completes
   - Single point for logging/observability integration

4. **Type Safety**
   - Attachments should support typed keys where possible
   - Consider both loose (any key/value) and strict (predefined schema) modes

### Non-Functional Requirements

1. **Zero Overhead When Unused**
   - If no event subscriber is registered, minimal performance impact
   - Attachments should be cheap to create and store

2. **Non-Blocking**
   - Event callbacks should not block handler completion
   - Consider async callbacks for slow logging destinations

3. **Error Isolation**
   - Errors in attach() or event callbacks should not affect handler execution
   - Graceful degradation for observability failures

## API Design

### Option A: Context Parameter (Recommended)

```typescript
const action = createAction(async (ctx, userId: string, limit: number) => {
    ctx.attach("userId", userId);
    
    const user = await db.findUser(userId);
    ctx.attach("userTier", user.tier);
    
    const items = await fetchItems(limit);
    ctx.attach("itemCount", items.length);
    
    return items;
})
.onEvent((event) => {
    logger.info("action.completed", event);
    // event = {
    //   actionId: "abc-123",
    //   duration: 142,
    //   input: ["user-456", 50],
    //   output: [...items],
    //   attachments: {
    //     userId: "user-456",
    //     userTier: "premium",
    //     itemCount: 25
    //   }
    // }
});

const { actionId, data, eventLogged } = action.invoke("user-456", 50);
const result = await data;
// Optionally await logging: await eventLogged;
```

**Pros:**
- Explicit context parameter, easy to understand
- Context is always available in handler scope
- Natural fit for dependency injection patterns

**Cons:**
- Changes handler signature (first param is always context)
- Existing handlers need modification

### Option B: Async Context (Implicit)

```typescript
import { attach } from "observed";

const action = createAction(async (userId: string, limit: number) => {
    attach("userId", userId);  // Uses AsyncLocalStorage under the hood
    
    const user = await db.findUser(userId);
    attach("userTier", user.tier);
    
    return fetchItems(limit);
})
.onEvent((event) => {
    logger.info("action.completed", event);
});
```

**Pros:**
- Handler signature unchanged
- Can attach from nested functions without passing context

**Cons:**
- Magic implicit context (harder to reason about)
- AsyncLocalStorage has edge cases
- Harder to test in isolation

### Option C: Fluent Return Style

```typescript
const action = createAction(async (userId: string) => {
    const user = await db.findUser(userId);
    return {
        result: user,
        attachments: { foundInCache: false, queryMs: 42 }
    };
});
```

**Pros:**
- Pure functions, no context mutation
- Easy to test

**Cons:**
- Awkward return type wrapping
- Can't attach progressively during execution

## Recommended Approach: Option A with Opt-in

Use explicit context parameter, but make it **opt-in** to avoid breaking existing handlers:

```typescript
// New style with context (wide events enabled)
const action = createAction({ 
    handler: async (ctx, userId: string) => {
        ctx.attach("key", "value");
        return result;
    },
    // Optional: define expected attachment schema
    schema: {
        userId: "string",
        queryMs: "number"
    }
});

// Legacy style still works (no wide events)
const legacyAction = createAction(async (userId: string) => {
    return result;
});
```

Alternatively, detect context usage via a wrapper:

```typescript
// withContext wrapper explicitly opts into wide events
const action = createAction(
    withContext(async (ctx, userId: string) => {
        ctx.attach("key", "value");
        return result;
    })
);
```

## Architecture

### Component Overview

```
ActionBuilder
    ├── Handler (user function)
    ├── ExecutionScheduler (concurrency/rate limiting)
    └── EventEmitter (NEW - wide event collection)
            ↓
    InvocationContext (NEW - per-invocation state)
            ↓
    WideEvent (NEW - final structured record)
```

### New Types

```typescript
/**
 * Context object passed to handlers for attaching data
 */
interface InvocationContext {
    /** Unique identifier for this invocation */
    readonly actionId: string;
    
    /** 
     * Attach data to this invocation's wide event
     * Supports both primitives and objects (objects are deep-merged)
     * 
     * @example
     * ctx.attach("userId", "abc-123");
     * ctx.attach("db", { queryMs: 42, rows: 10 });
     * ctx.attach("cache.hit", true);
     */
    attach(key: string, value: unknown): void;
    attach(data: Record<string, unknown>): void;  // Overload for object-only
}

/**
 * Complete wide event record after invocation completes
 */
interface WideEvent<I, O> {
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
}

/**
 * Callback for receiving wide events
 */
type EventCallback<I, O> = (event: WideEvent<I, O>) => void | Promise<void>;

/**
 * Result returned from action invocation
 */
type ActionResult<O> = {
    actionId: string;
    data: Promise<O>;
    eventLogged: Promise<void>;  // Resolves when event callback completes (if registered)
};
```

### Implementation Flow

1. **Invocation starts:**
   - Create `InvocationContext` with unique actionId
   - Initialize empty attachments map
   - Record start timestamp

2. **Handler executes:**
   - Context passed as first parameter
   - User calls `ctx.attach()` to add data
   - Attachments accumulated in context

3. **Handler completes:**
   - Record end timestamp, calculate duration
   - Capture output or error
   - Construct `WideEvent` from context + results

4. **Event dispatch:**
   - Call registered event callbacks with wide event
   - Callbacks run asynchronously and can be awaited via `eventLogged` promise
   - If not awaited, callbacks continue in background (durable)
   - Errors in callbacks are caught, logged, and don't propagate to handler

## Design Decisions ✓

### 1. Context Parameter Position: **First** ✓
- Context will always be the **first parameter** of the handler
- Consistent, predictable position
- Clear separation from user arguments

### 2. Method Naming: **attach** ✓
- Use `ctx.attach(key, value)` for joining data
- Best conveys the intent of associating data with this invocation

### 3. Nested Attachments: **Support Objects** ✓
- `attach()` accepts both primitives and objects
- Objects are deep-merged into attachments
- Supports both styles:
  ```typescript
  ctx.attach("db.queryMs", 42);  // Flat key with dot notation
  ctx.attach("db", { queryMs: 42, rows: 10 });  // Nested object
  ```

### 4. Async Callbacks: **Awaitable but Durable** ✓
- Event callbacks can be async and are awaitable
- If not awaited, callbacks run in background (fire-and-forget)
- Errors in callbacks are isolated and won't crash the system
- Implementation:
  ```typescript
  // Option 1: Fire-and-forget (doesn't block action return)
  const { actionId, data, eventLogged } = action.invoke("arg");
  const result = await data;
  
  // Option 2: Wait for events to finish (blocks until logged)
  const { actionId, data, eventLogged } = action.invoke("arg");
  const result = await data;
  await eventLogged;  // Optional: wait for event callback completion
  ```

## Implementation Plan

### Phase 1: Core Types and Context

1. Define `InvocationContext`, `WideEvent`, `EventCallback` types
2. Implement `InvocationContext` class with attach methods
3. Add `onEvent()` method to ActionBuilder
4. Store event callbacks in ActionBuilder

### Phase 2: Handler Integration

1. Create `withContext()` wrapper function for opt-in
2. Modify invoke/invokeAll/invokeStream to:
   - Create context before handler execution
   - Pass context to handler (if wrapped)
   - Collect timing and result data
3. Construct and emit WideEvent after completion

### Phase 3: Batch Support

1. Ensure each batch item gets its own context
2. Events emitted individually as items complete
3. Consider batch-level events (summary of all items)

### Phase 4: Error Handling & Edge Cases

1. Handle errors in attach() gracefully
2. Isolate event callback errors
3. Handle async callback queueing
4. Test memory behavior for long-running actions

### Phase 5: Advanced Features (Future)

1. Typed attachment schemas
2. Nested span/child context support
3. Sampling configuration
4. Export to OpenTelemetry format

## Design Decisions ✓

### 1. Context Parameter Position: **First** ✓
- Context will always be the **first parameter** of the handler
- Consistent, predictable position
- Clear separation from user arguments

### 2. Method Naming: **attach** ✓
- Use `ctx.attach(key, value)` for joining data
- Best conveys the intent of associating data with this invocation

### 3. Nested Attachments: **Support Objects** ✓
- `attach()` accepts both primitives and objects
- Objects are deep-merged into attachments
- Supports both styles:
  ```typescript
  ctx.attach("db.queryMs", 42);  // Flat key with dot notation
  ctx.attach("db", { queryMs: 42, rows: 10 });  // Nested object
  ```

### 4. Async Callbacks: **Awaitable but Durable** ✓
- Event callbacks can be async and are awaitable
- If not awaited, callbacks run in background (fire-and-forget)
- Errors in callbacks are isolated and won't crash the system
- Implementation:
  ```typescript
  // Option 1: Fire-and-forget (doesn't block action return)
  const { actionId, data, eventLogged } = action.invoke("arg");
  const result = await data;
  // eventLogged continues in background
  
  // Option 2: Wait for events to finish (blocks until logged)
  const { actionId, data, eventLogged } = action.invoke("arg");
  const result = await data;
  await eventLogged;  // Wait for event callback completion
  ```

## Example Usage Scenarios

### Basic Logging

```typescript
const fetchUser = createAction(
    withContext(async (ctx, userId: string) => {
        const start = Date.now();
        const user = await db.users.findById(userId);
        ctx.attach("dbQueryMs", Date.now() - start);
        ctx.attach("userFound", !!user);
        return user;
    })
).onEvent((event) => {
    console.log(JSON.stringify(event));
});
```

### Error Context

```typescript
const processOrder = createAction(
    withContext(async (ctx, orderId: string) => {
        ctx.attach("orderId", orderId);
        
        const order = await getOrder(orderId);
        ctx.attach("orderTotal", order.total);
        ctx.attach("itemCount", order.items.length);
        
        if (order.total > 10000) {
            ctx.attach("requiresApproval", true);
            throw new Error("Order requires manual approval");
        }
        
        return await submitOrder(order);
    })
).onEvent((event) => {
    // Error events include all attachments made before failure
    if (event.error) {
        alerting.send("order.failed", event);
    }
});
```

### Correlation with External Systems

```typescript
const callExternalApi = createAction(
    withContext(async (ctx, request: ApiRequest) => {
        // Attach trace IDs for correlation
        ctx.attach("traceId", request.traceId);
        ctx.attach("spanId", crypto.randomUUID());
        
        const response = await fetch(apiUrl, { body: request });
        
        ctx.attach("responseStatus", response.status);
        ctx.attach("responseTimeMs", response.timing);
        
        return response.json();
    })
).onEvent(async (event) => {
    // Send to observability platform
    await datadog.submitEvent(event);
});
```

## Success Criteria

1. Users can attach arbitrary data during handler execution
2. Complete wide events are accessible after invocation
3. Zero performance impact when events are not subscribed
4. Errors in logging don't affect business logic
5. Works correctly with concurrency and rate limiting
6. Clear documentation and examples

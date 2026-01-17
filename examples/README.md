# Examples

This directory contains bite-sized examples demonstrating various features and use cases of the `observed` library. Each example is self-contained and can be run independently.

## Running Examples

```bash
# Run any example with tsx
npx tsx examples/01-basic-action.ts

# Or run all examples at once
npx tsx examples/run-all.ts

# Or use Node.js directly (after building)
npm run build
node examples/01-basic-action.ts
```

## Example Index

### Fundamentals

- **[01-basic-action.ts](01-basic-action.ts)** - Creating and invoking actions with type inference
- **[02-concurrency.ts](02-concurrency.ts)** - Controlling parallel execution with `.setConcurrency()`
- **[03-rate-limiting.ts](03-rate-limiting.ts)** - Throttling execution with `.setRateLimit()`
- **[04-wide-events.ts](04-wide-events.ts)** - Capturing rich context with `InvocationContext` and `.attach()`
- **[05-batch-invocation.ts](05-batch-invocation.ts)** - Batch processing with `.invokeAll()` and `.invokeStream()`

### Advanced Features

- **[06-combining-features.ts](06-combining-features.ts)** - Combining concurrency, rate limiting, retry, and events
- **[08-error-handling.ts](08-error-handling.ts)** - Error propagation, typed errors, and batch error handling
- **[09-retry-examples.ts](09-retry-examples.ts)** - Retry strategies with backoff and selective retry
- **[13-priority.ts](13-priority.ts)** - Priority overrides with `.setPriority()` and per-invoke `{ priority }`

### Real-World Use Cases

- **[07-real-world-scenarios.ts](07-real-world-scenarios.ts)** - Production scenarios:
  - Image processing service
  - Email campaign sender
  - Webhook delivery system

## Quick Reference

### Basic Action Creation

```typescript
import { createAction } from "observed";

const fetchUser = createAction(async (userId: string) => {
    // Your async logic here
    return { userId, name: "John" };
});

const { actionId, data } = fetchUser.invoke("user-123");
const result = await data;
```

### Concurrency Control

```typescript
const action = createAction(handler)
    .setConcurrency(5);  // Max 5 parallel executions
```

### Rate Limiting

```typescript
const action = createAction(handler)
    .setRateLimit(10);  // Max 10 executions per second
```

### Wide Events & Context

```typescript
import { createAction, withContext } from "observed";

const action = createAction(
    withContext(async (ctx, input) => {
        ctx.attach("key", "value");           // Single attachment
        ctx.attach({ key1: "a", key2: "b" }); // Bulk attachment
        return result;
    })
).onEvent((event) => {
    console.log(event.attachments); // Access all attached data
});
```

### Retry with Backoff

```typescript
const action = createAction(handler)
    .setRetry({
        maxRetries: 3,
        backoff: 'exponential',
        baseDelay: 100,
        jitter: true
    });
```

### Batch Processing

```typescript
// Promise.all style - results in order
const results = await action.invokeAll([input1, input2, input3]);

// Stream style - results as they complete
for await (const result of action.invokeStream([input1, input2, input3])) {
    if (result.data) {
        console.log(result.data);
    }
}
```

## Design Patterns

### Resilient API Client

Combine multiple features for production-ready API clients:

```typescript
const apiClient = createAction(withContext(async (ctx, endpoint) => {
    ctx.attach("endpoint", endpoint);
    // ... implementation
}))
.setConcurrency(5)       // Limit parallel requests
.setRateLimit(20)        // Respect rate limits
.setRetry({              // Handle transient failures
    maxRetries: 3,
    backoff: 'exponential',
    shouldRetry: (error) => error.statusCode >= 500
})
.onEvent((event) => {    // Comprehensive logging
    logger.log(event);
});
```

### Batch Processor

Process large datasets efficiently:

```typescript
const processor = createAction(withContext(async (ctx, batch) => {
    ctx.attach("batchSize", batch.length);
    // ... process batch
}))
.setConcurrency(3)       // Process batches in parallel
.setRateLimit(10);       // Control throughput

for await (const result of processor.invokeStream(batches)) {
    // Handle results as they complete
}
```

## Key Concepts

### Type Inference

Actions automatically infer input and output types from your handler function. No need to manually specify generics:

```typescript
// Types are automatically inferred
const action = createAction(async (userId: string, limit: number) => {
    return { userId, items: [] };
});

// ✓ Type-safe invocation
action.invoke("user-123", 50);
```

### Event Isolation

Errors in `.onEvent()` callbacks are isolated and won't break your action:

```typescript
const action = createAction(handler).onEvent((event) => {
    throw new Error("Callback error");  // Logged but isolated
});

const result = await action.invoke(input).data;  // Still succeeds
```

### Batch Error Handling

Individual failures don't break the entire batch:

```typescript
const results = await action.invokeAll([input1, input2, input3]);

results.forEach((result) => {
    if (result.data) {
        // Handle success
    } else if (result.error) {
        // Handle failure
    }
});
```

## Next Steps

After exploring these examples:

1. Check the [main README](../README.md) for full API documentation
2. Review [planning docs](../docs/plan/) for design rationale
3. Explore the [test suite](../src/tests/) for comprehensive behavior examples
4. Build your own actions for your specific use cases

## Contributing

When adding new examples:

- Keep them focused on a single concept or use case
- Include comments explaining the "why" behind the code
- Show both the setup and the output/results
- Use realistic scenarios when possible
- Follow the existing naming convention: `##-descriptive-name.ts`

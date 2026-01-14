# observed

**Enterprise-ready action scheduling with concurrency, rate limiting, and wide event observability**

`observed` is a TypeScript library for controlled execution of async operations with first-class support for structured logging and observability. Built on a fluent API, it enables precise control over concurrency, rate limiting, retries, and rich event capture—all with automatic type inference.

## Features

- 🎯 **Fluent Builder API** - Chain configuration methods with full type inference
- 🔄 **Concurrency Control** - Limit parallel execution to manage resource usage
- ⏱️ **Rate Limiting** - Sliding window algorithm for precise throttling
- 🔁 **Automatic Retry** - Configurable backoff strategies (linear/exponential) with jitter
- 📊 **Wide Events** - Capture rich, structured context for every invocation
- 📦 **Batch Operations** - Process multiple items with `invokeAll()` or stream results with `invokeStream()`
- 💪 **Type Safe** - Full TypeScript support with automatic type inference from handlers
- 🪶 **Zero Dependencies** - Lightweight and focused

## Installation

```bash
npm install observed
```

## Quick Start

```typescript
import { createAction } from "observed";

// Create an action with automatic type inference
const fetchUser = createAction(async (userId: string) => {
    const response = await fetch(`/api/users/${userId}`);
    return response.json();
})
.setConcurrency(5)      // Max 5 parallel requests
.setRateLimit(10)       // Max 10 requests/second
.setRetry({             // Retry on failure
    maxRetries: 3,
    backoff: 'exponential',
    baseDelay: 100
});

// Invoke the action
const { actionId, data } = fetchUser.invoke("user-123");
const user = await data;  // Type-safe result
```

## Core Concepts

### Actions

Actions are created using `createAction()` with an async handler function. The library automatically infers input and output types:

```typescript
const processImage = createAction(async (imageUrl: string, width: number) => {
    // Process the image...
    return { url: processedUrl, dimensions: { width, height } };
});

// TypeScript knows the exact input and output types
const result = await processImage.invoke("image.jpg", 800).data;
// result is typed as { url: string, dimensions: { width: number, height: number } }
```

### Concurrency Control

Limit how many operations run in parallel:

```typescript
const action = createAction(handler)
    .setConcurrency(3);  // Max 3 concurrent executions
```

Default is **1** (sequential execution) for safe-by-default behavior.

### Rate Limiting

Control execution rate using a sliding window algorithm:

```typescript
const action = createAction(handler)
    .setRateLimit(100);  // Max 100 executions per second
```

Tasks exceeding the limit are automatically queued and executed when the window allows.

### Retry with Backoff

Automatically retry failed operations with configurable strategies:

```typescript
const action = createAction(handler)
    .setRetry({
        maxRetries: 3,              // Number of retry attempts
        backoff: 'exponential',     // 'linear' or 'exponential'
        baseDelay: 100,             // Base delay in ms
        maxDelay: 10000,            // Cap for exponential growth
        jitter: true,               // Add randomness to prevent thundering herd
        shouldRetry: (error) => {   // Optional: selective retry
            return error instanceof NetworkError;
        }
    });
```

**Backoff strategies:**
- **Linear**: `baseDelay * attemptNumber`
- **Exponential**: `baseDelay * 2^(attemptNumber - 1)` (capped at `maxDelay`)
- **Jitter**: Multiplies delay by random factor (0.5 to 1.0) when enabled

### Wide Events

Capture rich, structured context for observability:

```typescript
import { createAction, withContext } from "observed";

const dbQuery = createAction(
    withContext(async (ctx, userId: string) => {
        ctx.attach("userId", userId);
        ctx.attach("operation", "SELECT");
        
        const result = await database.query(`SELECT * FROM users WHERE id = ?`, [userId]);
        
        ctx.attach("rowsReturned", result.length);
        ctx.attach("queryDurationMs", result.duration);
        
        return result;
    })
).onEvent((event) => {
    logger.info({
        actionId: event.actionId,
        input: event.input,
        output: event.output,
        duration: event.duration,
        attachments: event.attachments,  // All attached context
        error: event.error
    });
});
```

**Context features:**
- `.attach(key, value)` for single key-value pairs
- `.attach(object)` for bulk attachment
- Objects are deep-merged when attaching to the same key
- Primitives overwrite previous values

### Batch Operations

Process multiple items with two different patterns:

#### `invokeAll()` - Promise.all style

Returns all results in input order (using Promise.allSettled internally):

```typescript
const action = createAction(handler);

const results = await action.invokeAll([
    ["input1"],
    ["input2"],
    ["input3"]
]);

// Each result is a discriminated union
results.forEach((result, index) => {
    if (result.error) {
        console.error(`Item ${index} failed:`, result.error);
    } else {
        console.log(`Item ${index} succeeded:`, result.data);
    }
});
```

#### `invokeStream()` - AsyncGenerator

Yields results as they complete (out-of-order):

```typescript
const action = createAction(handler).setConcurrency(5);

for await (const result of action.invokeStream([
    ["input1"],
    ["input2"], 
    ["input3"]
])) {
    console.log(`Completed item ${result.index}`);
    if (result.error) {
        console.error("Failed:", result.error);
    } else {
        console.log("Success:", result.data);
    }
}
```

Both methods:
- Work with concurrency and rate limiting
- Individual failures don't fail the entire batch
- Return discriminated unions with `data` or `error`

## API Reference

### `createAction(handler)`

Creates a new action with automatic type inference.

**Parameters:**
- `handler: (...args: I) => Promise<O> | O` - Async function to execute

**Returns:** `ActionBuilder<I, O>`

```typescript
const action = createAction(async (input: string) => {
    return { result: input.toUpperCase() };
});
```

### `withContext(handler)`

Wraps a handler to receive `InvocationContext` as the first parameter.

**Parameters:**
- `handler: (ctx: InvocationContext, ...args: I) => Promise<O> | O`

**Returns:** Handler function compatible with `createAction()`

```typescript
const action = createAction(
    withContext(async (ctx, input: string) => {
        ctx.attach("inputLength", input.length);
        return process(input);
    })
);
```

### `ActionBuilder` Methods

#### `.setConcurrency(limit: number)`

Set maximum concurrent executions (default: 1).

```typescript
action.setConcurrency(5);
```

#### `.setRateLimit(limit: number)`

Set maximum executions per second (default: Infinity).

```typescript
action.setRateLimit(100);
```

#### `.setRetry(options: RetryOptions)`

Configure automatic retry behavior.

```typescript
action.setRetry({
    maxRetries: 3,
    backoff: 'exponential',
    baseDelay: 100,
    maxDelay: 10000,
    jitter: true,
    shouldRetry: (error) => error instanceof TransientError
});
```

#### `.onEvent(callback: EventCallback)`

Register a callback to receive wide events.

```typescript
action.onEvent((event) => {
    console.log({
        actionId: event.actionId,
        duration: event.duration,
        attachments: event.attachments,
        error: event.error
    });
});
```

#### `.invoke(...args: I)`

Execute the action with given arguments.

**Returns:** `{ actionId: string, data: Promise<O> }`

```typescript
const { actionId, data } = action.invoke("input");
const result = await data;
```

#### `.invokeAll(payloads: I[])`

Execute multiple invocations, returning all results in order.

**Returns:** `Promise<BatchResult<O>[]>`

```typescript
const results = await action.invokeAll([
    ["input1"],
    ["input2"]
]);
```

#### `.invokeStream(payloads: I[])`

Execute multiple invocations, yielding results as they complete.

**Returns:** `AsyncGenerator<BatchResult<O> & { index: number }>`

```typescript
for await (const result of action.invokeStream([["input1"], ["input2"]])) {
    console.log(`Item ${result.index} completed`);
}
```

### Types

#### `InvocationContext`

Context object for attaching observability data.

```typescript
interface InvocationContext {
    readonly actionId: string;
    attach(key: string, value: unknown): void;
    attach(data: Record<string, unknown>): void;
}
```

#### `WideEvent<I, O>`

Complete event record after invocation.

```typescript
interface WideEvent<I extends any[], O> {
    actionId: string;
    startedAt: number;
    completedAt: number;
    duration: number;
    input: I;
    output?: O;
    error?: Error;
    attachments: Record<string, unknown>;
    retryAttempt?: number;
    totalAttempts?: number;
    retryDelays?: number[];
    isRetry?: boolean;
    willRetry?: boolean;
}
```

#### `RetryOptions`

Retry configuration options.

```typescript
interface RetryOptions {
    maxRetries: number;
    backoff: 'linear' | 'exponential';
    baseDelay?: number;        // Default: 100ms
    maxDelay?: number;         // Default: 30000ms
    jitter?: boolean;          // Default: false
    shouldRetry?: (error: unknown) => boolean;
}
```

## Examples

Check out the [examples/](examples/) directory for comprehensive examples:

- [01-basic-action.ts](examples/01-basic-action.ts) - Basic action creation and invocation
- [02-concurrency.ts](examples/02-concurrency.ts) - Concurrency control
- [03-rate-limiting.ts](examples/03-rate-limiting.ts) - Rate limiting
- [04-wide-events.ts](examples/04-wide-events.ts) - Wide events and context attachment
- [05-batch-invocation.ts](examples/05-batch-invocation.ts) - Batch processing
- [06-combining-features.ts](examples/06-combining-features.ts) - Combining multiple features
- [07-real-world-scenarios.ts](examples/07-real-world-scenarios.ts) - Production use cases
- [08-error-handling.ts](examples/08-error-handling.ts) - Error handling patterns
- [09-retry-examples.ts](examples/09-retry-examples.ts) - Retry strategies

Run examples with:

```bash
npx tsx examples/01-basic-action.ts

# Or run all examples
npx tsx examples/run-all.ts
```

## Use Cases

### API Client with Rate Limiting

```typescript
const apiCall = createAction(async (endpoint: string) => {
    return fetch(`https://api.example.com${endpoint}`).then(r => r.json());
})
.setRateLimit(50)      // API allows 50 req/sec
.setConcurrency(10)    // Keep 10 connections open
.setRetry({
    maxRetries: 3,
    backoff: 'exponential',
    baseDelay: 200
});

const data = await apiCall.invoke("/users/123").data;
```

### Image Processing Pipeline

```typescript
const processImage = createAction(
    withContext(async (ctx, imageUrl: string) => {
        ctx.attach("imageUrl", imageUrl);
        
        const image = await downloadImage(imageUrl);
        ctx.attach("originalSize", image.size);
        
        const processed = await resize(image, 800, 600);
        ctx.attach("processedSize", processed.size);
        
        const uploaded = await uploadToStorage(processed);
        ctx.attach("storageUrl", uploaded.url);
        
        return uploaded;
    })
)
.setConcurrency(3)     // Process 3 images at a time
.onEvent((event) => {
    metrics.record("image_processing", {
        duration: event.duration,
        ...event.attachments
    });
});

// Process batch
const results = await processImage.invokeAll(
    imageUrls.map(url => [url])
);
```

### Webhook Delivery with Retry

```typescript
class NetworkError extends Error {}

const deliverWebhook = createAction(
    withContext(async (ctx, payload: WebhookPayload) => {
        ctx.attach("webhookId", payload.id);
        ctx.attach("targetUrl", payload.url);
        
        const response = await fetch(payload.url, {
            method: 'POST',
            body: JSON.stringify(payload.data),
            headers: { 'Content-Type': 'application/json' }
        });
        
        if (!response.ok) throw new NetworkError(`HTTP ${response.status}`);
        
        ctx.attach("statusCode", response.status);
        return { delivered: true };
    })
)
.setConcurrency(10)
.setRateLimit(100)
.setRetry({
    maxRetries: 5,
    backoff: 'exponential',
    baseDelay: 1000,
    maxDelay: 30000,
    jitter: true,
    shouldRetry: (err) => err instanceof NetworkError
})
.onEvent((event) => {
    webhookLogger.log({
        webhookId: event.attachments.webhookId,
        success: !event.error,
        attempts: event.totalAttempts,
        duration: event.duration
    });
});
```

## Development

### Setup

```bash
git clone https://github.com/yourusername/observed.git
cd observed
npm install
```

### Commands

```bash
npm run test              # Run all tests
npm run test:actions      # Actions tests only
npm run test:scheduler    # Scheduler tests only
npm run test:wide-events  # Wide events tests only
npm run test:retry        # Retry tests only
npm run build             # TypeScript compilation
npm run dev               # Watch mode compilation
```

### Testing

Tests use a custom lightweight framework. See [src/tests/helpers.ts](src/tests/helpers.ts):

```typescript
import { test, assert } from "./helpers.js";

await test("should execute actions", async () => {
    const action = createAction(async (x: number) => x * 2);
    const result = await action.invoke(5).data;
    assert.strictEqual(result, 10);
})();
```

## Design Philosophy

1. **Safe by default** - Concurrency defaults to 1 (sequential execution)
2. **Type inference over explicit generics** - Let TypeScript infer types from handlers
3. **Observability first** - Wide events are a core feature, not an afterthought
4. **Isolated failures** - Errors in tasks or event callbacks don't break the queue
5. **Composable features** - All features work together seamlessly
6. **Zero magic** - Explicit, predictable behavior with clear semantics

## Architecture

```
┌─────────────────┐
│ ActionBuilder   │ ← Fluent API (public interface)
└────────┬────────┘
         │
         ├─ setConcurrency()
         ├─ setRateLimit()
         ├─ setRetry()
         ├─ onEvent()
         │
         ↓
┌─────────────────────┐
│ ExecutionScheduler  │ ← Internal queue & flow control
└─────────┬───────────┘
          │
          ├─ FIFO queue
          ├─ Sliding window rate limiting
          ├─ Concurrency slots
          │
          ↓
    ┌──────────┐
    │  Handler  │ ← User's async function
    └──────────┘
```

## License

MIT © [Alexander Mason](https://github.com/yourusername)

## Contributing

Contributions are welcome! Please check out the [docs/plan/](docs/plan/) directory for design docs and architectural decisions.

### Key Rules for Contributors

- **Never rewrite existing tests** - Only add new tests
- **Prioritize observability** - Wide events should guide feature design
- **Check plan docs** - Review [docs/plan/](docs/plan/) before implementing features
- **Use `.js` extensions** - Import statements must use `.js` even for `.ts` files (ESM requirement)
- **Type inference** - Avoid explicit generics; let TypeScript infer types

## Related Projects

- [p-limit](https://github.com/sindresorhus/p-limit) - Concurrency control
- [p-queue](https://github.com/sindresorhus/p-queue) - Promise queue with priority
- [bottleneck](https://github.com/SGrondin/bottleneck) - Rate limiting

**What makes `observed` different?**

- First-class wide event support for structured observability
- Unified API combining concurrency, rate limiting, and retries
- Type inference from handler functions
- Built for production observability from day one

## Responsible AI Disclosure

This project utilizes AI-assisted development tools. **100% of all AI-generated code has been human reviewed and independently tested** to ensure correctness, security, and adherence to project standards. All tests are maintained and verified by human developers.

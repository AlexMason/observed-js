# Copilot Instructions for `observed`

## Project Overview

`observed` is a TypeScript library providing **action scheduling with concurrency and rate limiting**. It enables controlled execution of async operations through a builder pattern API, with first-class support for **wide event logging**—capturing rich, structured context for every invocation.

### Core Architecture

```
ActionBuilder (public API) → ExecutionScheduler (internal flow control) → User Handler
                  ↓
          InvocationContext (wide event capture)
```

- **ActionBuilder** ([src/actions/index.ts](src/actions/index.ts)): Fluent builder with `.setConcurrency()`, `.setRateLimit()`, `.setRetry()`, and `.onEvent()` chainable methods
- **ExecutionScheduler** ([src/scheduler/index.ts](src/scheduler/index.ts)): Internal FIFO queue manager using sliding-window rate limiting and configurable parallelism. Tasks are queued and executed with concurrency/rate limit enforcement.
- **InvocationContext** ([src/actions/index.ts](src/actions/index.ts)): Context object with `.attach()` method for accumulating wide event data during execution

## Key Patterns

### Action Creation with Type Inference
Always use the `createAction()` factory function—it infers input/output types from the handler automatically:

```typescript
const action = createAction(async (userId: string, limit: number) => {
    return await fetchData(userId, limit);
})
.setConcurrency(5)    // Max 5 parallel executions
.setRateLimit(10)     // Max 10/second
.setRetry({           // Retry on failure
    maxRetries: 3,
    backoff: 'exponential',
    baseDelay: 100,
    jitter: true
});

const { actionId, data } = action.invoke("user123", 50);
const result = await data;
```

**Critical**: Do not manually specify generics on `createAction`. Types flow through automatically via `InferInput<T>` and `InferOutput<T>` utility types.

### Wide Events with Context
Use `withContext()` wrapper to access `InvocationContext` for attaching observability data:

```typescript
const action = createAction(
    withContext(async (ctx, userId: string) => {
        ctx.attach("userId", userId);
        const data = await db.query("SELECT * FROM users WHERE id = ?", [userId]);
        ctx.attach("dbQueryMs", data.duration);
        return data;
    })
).onEvent((event) => {
    // event contains: actionId, input, output, error, duration, attachments, retryAttempt, totalAttempts, etc.
    logger.log(event);
});
```

**Context features**:
- `.attach(key, value)` for single key-value pairs
- `.attach(object)` for bulk attachment
- Deep merges objects automatically when attaching to the same key (recursive merge)
- Primitives overwrite previous values
- Context is optional—handlers work without `withContext()` wrapper (no attachments captured)

### Batch Invocation Styles
- `invokeAll(payloads[])` — Promise.all style, returns results in input order (uses Promise.allSettled internally)
- `invokeStream(payloads[])` — AsyncGenerator, yields `BatchResult` objects as they complete (includes `index` for ordering)
- Individual task failures don't fail the whole batch—each result is a discriminated union with `data` or `error`

### Retry with Backoff
Use `setRetry()` to configure automatic retry on failures:

```typescript
const action = createAction(apiCall)
  .setRetry({
    maxRetries: 3,              // Number of retry attempts
    backoff: 'exponential',     // 'linear' or 'exponential'
    baseDelay: 100,             // Base delay in ms
    maxDelay: 10000,            // Cap for exponential growth (default: 30000)
    jitter: true,               // Add randomness to prevent thundering herd
    shouldRetry: (error) => {   // Optional predicate for selective retry
      return error instanceof NetworkError;
    }
  });
```

**Retry behavior**:
- Retries happen within a single scheduler slot (blocks concurrency slot during retries)
- Each retry emits an **intermediate event** with `retryAttempt`, `willRetry`, and `retryDelays` (only if `onEvent()` is registered)
- Final event includes `totalAttempts` and complete `retryDelays` array
- If `shouldRetry` is not provided, all errors are retried
- If `shouldRetry` returns false, fails immediately (no retry attempted)
- Linear backoff: `baseDelay * attemptNumber`
- Exponential backoff: `baseDelay * 2^(attemptNumber - 1)`, capped at `maxDelay`
- Jitter multiplies delay by random factor between 0.5 and 1.0

## Development Commands

```bash
npm run test              # Run all tests (actions + scheduler + wide-events + retry)
npm run test:actions      # Actions tests only
npm run test:scheduler    # Scheduler tests only
npm run test:wide-events  # Wide events tests only
npm run test:retry        # Retry tests only
npm run build             # TypeScript compilation to ./dist
npm run dev               # Watch mode compilation
```

## Testing Conventions

Tests use a **custom lightweight framework** in [src/tests/helpers.ts](src/tests/helpers.ts):

- Wrap tests with `test("description", async () => {...})()` — note the trailing `()`
- Use `assert` from Node's built-in module (re-exported from helpers)
- Use `delay(ms)` helper for timing-dependent tests
- Group related tests with `printSection("Section Name")`
- Tests run via `tsx` directly (no build step required)

Example test pattern:
```typescript
await test("should handle concurrent execution", async () => {
    const action = createAction(handler).setConcurrency(3);
    // ... assertions
})();
```

## TypeScript Configuration

- **ESM-only** (`"type": "module"` in package.json)
- **Critical**: Use `.js` extensions in imports even for `.ts` files (e.g., `from "../scheduler/index.js"`)
- Strict mode enabled with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
- `verbatimModuleSyntax` enforced (explicit type imports/exports)
- Source maps and declaration files generated to `./dist`
- Module resolution: `nodenext` (ESM with CommonJS interop)
- Tests and examples run directly via `tsx` (no build step required)

## Public API Surface

All exports from [src/index.ts](src/index.ts):
- `createAction()` — Factory function (type inference)
- `withContext()` — Context wrapper for handlers
- `ActionBuilder` — Builder class (returned by createAction)
- `ExecutionScheduler` — Scheduler class (typically not used directly)
- Types: `InvocationContext`, `WideEvent`, `EventCallback`, `RetryOptions`

## Planning & Collaboration

The [docs/plan/](docs/plan/) directory is our shared planning space for collaborating on feature design and intentions before implementation:
- [concurrency-and-rate-limiting.md](docs/plan/concurrency-and-rate-limiting.md) — Rationale for scheduler design
- [wide-event-attach-api.md](docs/plan/wide-event-attach-api.md) — Wide event capture design
- [retry-with-backoff.md](docs/plan/retry-with-backoff.md) — Retry and backoff strategy design

Reference these docs to understand the "why" behind architectural decisions.

## Design Decisions

1. **Default sequential execution** — Concurrency defaults to 1 (safe by default)
2. **Rate limiting uses sliding window** — Tracks timestamps over 1-second window for accurate throttling
3. **Errors don't break the queue** — Individual task failures are isolated; queue continues processing
4. **Event callbacks are isolated** — Errors in `.onEvent()` callbacks are logged but don't propagate to handler
5. **Context is optional** — Handlers work without `withContext()` wrapper (no wide event attachments)
6. **Batch results include index** — `BatchResult` carries `index` to map back to input order when using stream style
7. **Type inference over explicit generics** — `createAction()` automatically infers input/output types via `InferInput<T>` and `InferOutput<T>` utility types
8. **Intermediate retry events** — Only emitted if `onEvent()` callback is registered (avoids unnecessary overhead)

## Library Purpose

The core intention of `observed` is to enable **wide events**—rich, structured logging with comprehensive context. Logging and observability should remain at the forefront of all design decisions.

## Rules for AI Agents

- **Never rewrite existing tests** — Only humans modify tests. You may add new tests, but existing test logic is off-limits.
- **Prioritize observability** — When adding features, consider how they support logging and wide event capture.
- **Use plan docs as source of truth** — Before implementing features, check [docs/plan/](docs/plan/) for design intent.

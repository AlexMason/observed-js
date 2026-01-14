# Copilot Instructions for `observed`

## Project Overview

`observed` is a TypeScript library providing **action scheduling with concurrency and rate limiting**. It enables controlled execution of async operations through a builder pattern API.

### Core Architecture

```
ActionBuilder (public API) → ExecutionScheduler (internal flow control) → User Handler
```

- **ActionBuilder** ([src/actions/index.ts](src/actions/index.ts)): Fluent builder for creating actions with `.setConcurrency()` and `.setRateLimit()` chainable methods
- **ExecutionScheduler** ([src/scheduler/index.ts](src/scheduler/index.ts)): Internal queue manager using sliding-window rate limiting and configurable parallelism

## Key Patterns

### Action Creation
Always use the `createAction()` factory function—it infers input/output types from the handler automatically:

```typescript
const action = createAction(async (userId: string, limit: number) => {
    return await fetchData(userId, limit);
})
.setConcurrency(5)    // Max 5 parallel executions
.setRateLimit(10);    // Max 10/second

const { actionId, data } = action.invoke("user123", 50);
const result = await data;
```

### Batch Invocation Styles
- `invokeAll(payloads[])` — Promise.all style, returns results in input order
- `invokeStream(payloads[])` — AsyncGenerator, yields results as they complete

### Type Inference
Handler types flow through automatically via `InferInput<T>` and `InferOutput<T>` utility types. Do not manually specify generics on `createAction`.

## Development Commands

```bash
npm run test           # Run all tests (actions + scheduler)
npm run test:actions   # Actions tests only
npm run test:scheduler # Scheduler tests only
npm run build          # TypeScript compilation
npm run dev            # Watch mode compilation
```

## Testing Conventions

Tests use a **custom lightweight framework** in [src/tests/helpers.ts](src/tests/helpers.ts):

- Wrap tests with `test("description", async () => {...})()`—note the trailing `()`
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
- Use `.js` extensions in imports even for `.ts` files (e.g., `from "../scheduler/index.js"`)
- Strict mode enabled with `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`
- Source maps and declaration files generated to `./dist`

## Planning & Collaboration

The [docs/plan/](docs/plan/) directory is our shared planning space for collaborating on feature design and intentions before implementation. Reference these docs to understand the "why" behind architectural decisions.

## Design Decisions

1. **Default sequential execution** — Concurrency defaults to 1 (safe by default)
2. **Rate limiting uses sliding window** — Tracks timestamps over 1-second window for accurate throttling
3. **Errors don't break the queue** — Individual task failures are isolated; queue continues processing
4. **Batch results include index** — `BatchResult` carries `index` to map back to input order when using stream style

## Library Purpose

The core intention of `observed` is to enable **wide events**—rich, structured logging with comprehensive context. Logging and observability should remain at the forefront of all design decisions.

## Rules for AI Agents

- **Never rewrite existing tests** — Only humans modify tests. You may add new tests, but existing test logic is off-limits.
- **Prioritize observability** — When adding features, consider how they support logging and wide event capture.

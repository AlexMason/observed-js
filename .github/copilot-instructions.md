# Copilot Instructions (observed-js)

## What this repo is
`observed-js` is a zero-deps TypeScript (ESM) library for scheduling async handlers with concurrency + sliding-window rate limiting, plus “wide events” observability (attachments, retries, timeouts, cancellation, progress).

## Architecture (follow the data)
- Public API: `createAction()` returns `ActionBuilder` in `src/actions/index.ts` (builder pattern).
- Execution: `ActionBuilder` schedules work via `ExecutionScheduler` in `src/scheduler/index.ts`.
- Observability: each invocation emits a `WideEvent` (input/output/error/duration/priority/metadata/attachments + retry/timeout/cancel fields).

## Project conventions (important)
- ESM-only: imports inside `src/**` must use `.js` extensions (see `src/index.ts`).
- Prefer type inference: call `createAction(handler)` without explicit generics; input/output types infer from the handler.
- Opt-in handler “extras” via wrappers:
  - `withContext((ctx, ...args) => ...)` enables `ctx.attach()` plus progress (`ctx.setTotal()`, `ctx.incrementProgress()`).
  - `withAbortSignal((signal, ...args) => ...)` enables cooperative cancellation/timeout (`setTimeout({ abortSignal: true })`).
- Callback isolation: errors thrown in `.onEvent()` / `.onProgress()` are caught and logged; they don’t fail the action.

## Working locally
- Tests run via `tsx` (no build step): `npm test` or `npm run test:<suite>` (see `package.json`).
- Build: `npm run build` (emits `dist/`).
- Examples: `npx tsx examples/run-all.ts` or run a single file in `examples/`.

## When changing behavior
- User-facing behavior lives in `src/actions/index.ts`; queue/limits/cancel/shutdown live in `src/scheduler/index.ts`.
- Design rationale is captured in `docs/plan/` (cancellation/priority/timeouts/progress/retry/wide-events).
- Don’t edit existing tests in `src/tests/*.test.ts`; add new tests if needed (helpers in `src/tests/helpers.ts`).

```ts
const action = createAction(withContext(async (ctx, userId: string) => {
  ctx.attach({ userId });
  return userId;
}))
  .setConcurrency(3)
  .setRateLimit(10)
  .setRetry({ maxRetries: 2, backoff: 'exponential' })
  .onEvent((e) => console.log(e.attachments));
```

# observed-js

Action scheduling for async handlers with concurrency + sliding-window rate limiting, plus “wide events” observability (attachments, retries, timeouts, cancellation, progress).

- Zero deps, ESM-only. Node >= 18.
- Types infer from your handler (no explicit generics).

- Observability - built for wide events

## Install

```bash
npm install observed-js
```

## Quick start

```ts
import { createAction, withContext } from "observed-js";

const fetchUser = createAction(
  withContext(async (ctx, userId: string) => {
    ctx.attach({ userId });
    const res = await fetch(`/api/users/${userId}`);
    const user = await res.json();
    ctx.attach({ status: res.status });
    return user;
  })
)
  .setConcurrency(5)
  .setRateLimit(10)
  .setRetry({ maxRetries: 3, backoff: "exponential", baseDelay: 100 })
  .onEvent((e) => {
    // `e` includes input/output/error/duration/priority/metadata/attachments
    console.log(e.actionId, e.duration, e.attachments);
  });

const { data } = fetchUser.invoke("user-123");
const user = await data;
```

## Key ideas

### Wrappers opt-in handler extras
- `withContext((ctx, ...args) => ...)`: enables `ctx.attach()` and handler-driven progress (`ctx.setTotal()`, `ctx.incrementProgress()`).
- `withAbortSignal((signal, ...args) => ...)`: enables cooperative cancellation and cooperative timeouts via `setTimeout({ abortSignal: true })`.

### Batch execution
- `invokeAll(payloads)`: returns results in input order (individual failures don’t fail the batch).
- `invokeStream(payloads)`: yields results as they complete (out of order) with an `index`.

### Cancellation & timeouts
- Every invocation handle has `cancel(reason?)`.
- `ActionBuilder.cancelAll()` cancels active invocations; `ActionBuilder.clearQueue()` cancels queued ones.
- `setTimeout(ms | { duration, abortSignal?, throwOnTimeout? })` captures timeout metadata in wide events.

### Callback isolation
Errors thrown inside `.onEvent()` / `.onProgress()` are logged and do not fail the action.

## API at a glance

- Creation: `createAction(handler)`, wrappers: `withContext`, `withAbortSignal`.
- Builder config: `setConcurrency`, `setRateLimit`, `setPriority`, `setRetry`, `setTimeout`.
- Observability: `onEvent`, `onProgress`.
- Invoke: `invoke`, `invokeAll`, `invokeStream`.
- Control/inspection: `cancelAll`, `clearQueue`, `getQueueLength`, `getActiveCount`.

Full types live in `src/actions/index.ts` and are exported from `src/index.ts`.

## API reference (compact)

| Item | Signature | Notes |
| --- | --- | --- |
| Create action | `createAction(handler)` | Infers input/output from `handler`; returns an `ActionBuilder`. |
| Wrapper (context) | `withContext((ctx, ...args) => handler)` | Enables `ctx.attach()` + handler-driven progress. |
| Wrapper (abort signal) | `withAbortSignal((signal, ...args) => handler)` | Enables cooperative cancellation + cooperative timeouts (`setTimeout({ abortSignal: true })`). |
| Invoke | `action.invoke(...args[, { priority, metadata }])` | Returns `{ actionId, data, eventLogged, cancel, cancelled, cancelReason }`. |
| Batch invoke (all) | `action.invokeAll(payloads[, { priority, metadata }])` | Returns `BatchResult[]` in input order; each item is `{ data }` or `{ error }`. |
| Batch invoke (stream) | `action.invokeStream(payloads[, { priority, metadata }])` | Yields `BatchResult` as each completes (out of order) with `index`. |
| Configure | `.setConcurrency(n)`, `.setRateLimit(n)`, `.setPriority(p)` | Priority is `low\|normal\|high\|critical\|number` (0–100). |
| Retry | `.setRetry({ maxRetries, backoff, ... })` | Backoff is `linear` or `exponential` (+ optional jitter / shouldRetry). |
| Timeout | `.setTimeout(ms \| { duration, abortSignal?, throwOnTimeout? })` | Emits timeout metadata in `WideEvent`; `TimeoutError` available. |
| Events/progress | `.onEvent(cb)`, `.onProgress(cb[, { throttle }])` | Callback errors are isolated (logged, not thrown). |
| Cancellation | `handle.cancel(reason?)`, `action.cancelAll(...)`, `action.clearQueue(...)` | Cancel state is captured in `WideEvent` (`CancellationError` available). |

## Examples

- See `examples/` and `examples/README.md`.
- Run one: `npx tsx examples/01-basic-action.ts`
- Run all: `npx tsx examples/run-all.ts`

## Development

```bash
npm test
npm run test:actions
npm run test:scheduler
npm run test:wide-events
npm run build
npm run dev
```

Design rationale (cancellation/priority/timeouts/progress/retry/wide-events) lives in `docs/plan/`.

## Contributing

- Issues/PRs welcome.
- Keep the project ESM-first (imports in `src/**` use `.js` extensions).
- Tests run via `tsx` (`npm test`); prefer adding tests over editing existing `src/tests/*.test.ts`.

## License

[MIT](LICENSE)

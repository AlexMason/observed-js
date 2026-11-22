# observed-js

Action scheduling for async handlers with concurrency + sliding-window rate limiting, plus “wide events” observability (attachments, retries, timeouts, cancellation, progress).

- Zero deps, ESM-only. Node >= 22.
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

### Console capture (on by default)
`console.log/info/warn/error/debug/trace` calls made while an invocation runs are recorded on that invocation's `WideEvent.logs` as `{ level, message, timestamp, attempt, actionId }`. That covers calls in the handler, in code it calls, and in its `onEvent`/`onProgress`/`shouldRetry`/`onWarning` callbacks. No handler changes are needed.

> **Data exposure:** whatever your code or its dependencies log, including tokens, request bodies and personal data, ends up in the events you pass to `onEvent`, and from there in whatever sink you ship them to. `setConsoleCapture(false)` keeps it out of every action that doesn't opt back in with `.captureConsole()` (opting back in also turns capture on for that action's children). A per-action `.captureConsole(false)` only removes `logs` from that action's own event: when the action runs under a capturing parent, its output is still copied into the parent's `logs`.

- **Opting out:** `setConsoleCapture(false)` turns capture off globally and `.captureConsole(false)` turns it off for one action; `setConsoleCapture()` restores the default. Importing the library does not touch `console`. The first invocation with capture on patches the six methods, once and permanently.
- **Traces:** a child invocation's output is also copied into every capturing ancestor's `logs`, so a root event holds the whole trace in call order. Filter by entry `actionId` to see one event (`traceId` is on every event).
  - Children inherit capture and its settings from their parent.
  - `.captureConsole(false)` on a child removes `logs` from its own event, but its output is still copied up.
- **Passthrough:** captured output still prints. `{ passthrough: false }` hides captured calls from the terminal. Only the invocation that made the call decides, so each call prints at most once.
- **Limits:** the defaults are `{ maxEntries: 1000, maxMessageLength: 8192 }`.
  - `maxEntries` applies to each contributing invocation within each event's `logs`; entries over the limit are counted in `logsDropped`.
  - Long messages are cut once, at the source invocation's limit, and marked `truncated`.
- **Lifecycle callbacks:**
  - Callbacks that run before the event is finalized add to the invocation's own `logs`.
  - The final `onEvent` runs after that event is delivered, so its output goes to capturing ancestors only. A root's final `onEvent` output prints but is not captured.
  - Batch `onProgress` output belongs to the caller's invocation.
  - The library's own diagnostics are never captured.
- **Not captured:**
  - output that bypasses `console` (`process.stdout.write`, pino);
  - worker threads and child processes;
  - `console.dir`;
  - callbacks registered outside the invocation (e.g. EventEmitter listeners attached at startup);
  - calls made after another tool replaces the console methods.
- **Recorded under another level:** `console.table/group/count/timeEnd/timeLog` and a failing `console.assert` are recorded under the level Node uses internally (`log`/`warn`).
- **Late calls:** a call made after an invocation's event was emitted still prints, but goes only to ancestors that are still running.

## API at a glance

- Creation: `createAction(handler)`, wrappers: `withContext`, `withAbortSignal`.
- Builder config: `setConcurrency`, `setRateLimit`, `setPriority`, `setRetry`, `setTimeout`, `captureConsole`.
- Observability: `onEvent`, `onProgress`, `setConsoleCapture` (global).
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
| Console capture | `setConsoleCapture(opts \| false)`, `.captureConsole(opts \| false)` | On by default; `opts` is `{ passthrough?, maxEntries?, maxMessageLength? }`. Entries land on `WideEvent.logs` (`logsDropped` when over the limit). |

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

## Releasing

Pushes to `main` run `.github/workflows/publish.yml`.

1. In a PR to `dev`, bump `version` in `package.json` (`npm version <x.y.z> --no-git-tag-version`, which also updates `package-lock.json`).
2. Merge `dev` → `main`.
3. `Publish` runs the CI tests (Node 22/24/26). If that version is not on npm yet, it publishes with npm trusted publishing (OIDC, with provenance), creates tag `vX.Y.Z` and a GitHub Release with generated notes.

- **No version bump:** if the version is already on npm, the run finishes green without publishing.
- **Preview:** every PR runs the publish job as a dry run. Its summary says whether a merge to `main` would publish.
- **CI:** `.github/workflows/ci.yml` runs actionlint and the test matrix on every PR and every push to `dev`.

### One-time npm setup

On npmjs.com, go to **observed-js → Settings → Trusted Publisher → GitHub Actions**:

| Field | Value |
| --- | --- |
| Organization or user | `AlexMason` |
| Repository | `observed-js` |
| Workflow filename | `publish.yml` |
| Environment name | *(blank)* |
| Allowed actions | `npm publish` (newer configs default to stage-only) |

- A new configuration **expires unless its first publish succeeds within 2 days**, so create it shortly before the release merge.
- npm doesn't validate the fields when you save them; a mismatch shows up as `ENEEDAUTH` in the `Publish` run. Fix the configuration and re-run the job.
- Renaming `publish.yml` breaks publishing until the configuration is updated.
- Once publishing works, **Settings → Publishing access → "Require two-factor authentication and disallow tokens"** blocks token-based publishes. Trusted publishing keeps working.

### Recovering a failed release step

If `npm publish` succeeded but tagging failed, a re-run skips the version (it's already on npm) and doesn't tag. Create the release by hand from the commit that was published:

```bash
gh release create vX.Y.Z --target <sha> --title vX.Y.Z --generate-notes
```

## Contributing

- Issues/PRs welcome.
- Keep the project ESM-first (imports in `src/**` use `.js` extensions).
- Tests run via `tsx` (`npm test`); prefer adding tests over editing existing `src/tests/*.test.ts`.

## License

[MIT](LICENSE)

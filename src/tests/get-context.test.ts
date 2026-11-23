import { test, assert, delay, printSection } from "./helpers.js";
import { createAction, getContext, TimeoutError, CancellationError, type Progress } from "../actions/index.js";

printSection("getContext Tests");

const OUTSIDE_MESSAGE = /during an action invocation/;

await test("plain handler attaches and reports progress through getContext()", async () => {
    const progress: Progress[] = [];
    const action = createAction(async (userId: string) => {
        const ctx = getContext();
        ctx.attach({ userId });
        ctx.setTotal(2);
        ctx.incrementProgress();
        ctx.incrementProgress();
        return userId;
    }).onProgress((p) => { progress.push(p); }, { throttle: 0 });

    const handle = action.invoke("u-1");
    const event = await handle.event;

    assert.strictEqual(await handle.data, "u-1");
    assert.deepStrictEqual(event.attachments, { userId: "u-1" });
    assert.strictEqual(progress.at(-1)?.completed, 2);
    assert.strictEqual(progress.at(-1)?.total, 2);
})();

await test("helpers reached by sync calls, awaits and timers see the invocation's context", async () => {
    const syncHelper = () => {
        getContext().attach("sync", true);
        return getContext().actionId;
    };
    const asyncHelper = async () => {
        await delay(5);
        getContext().attach("async", true);
        return getContext().actionId;
    };

    const action = createAction(async () => {
        const fromSync = syncHelper();
        const fromAsync = await asyncHelper();
        const fromTimer = await new Promise<string>((resolve) => setTimeout(() => {
            getContext().attach("timer", true);
            resolve(getContext().actionId);
        }, 1));
        return [fromSync, fromAsync, fromTimer];
    });

    const handle = action.invoke();
    const event = await handle.event;

    assert.deepStrictEqual(await handle.data, [event.actionId, event.actionId, event.actionId]);
    assert.deepStrictEqual(event.attachments, { sync: true, async: true, timer: true });
})();

await test("concurrent invocations each see only their own context", async () => {
    const record = async (label: string) => {
        await delay(5);
        getContext().attach(label, true);
    };
    const action = createAction(async (id: string) => {
        await record(`${id}-1`);
        await delay(10);
        await record(`${id}-2`);
        return id;
    }).setConcurrency(2);

    const a = action.invoke("a");
    const b = action.invoke("b");
    const [eventA, eventB] = await Promise.all([a.event, b.event]);

    assert.deepStrictEqual(eventA.attachments, { "a-1": true, "a-2": true });
    assert.deepStrictEqual(eventB.attachments, { "b-1": true, "b-2": true });
})();

await test("a nested action gets its own context linked to the caller's", async () => {
    let childSeen: { actionId: string; parentId: string | undefined } | undefined;
    const child = createAction(async () => {
        const ctx = getContext();
        childSeen = { actionId: ctx.actionId, parentId: ctx.parent?.actionId };
    });
    const parentHelper = () => getContext().actionId;

    const parent = createAction(async () => {
        const childHandle = child.invoke();
        await childHandle.data;
        const childEvent = await childHandle.event;
        return { afterChild: parentHelper(), childEventId: childEvent.actionId };
    });

    const handle = parent.invoke();
    const parentEvent = await handle.event;
    const { afterChild, childEventId } = (await handle.data)!;

    assert.strictEqual(childSeen?.actionId, childEventId);
    assert.strictEqual(childSeen?.parentId, parentEvent.actionId);
    assert.strictEqual(afterChild, parentEvent.actionId);
})();

await test("invokeAll and invokeStream items each see their own context", async () => {
    const action = createAction(async (n: number) => {
        await delay(5 * (3 - n));
        return getContext().actionId;
    }).setConcurrency(3);

    const all = await action.invokeAll([0, 1, 2]);
    for (const result of all) {
        assert.strictEqual(result.data, result.actionId);
    }

    let streamed = 0;
    for await (const result of action.invokeStream([0, 1, 2])) {
        assert.strictEqual(result.data, result.actionId);
        streamed++;
    }
    assert.strictEqual(streamed, 3);
})();

await test("getContext() throws outside an invocation, before and after one runs", async () => {
    assert.throws(() => getContext(), OUTSIDE_MESSAGE);

    const action = createAction(async () => getContext().actionId);
    await action.invoke().data;

    assert.throws(() => getContext(), OUTSIDE_MESSAGE);
})();

await test("signal: live during a normal run, aborted with the cancel reason on cancel", async () => {
    let seen: AbortSignal | undefined;
    let abortedDuringRun: boolean | undefined;
    const action = createAction(async (ms: number) => {
        seen = getContext().signal;
        abortedDuringRun = seen.aborted;
        await delay(ms);
        return ms;
    });

    assert.strictEqual(await action.invoke(1).data, 1);
    assert.ok(seen instanceof AbortSignal);
    assert.strictEqual(abortedDuringRun, false);
    assert.strictEqual(seen.aborted, false);

    const handle = action.invoke(200);
    await delay(20);
    handle.cancel("User cancelled");
    await assert.rejects(handle.data, CancellationError);
    assert.strictEqual(seen.aborted, true);
    assert.strictEqual(seen.reason, "User cancelled");
})();

await test("signal: a timeout rejects promptly and aborts the signal with a TimeoutError", async () => {
    let seen: AbortSignal | undefined;
    const action = createAction(async () => {
        seen = getContext().signal;
        await delay(300); // ignores the signal
        return "late";
    }).setTimeout(50);

    const start = Date.now();
    await assert.rejects(action.invoke().data, TimeoutError);
    assert.ok(Date.now() - start < 200, "timeout must not wait for the handler");
    assert.strictEqual(seen?.aborted, true);
    assert.ok(seen?.reason instanceof TimeoutError);
})();

await test("signal: still aborted when throwOnTimeout is false", async () => {
    let seen: AbortSignal | undefined;
    const action = createAction(async () => {
        seen = getContext().signal;
        await delay(200);
    }).setTimeout({ duration: 30, throwOnTimeout: false });

    const event = await action.invoke().event;
    assert.strictEqual(event.timedOut, true);
    assert.strictEqual(seen?.aborted, true);
})();

await test("signal: each retry attempt gets a fresh signal", async () => {
    const signals: AbortSignal[] = [];
    const abortedWhileRunning: boolean[] = [];
    const action = createAction(async () => {
        const signal = getContext().signal;
        signals.push(signal);
        if (signals.length === 1) {
            await delay(200); // attempt 0 times out
        }
        abortedWhileRunning.push(signal.aborted);
        return signals.length;
    }).setTimeout(40).setRetry({ maxRetries: 1, baseDelay: 0 });

    assert.strictEqual(await action.invoke().data, 2);
    assert.strictEqual(signals.length, 2);
    assert.notStrictEqual(signals[0], signals[1]);
    assert.strictEqual(signals[0]!.aborted, true);
    assert.strictEqual(abortedWhileRunning.at(-1), false);
    assert.strictEqual(signals[1]!.aborted, false);
})();

await test("signal: a timed-out attempt that keeps running still reads its own aborted signal", async () => {
    let own: AbortSignal | undefined;
    let lateRead: AbortSignal | undefined;
    const readSignal = () => getContext().signal; // a helper reading lazily, after the retry started
    const action = createAction(async () => {
        if (!own) {
            own = readSignal();
            await delay(120); // attempt 0 times out at 40 ms; attempt 1 starts meanwhile
            lateRead = readSignal();
            return "zombie";
        }
        await delay(10);
        return "retry";
    }).setTimeout(40).setRetry({ maxRetries: 1, baseDelay: 0 });

    assert.strictEqual(await action.invoke().data, "retry");
    await delay(130);
    assert.strictEqual(lateRead, own);
    assert.strictEqual(lateRead?.aborted, true);
})();

await test("signal: helpers deep in the call chain see the handler's signal", async () => {
    const leaf = async () => { await delay(1); return getContext().signal; };
    const middle = async () => leaf();
    const action = createAction(async () => {
        const own = getContext().signal;
        return own === await middle();
    }).setTimeout(1000);

    assert.strictEqual(await action.invoke().data, true);
})();

await test("signal: with a timeout, cancel aborts the running attempt and earlier attempts' signals", async () => {
    const signals: AbortSignal[] = [];
    const action = createAction(async () => {
        signals.push(getContext().signal);
        if (signals.length === 1) {
            throw new Error("attempt 0 fails fast"); // its signal is not aborted by a timeout
        }
        await delay(300);
    }).setTimeout(1000).setRetry({ maxRetries: 1, baseDelay: 0 });

    const handle = action.invoke();
    await delay(50);
    assert.strictEqual(signals.length, 2);
    assert.strictEqual(signals[0]!.aborted, false);
    handle.cancel("User cancelled");

    await assert.rejects(handle.data, CancellationError);
    assert.strictEqual(signals[1]!.aborted, true);
    assert.strictEqual(signals[1]!.reason, "User cancelled");
    assert.strictEqual(signals[0]!.aborted, true);
    assert.strictEqual(signals[0]!.reason, "User cancelled");
})();

await test("a TimeoutError thrown by the handler is not counted as the action's own timeout", async () => {
    const nested = new TimeoutError(5);
    const action = createAction(async () => {
        throw nested; // e.g. a nested action that timed out
    }).setTimeout({ duration: 1000, throwOnTimeout: false });

    const handle = action.invoke();
    await assert.rejects(handle.data, (e) => e === nested);
    const event = await handle.event;
    assert.strictEqual(event.timedOut, false);
    assert.strictEqual(event.error, nested);
})();

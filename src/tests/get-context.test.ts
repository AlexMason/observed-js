import { test, assert, delay, printSection } from "./helpers.js";
import { createAction, getContext, type Progress } from "../actions/index.js";

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

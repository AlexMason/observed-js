import { test, assert, delay, printSection } from "./helpers.js";
import { createAction, withContext, type WideEvent } from "../actions/index.js";

printSection("Context Propagation Tests");

await test("should include child events on parent event", async () => {
    const events: WideEvent<[string], string>[] = [];

    const childAction = createAction(
        withContext(async (ctx, item: string) => {
            ctx.attach("item", item);
            return `child-${item}`;
        })
    );

    const parentAction = createAction(
        withContext(async (ctx, userId: string) => {
            ctx.attach("userId", userId);
            const a = await childAction.invoke("a").data;
            const b = await childAction.invoke("b").data;
            return `${a}-${b}`;
        })
    ).onEvent((event) => {
        events.push(event as any);
    });

    const result = await parentAction.invoke("user-1").data;
    await delay(10);

    assert.strictEqual(result, "child-a-child-b");
    assert.strictEqual(events.length, 1);

    const event = events[0]!;
    assert.ok(event.traceId);
    assert.strictEqual(event.children?.length, 2);

    const childIds = event.children!.map((c) => c.actionId).sort();
    const listedIds = (event.childActionIds ?? []).slice().sort();

    assert.deepStrictEqual(listedIds, childIds);
    assert.ok(event.children!.every((c) => c.parentActionId === event.actionId));
    assert.ok(event.children!.every((c) => c.traceId === event.traceId));
})();

await test("should expose parent attachments through context chain", async () => {
    const childAction = createAction(
        withContext(async (ctx, itemId: string) => {
            return ctx.parent?.attachments.userId as string;
        })
    );

    const parentAction = createAction(
        withContext(async (ctx, userId: string) => {
            ctx.attach("userId", userId);
            return await childAction.invoke("item-1").data;
        })
    );

    const result = await parentAction.invoke("user-42").data;
    assert.strictEqual(result, "user-42");
})();

await test("should attach batchId to child events from invokeAll", async () => {
    const events: WideEvent<[string], string>[] = [];

    const childAction = createAction(
        withContext(async (_ctx, itemId: string) => {
            return `item-${itemId}`;
        })
    );

    const parentAction = createAction(
        withContext(async (_ctx, userId: string) => {
            const results = await childAction.invokeAll([
                ["1"],
                ["2"],
                ["3"]
            ]);
            return `${userId}:${results.length}`;
        })
    ).onEvent((event) => {
        events.push(event as any);
    });

    await parentAction.invoke("user-99").data;
    await delay(10);

    assert.strictEqual(events.length, 1);
    const event = events[0]!;
    const batchIds = (event.children ?? []).map((child) => child.batchId).filter(Boolean);

    assert.strictEqual(batchIds.length, 3);
    assert.ok(batchIds.every((id) => id === batchIds[0]));
})();

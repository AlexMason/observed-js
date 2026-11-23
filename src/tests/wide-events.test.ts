import { test, assert, delay, printSection } from "./helpers.js";
import { createAction, getContext, CancellationError, type WideEvent } from "../actions/index.js";

printSection("Wide Event Tests - Attach API");

await test("should create action with context and capture basic event", async () => {
    const events: WideEvent<[string], string>[] = [];
    
    const action = createAction(
        async (name: string) => {
            return `Hello, ${name}!`;
        }
    ).onEvent((event) => {
        events.push(event as any); // Cast to bypass exact types
    });

    const { data } = action.invoke("world");
    const result = await data;
    await delay(10); // Give event time to fire

    assert.strictEqual(result, "Hello, world!");
    assert.strictEqual(events.length, 1);
    
    const event = events[0]!;
    assert.strictEqual(event.actionId.length, 36); // UUID
    assert.deepStrictEqual(event.input, ["world"]);
    assert.strictEqual(event.output, "Hello, world!");
    assert.strictEqual(event.error, undefined);
    assert.strictEqual(typeof event.startedAt, 'number');
    assert.strictEqual(typeof event.completedAt, 'number');
    assert.strictEqual(typeof event.duration, 'number');
    assert.ok(event.duration >= 0);
    assert.deepStrictEqual(event.attachments, {});
})();
await test("should capture attached data in wide events", async () => {
    const events: WideEvent<[string, number], string>[] = [];
    
    const action = createAction(
        async (name: string, age: number) => {
            const ctx = getContext();
            ctx.attach("userName", name);
            ctx.attach("userAge", age);
            return `User: ${name} (${age})`;
        }
    ).onEvent((event) => {
        events.push(event as any);
    });

    const { data } = action.invoke("Alice", 30);
    await data;
    await delay(10);

    assert.strictEqual(events.length, 1);
    const event = events[0]!;
    assert.strictEqual(event.input[0], "Alice");
    assert.strictEqual(event.input[1], 30);
    assert.strictEqual(event.output, "User: Alice (30)");
    assert.strictEqual(event.error, undefined);
    assert.ok(event.duration >= 0);
    assert.strictEqual(event.attachments.userName, "Alice");
    assert.strictEqual(event.attachments.userAge, 30);
})();

await test("should support object attachments with deep merge", async () => {
    const events: WideEvent<[string], string>[] = [];
    
    const action = createAction(
        async (input: string) => {
            const ctx = getContext();
            ctx.attach("single", "value");
            ctx.attach({ nested: { key: "value" }, count: 42 });
            return `Result: ${input}`;
        }
    ).onEvent((event) => {
        events.push(event as any);
    });

    await action.invoke("test").data;
    await delay(10);
    
    assert.strictEqual(events.length, 1);
    const event = events[0]!;
    assert.strictEqual(event.attachments["single"], "value");
    assert.deepStrictEqual(event.attachments["nested"], { key: "value" });
    assert.strictEqual(event.attachments["count"], 42);
})();

await test("should deep merge nested object attachments", async () => {
    const events: WideEvent<[string], string>[] = [];
    
    const action = createAction(
        async (input: string) => {
            const ctx = getContext();
            ctx.attach("db", { queryMs: 100, rows: 5 });
            ctx.attach("db", { cached: true });  // Should merge
            return "result";
        }
    ).onEvent((event) => {
        events.push(event as any);
    });

    const { data } = action.invoke("test");
    await data;
    await delay(10);

    assert.strictEqual(events.length, 1);
    const event = events[0]!;
    assert.deepStrictEqual(event.attachments.db, { queryMs: 100, rows: 5, cached: true });
})();

await test("should handle errors and still emit events", async () => {
    const events: WideEvent<[string], never>[] = [];
    
    const action = createAction(
        async (input: string) => {
            const ctx = getContext();
            ctx.attach("step", "before-error");
            throw new Error("Test error");
        }
    ).onEvent((event) => {
        events.push(event as any);
    });

    try {
        const { data } = action.invoke("test");
        await data;
        assert.fail("Should have thrown");
    } catch (e) {
        // Expected
    }

    await delay(50); // Wait for event callback

    assert.strictEqual(events.length, 1);
    const event = events[0]!;
    assert.strictEqual(event.error?.message, "Test error");
    assert.strictEqual(event.attachments["step"], "before-error");
    assert.strictEqual(event.output, undefined);
})();

await test("should work without context (backward compatibility)", async () => {
    const events: WideEvent<[string], string>[] = [];
    
    const action = createAction(async (input: string) => {
        return `result: ${input}`;
    }).onEvent((event) => {
        events.push(event as any);
    });

    const { data } = action.invoke("test");
    const result = await data;

    await delay(50); // Wait for event callback

    assert.strictEqual(result, "result: test");
    assert.strictEqual(events.length, 1);
    
    const event = events[0]!;
    assert.strictEqual(event.output, "result: test");
    assert.deepStrictEqual(event.attachments, {}); // No attachments without context
    assert.strictEqual(event.error, undefined);
})();

await test("should provide event promise", async () => {
    let callbackCalled = false;
    
    const action = createAction(
        async (input: string) => {
            return input;
        }
    ).onEvent(async (event) => {
        await delay(50);
        callbackCalled = true;
    });

    const { data, event } = action.invoke("test");
    const result = await data;
    
    assert.strictEqual(result, "test");
    // Callback may have started but not finished yet due to delay
    
    await event; // Wait for callback
    
    assert.strictEqual(callbackCalled, true);
})();

await test("event resolves to the final event even without a callback", async () => {
    const action = createAction(
        async (input: string) => {
            return input;
        }
    );

    const event = await action.invoke("test").event;
    assert.strictEqual(event.output, "test");
})();

await test("should isolate event callback errors: event still resolves to the final event", async () => {
    const origErr = console.error;
    console.error = () => {};
    try {
        const action = createAction(
            async (input: string) => {
                const ctx = getContext();
                ctx.attach("data", "value");
                return "success";
            }
        ).onEvent((event) => {
            throw new Error("Callback error");
        });

        const { data, event } = action.invoke("test");
        assert.strictEqual(await data, "success"); // Handler succeeded

        const finalEvent = await event;
        assert.strictEqual(finalEvent.output, "success");
        assert.deepStrictEqual(finalEvent.attachments, { data: "value" });
    } finally {
        console.error = origErr;
    }
})();

printSection("Batch Operations with Wide Events");

await test("invokeAll should emit events for each invocation", async () => {
    const events: WideEvent<[number], number>[] = [];
    
    const action = createAction(
        async (n: number) => {
            const ctx = getContext();
            ctx.attach("input", n);
            return n * 2;
        }
    ).onEvent((event) => {
        events.push(event as any);
    });

    const results = await action.invokeAll([1, 2, 3]);
    
    await delay(50); // Wait for all events

    assert.strictEqual(results.length, 3);
    assert.strictEqual(events.length, 3);
    
    // Check all events have attachments
    for (const event of events) {
        assert.ok(event.attachments["input"] !== undefined);
    }
})();

await test("invokeStream should emit events as results stream", async () => {
    const events: WideEvent<[number], number>[] = [];
    
    const action = createAction(
        async (n: number) => {
            const ctx = getContext();
            ctx.attach("processed", n);
            await delay(n * 10);
            return n;
        }
    ).onEvent((event) => {
        events.push(event as any);
    });

    const results: number[] = [];
    for await (const result of action.invokeStream([3, 1, 2])) {
        if (!result.error) {
            results.push(result.data as number);
        }
    }

    await delay(100); // Wait for all events

    assert.strictEqual(results.length, 3);
    assert.strictEqual(events.length, 3);
    
    // All events should have attachments
    for (const event of events) {
        assert.ok(event.attachments["processed"] !== undefined);
    }
})();

printSection("Timing and Duration");

await test("should track accurate timing information", async () => {
    const events: WideEvent<[number], number>[] = [];
    
    const action = createAction(
        async (delayMs: number) => {
            await delay(delayMs);
            return delayMs;
        }
    ).onEvent((event) => {
        events.push(event as any);
    });

    const { data } = action.invoke(100);
    await data;
    
    await delay(50);

    assert.strictEqual(events.length, 1);
    const event = events[0]!;
    
    assert.ok(event.duration >= 100); // Should be at least 100ms
    assert.ok(event.duration < 200); // But not too much more
    assert.ok(event.startedAt < event.completedAt);
})();

printSection("Events on Results");

await test("every path delivers exactly one final event to onEvent, and results carry that same event", async () => {
    const delivered = new Map<string, WideEvent<[string], string>[]>();
    const action = createAction(async (name: string) => {
        if (name.startsWith("bad")) throw new Error("nope");
        return name.toUpperCase();
    }).onEvent((event) => {
        delivered.set(event.actionId, [...(delivered.get(event.actionId) ?? []), event]);
    });

    const all = await action.invokeAll(["a", "bad-all"]);
    const streamed = [];
    for await (const result of action.invokeStream(["b", "bad-stream"])) streamed.push(result);
    const ok = action.invoke("c");
    const bad = action.invoke("bad-invoke");
    const handles = [
        { actionId: ok.actionId, event: await ok.event, error: await ok.error, data: await ok.data },
        { actionId: bad.actionId, event: await bad.event, error: await bad.error, data: undefined }
    ];

    for (const result of [...all, ...streamed, ...handles]) {
        const seen = delivered.get(result.actionId) ?? [];
        assert.strictEqual(seen.length, 1);
        assert.strictEqual(seen[0], result.event);
        assert.strictEqual(result.event.error, result.error);
        assert.strictEqual(result.event.output, result.data);
        if (result.error) assert.strictEqual(result.event.willRetry, false);
    }
    assert.strictEqual(all[0]!.event.batchId, all[1]!.event.batchId);
    assert.strictEqual(streamed[0]!.event.batchId, streamed[1]!.event.batchId);
    assert.strictEqual(handles[1]!.event.batchId, undefined);
})();

await test("invoke's error resolves to the failure data rejects with, matching event.error", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const action = createAction(async (name: string) => {
        await gate;
        if (name === "bad") throw new Error("nope");
        return name;
    }).setConcurrency(1);

    const ok = action.invoke("ok");
    const bad = action.invoke("bad");
    const queued = action.invoke("queued");
    queued.cancel("stop");
    release();

    assert.strictEqual(await ok.error, undefined);

    const badRejection = await bad.data.then(() => undefined, (e: Error) => e);
    const badError = await bad.error;
    assert.strictEqual(badError?.message, "nope");
    assert.strictEqual(badError, badRejection);

    const cancelError = await queued.error;
    assert.ok(cancelError instanceof CancellationError);
    assert.strictEqual((await queued.event).error, cancelError);
})();

await test("batch items cancelled while queued get a cancellation event on their result and onEvent", async () => {
    const delivered: WideEvent<[number], number>[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const action = createAction(async (n: number) => {
        await gate;
        return n;
    }).setConcurrency(1).onEvent((event) => { delivered.push(event); });

    const pending = action.invokeAll([1, 2, 3]);
    await delay(10);
    assert.strictEqual(action.clearQueue("stop"), 2);
    release();
    const results = await pending;

    assert.strictEqual(results[0]!.data, 1);
    for (const result of results.slice(1)) {
        assert.strictEqual(result.event.cancelled, true);
        assert.strictEqual(result.event.cancelledAt, "queued");
        assert.strictEqual(result.event.cancelReason, "stop");
        assert.strictEqual(result.event.batchId, results[0]!.event.batchId);
        assert.ok(delivered.includes(result.event));
    }
    assert.strictEqual(delivered.length, 3);
})();

await test("unstarted stream items on shutdown: one onEvent at a time, events land in the parent's children", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const child = createAction(async (n: number) => {
        await gate;
        return n;
    }).setConcurrency(1).onEvent(async (event) => {
        if (!event.cancelled) return;
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await delay(5);
        inFlight--;
    });

    let parentChildIds: string[] = [];
    const parent = createAction(async () => {
        const stream = child.invokeStream([1, 2, 3, 4]);
        const first = stream.next(); // starts the batch
        await delay(10);
        const shutdown = child["scheduler"].shutdown({ mode: "graceful", timeout: 1000 });
        release();
        const results = [(await first).value!];
        for await (const result of stream) results.push(result);
        await shutdown;
        return results;
    }).onEvent((event) => {
        parentChildIds = (event.children ?? []).map((c) => c.actionId);
    });

    const handle = parent.invoke();
    const results = await handle.data;
    await handle.event;

    const ran = results.filter((r) => !r.error);
    const unstarted = results.filter((r) => r.error);
    assert.deepStrictEqual(ran.map((r) => r.data), [1]);
    assert.strictEqual(unstarted.length, 3);
    for (const result of unstarted) {
        assert.ok(result.error instanceof CancellationError);
        assert.strictEqual(result.event.error, result.error);
        assert.strictEqual(result.event.cancelledAt, "queued");
        assert.strictEqual(result.event.batchId, ran[0]!.event.batchId);
    }
    assert.strictEqual(maxInFlight, 1);
    assert.deepStrictEqual([...parentChildIds].sort(), results.map((r) => r.actionId).sort());

    const [late] = await child.invokeAll([5]);
    assert.ok(late!.error instanceof CancellationError);
    assert.strictEqual(late!.event.error, late!.error);
})();

await test("batch final events keep retry and timeout details; retried attempts carry batchId", async () => {
    const events: WideEvent<[number], number>[] = [];
    const action = createAction(async (n: number): Promise<number> => {
        throw new Error(`fail ${n}`);
    })
        .setRetry({ maxRetries: 1, backoff: "linear", baseDelay: 1 })
        .setTimeout(1000)
        .onEvent((event) => { events.push(event); });

    const [result] = await action.invokeAll([1]);
    const final = result!.event;

    assert.strictEqual(events.length, 2);
    assert.strictEqual(events[0]!.willRetry, true);
    assert.strictEqual(events[0]!.batchId, final.batchId);
    assert.strictEqual(events[1], final);
    assert.strictEqual(final.retryAttempt, 1);
    assert.strictEqual(final.totalAttempts, 2);
    assert.strictEqual(final.willRetry, false);
    assert.strictEqual(final.timedOut, false);
    assert.strictEqual(final.retryDelays?.length, 1);
})();

await test("batch result.event keeps captured logs even when onEvent throws", async () => {
    const origErr = console.error;
    console.error = () => {};
    try {
        const action = createAction(async (n: number) => {
            console.log(`item-${n}`);
            return n;
        })
            .captureConsole({ passthrough: false })
            .onEvent(() => { throw new Error("sink down"); });

        const results = await action.invokeAll([1, 2]);
        for (const result of results) {
            assert.strictEqual(result.event.output, result.data);
            assert.deepStrictEqual(result.event.logs?.map((l) => l.message), [`item-${result.data}`]);
        }
    } finally {
        console.error = origErr;
    }
})();

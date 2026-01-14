import { test, assert, delay, printSection } from "./helpers.js";
import { createAction, withContext, type InvocationContext, type WideEvent } from "../actions/index.js";

printSection("Wide Event Tests - Attach API");

await test("should create action with context and capture basic event", async () => {
    const events: WideEvent<[string], string>[] = [];
    
    const action = createAction(
        withContext(async (ctx, name: string) => {
            return `Hello, ${name}!`;
        })
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
        withContext(async (ctx, name: string, age: number) => {
            ctx.attach("userName", name);
            ctx.attach("userAge", age);
            return `User: ${name} (${age})`;
        })
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
        withContext(async (ctx, input: string) => {
            ctx.attach("single", "value");
            ctx.attach({ nested: { key: "value" }, count: 42 });
            return `Result: ${input}`;
        })
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
        withContext(async (ctx: InvocationContext, input: string) => {
            ctx.attach("db", { queryMs: 100, rows: 5 });
            ctx.attach("db", { cached: true });  // Should merge
            return "result";
        })
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
        withContext(async (ctx, input: string) => {
            ctx.attach("step", "before-error");
            throw new Error("Test error");
        })
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

await test("should provide eventLogged promise", async () => {
    let callbackCalled = false;
    
    const action = createAction(
        withContext(async (ctx, input: string) => {
            return input;
        })
    ).onEvent(async (event) => {
        await delay(50);
        callbackCalled = true;
    });

    const { data, eventLogged } = action.invoke("test");
    const result = await data;
    
    assert.strictEqual(result, "test");
    // Callback may have started but not finished yet due to delay
    
    await eventLogged; // Wait for callback
    
    assert.strictEqual(callbackCalled, true);
})();

await test("eventLogged should resolve even without callback", async () => {
    const action = createAction(
        withContext(async (ctx, input: string) => {
            return input;
        })
    );

    const { data, eventLogged } = action.invoke("test");
    await data;
    await eventLogged; // Should resolve immediately
    
    // If we get here, test passes
    assert.ok(true);
})();

await test("should isolate event callback errors", async () => {
    const action = createAction(
        withContext(async (ctx, input: string) => {
            ctx.attach("data", "value");
            return "success";
        })
    ).onEvent((event) => {
        throw new Error("Callback error");
    });

    const { data, eventLogged } = action.invoke("test");
    const result = await data;
    
    assert.strictEqual(result, "success"); // Handler succeeded
    
    try {
        await eventLogged;
        assert.fail("Should have rejected");
    } catch (e) {
        assert.strictEqual((e as Error).message, "Callback error");
    }
})();

printSection("Batch Operations with Wide Events");

await test("invokeAll should emit events for each invocation", async () => {
    const events: WideEvent<[number], number>[] = [];
    
    const action = createAction(
        withContext(async (ctx, n: number) => {
            ctx.attach("input", n);
            return n * 2;
        })
    ).onEvent((event) => {
        events.push(event as any);
    });

    const results = await action.invokeAll([[1], [2], [3]]);
    
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
        withContext(async (ctx, n: number) => {
            ctx.attach("processed", n);
            await delay(n * 10);
            return n;
        })
    ).onEvent((event) => {
        events.push(event as any);
    });

    const results: number[] = [];
    for await (const result of action.invokeStream([[3], [1], [2]])) {
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
        withContext(async (ctx, delayMs: number) => {
            await delay(delayMs);
            return delayMs;
        })
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

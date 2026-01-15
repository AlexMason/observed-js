import { createAction } from "../index.js";
import { assert, test, delay, printSection } from "./helpers.js";

async function runTests() {
    console.log("\n🧪 Running Action Builder Tests\n");
    
    printSection("Basic Functionality");

    // Test 1: Async handler with multiple parameters
    await test("should handle async handlers with multiple parameters", async () => {
        async function asyncHandler(myStr: string, myBool: boolean) {
            return { success: true, message: myStr };
        }

        const action = createAction(asyncHandler)
            .setConcurrency(5)
            .setRateLimit(20);

        const result = await action.invoke("Hello", true).data;
        
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.message, "Hello");
    })();

    // Test 2: Sync handler
    await test("should handle synchronous handlers", async () => {
        function syncHandler(num: number) {
            return { doubled: num * 2 };
        }

        const action = createAction(syncHandler);
        const result = await action.invoke(21).data;
        
        assert.strictEqual(result.doubled, 42);
    })();

    // Test 3: Handler with no parameters
    await test("should handle handlers with no parameters", async () => {
        async function noParamHandler() {
            return { timestamp: Date.now() };
        }

        const action = createAction(noParamHandler);
        const result = await action.invoke().data;
        
        assert.ok(result.timestamp > 0);
    })();

    // Test 4: Handler with complex return types
    await test("should handle complex return types", async () => {
        async function complexHandler(items: string[]) {
            return {
                count: items.length,
                items: items.map(i => i.toUpperCase()),
                metadata: { processed: true }
            };
        }

        const action = createAction(complexHandler);
        const result = await action.invoke(["a", "b", "c"]).data;
        
        assert.strictEqual(result.count, 3);
        assert.deepStrictEqual(result.items, ["A", "B", "C"]);
        assert.strictEqual(result.metadata.processed, true);
    })();

    // Test 5: Request ID generation
    await test("should generate unique request IDs", async () => {
        async function handler() {
            return { ok: true };
        }

        const action = createAction(handler);
        const result1 = action.invoke();
        const result2 = action.invoke();
        
        assert.notStrictEqual(result1.actionId, result2.actionId);
        assert.ok(result1.actionId.length > 0);
        assert.ok(result2.actionId.length > 0);
    })();

    // Test 6: Builder pattern chaining
    await test("should support method chaining", async () => {
        async function handler(x: number) {
            return { value: x };
        }

        const action = createAction(handler)
            .setConcurrency(10)
            .setRateLimit(100);
        
        const result = await action.invoke(42).data;
        assert.strictEqual(result.value, 42);
    })();

    // Test 7: Error handling in async handlers
    await test("should propagate errors from async handlers", async () => {
        async function errorHandler() {
            throw new Error("Handler error");
        }

        const action = createAction(errorHandler);
        
        try {
            await action.invoke().data;
            throw new Error("Should have thrown");
        } catch (error: any) {
            assert.strictEqual(error.message, "Handler error");
        }
    })();

    // Test 8: Error handling in sync handlers
    await test("should propagate errors from sync handlers", async () => {
        function syncErrorHandler() {
            throw new Error("Sync error");
        }

        const action = createAction(syncErrorHandler);
        
        try {
            await action.invoke().data;
            throw new Error("Should have thrown");
        } catch (error: any) {
            assert.strictEqual(error.message, "Sync error");
        }
    })();

    // Test 9: Type safety validation (compile-time test)
    await test("should maintain type safety from handler to result", async () => {
        async function typedHandler(name: string, age: number, active: boolean) {
            return {
                user: { name, age },
                isActive: active,
                timestamp: new Date().toISOString()
            };
        }

        const action = createAction(typedHandler);
        const result = await action.invoke("Alice", 30, true).data;
        
        assert.strictEqual(result.user.name, "Alice");
        assert.strictEqual(result.user.age, 30);
        assert.strictEqual(result.isActive, true);
        assert.ok(typeof result.timestamp === "string");
    })();

    printSection("Concurrency Tests");

    // Test 10: Sequential execution by default
    await test("should execute sequentially by default (concurrency=1)", async () => {
        const executionOrder: number[] = [];
        let running = 0;
        let maxConcurrent = 0;

        async function handler(id: number) {
            running++;
            maxConcurrent = Math.max(maxConcurrent, running);
            executionOrder.push(id);
            await delay(20);
            running--;
            return { id };
        }

        const action = createAction(handler);
        
        // Fire multiple invocations
        const promises = [
            action.invoke(1).data,
            action.invoke(2).data,
            action.invoke(3).data
        ];
        
        await Promise.all(promises);
        
        // Should execute one at a time
        assert.strictEqual(maxConcurrent, 1, `Expected max 1 concurrent, got ${maxConcurrent}`);
        assert.deepStrictEqual(executionOrder, [1, 2, 3]);
    })();

    // Test 11: Concurrent execution with limit
    await test("should respect concurrency limit", async () => {
        let running = 0;
        let maxConcurrent = 0;

        async function handler(id: number) {
            running++;
            maxConcurrent = Math.max(maxConcurrent, running);
            await delay(50);
            running--;
            return { id };
        }

        const action = createAction(handler).setConcurrency(3);
        
        // Fire 5 invocations
        const promises = [1, 2, 3, 4, 5].map(id => action.invoke(id).data);
        
        await Promise.all(promises);
        
        // Should have at most 3 running concurrently
        assert.ok(maxConcurrent <= 3, `Expected max 3 concurrent, got ${maxConcurrent}`);
        assert.ok(maxConcurrent >= 2, `Expected at least 2 concurrent for this test, got ${maxConcurrent}`);
    })();

    // Test 12: Queue processes after completion
    await test("should process queue as executions complete", async () => {
        const completionOrder: number[] = [];

        async function handler(id: number, delayMs: number) {
            await delay(delayMs);
            completionOrder.push(id);
            return { id };
        }

        const action = createAction(handler).setConcurrency(2);
        
        // Fire tasks with varying delays
        const promises = [
            action.invoke(1, 60).data,  // Slower
            action.invoke(2, 20).data,  // Fast
            action.invoke(3, 10).data,  // Fastest (but queued initially)
        ];
        
        await Promise.all(promises);
        
        // Task 2 should complete first, then task 3 runs and completes, then task 1
        assert.strictEqual(completionOrder[0], 2, "Task 2 should complete first");
    })();

    printSection("Rate Limiting Tests");

    // Test 13: Rate limiting enforcement
    await test("should enforce rate limiting", async () => {
        let executionCount = 0;
        const timestamps: number[] = [];

        async function handler() {
            executionCount++;
            timestamps.push(Date.now());
            return { count: executionCount };
        }

        const action = createAction(handler)
            .setConcurrency(100) // High concurrency
            .setRateLimit(5);    // But only 5 per second

        // Fire 8 rapid invocations
        const startTime = Date.now();
        const promises = Array(8).fill(null).map(() => action.invoke().data);
        
        await Promise.all(promises);
        const endTime = Date.now();
        
        // Should have taken at least 600ms (5 in first second, 3 more delayed)
        const duration = endTime - startTime;
        assert.ok(duration >= 500, `Expected at least 500ms duration, got ${duration}ms`);
        assert.strictEqual(executionCount, 8);
    })();

    // Test 14: Combined concurrency and rate limiting
    await test("should handle combined concurrency and rate limiting", async () => {
        let running = 0;
        let maxConcurrent = 0;
        let executionCount = 0;

        async function handler(id: number) {
            running++;
            maxConcurrent = Math.max(maxConcurrent, running);
            executionCount++;
            await delay(30);
            running--;
            return { id };
        }

        const action = createAction(handler)
            .setConcurrency(2)   // Max 2 concurrent
            .setRateLimit(10);   // Max 10 per second

        const promises = [1, 2, 3, 4, 5].map(id => action.invoke(id).data);
        
        await Promise.all(promises);
        
        assert.ok(maxConcurrent <= 2, `Expected max 2 concurrent, got ${maxConcurrent}`);
        assert.strictEqual(executionCount, 5);
    })();

    printSection("Batch Invocation Tests - invokeAll()");

    // Test 15: invokeAll basic functionality
    await test("invokeAll should return all results in input order", async () => {
        async function handler(value: number) {
            await delay(Math.random() * 20); // Random delay
            return { doubled: value * 2 };
        }

        const action = createAction(handler).setConcurrency(5);
        
        const results = await action.invokeAll([
            [1], [2], [3], [4], [5]
        ]);
        
        assert.strictEqual(results.length, 5);
        assert.strictEqual(results[0]!.index, 0);
        assert.strictEqual(results[0]!.data?.doubled, 2);
        assert.strictEqual(results[4]!.index, 4);
        assert.strictEqual(results[4]!.data?.doubled, 10);
    })();

    // Test 16: invokeAll with partial failures
    await test("invokeAll should handle partial failures", async () => {
        async function handler(value: number) {
            if (value === 3) {
                throw new Error("Value 3 is not allowed");
            }
            return { value };
        }

        const action = createAction(handler).setConcurrency(5);
        
        const results = await action.invokeAll([
            [1], [2], [3], [4], [5]
        ]);
        
        assert.strictEqual(results.length, 5);
        
        // Check successes
        assert.strictEqual(results[0]!.data?.value, 1);
        assert.strictEqual(results[0]!.error, undefined);
        
        // Check failure
        assert.strictEqual(results[2]!.data, undefined);
        assert.ok(results[2]!.error instanceof Error);
        assert.strictEqual(results[2]!.error?.message, "Value 3 is not allowed");
        
        // Check rest succeeded
        assert.strictEqual(results[4]!.data?.value, 5);
    })();

    // Test 17: invokeAll with empty array
    await test("invokeAll should handle empty payload array", async () => {
        async function handler(value: number) {
            return { value };
        }

        const action = createAction(handler);
        const results = await action.invokeAll([]);
        
        assert.strictEqual(results.length, 0);
    })();

    // Test 18: invokeAll respects concurrency
    await test("invokeAll should respect concurrency limits", async () => {
        let running = 0;
        let maxConcurrent = 0;

        async function handler(id: number) {
            running++;
            maxConcurrent = Math.max(maxConcurrent, running);
            await delay(20);
            running--;
            return { id };
        }

        const action = createAction(handler).setConcurrency(3);
        
        await action.invokeAll([
            [1], [2], [3], [4], [5], [6]
        ]);
        
        assert.ok(maxConcurrent <= 3, `Expected max 3 concurrent, got ${maxConcurrent}`);
    })();

    printSection("Batch Invocation Tests - invokeStream()");

    // Test 19: invokeStream yields results as they complete
    await test("invokeStream should yield results as they complete", async () => {
        async function handler(id: number, delayMs: number) {
            await delay(delayMs);
            return { id };
        }

        const action = createAction(handler).setConcurrency(5);
        
        const completionOrder: number[] = [];
        
        for await (const result of action.invokeStream([
            [1, 100],  // Slowest
            [2, 50],   // Medium
            [3, 10],   // Fastest
        ])) {
            completionOrder.push(result.data!.id);
        }
        
        // Should complete in order: 3, 2, 1 (by delay)
        assert.strictEqual(completionOrder[0], 3, "Fastest should complete first");
        assert.strictEqual(completionOrder[1], 2, "Medium should complete second");
        assert.strictEqual(completionOrder[2], 1, "Slowest should complete last");
    })();

    // Test 20: invokeStream handles errors
    await test("invokeStream should handle errors without stopping", async () => {
        async function handler(value: number) {
            if (value === 2) {
                throw new Error("Value 2 failed");
            }
            return { value };
        }

        const action = createAction(handler).setConcurrency(3);
        
        const results: any[] = [];
        
        for await (const result of action.invokeStream([
            [1], [2], [3]
        ])) {
            results.push(result);
        }
        
        assert.strictEqual(results.length, 3);
        
        // Find the error result
        const errorResult = results.find(r => r.error);
        assert.ok(errorResult, "Should have an error result");
        assert.strictEqual(errorResult.error.message, "Value 2 failed");
        
        // Should still have successful results
        const successResults = results.filter(r => r.data);
        assert.strictEqual(successResults.length, 2);
    })();

    // Test 21: invokeStream with empty array
    await test("invokeStream should handle empty payload array", async () => {
        async function handler(value: number) {
            return { value };
        }

        const action = createAction(handler);
        
        const results: any[] = [];
        for await (const result of action.invokeStream([])) {
            results.push(result);
        }
        
        assert.strictEqual(results.length, 0);
    })();

    // Test 22: invokeStream respects concurrency
    await test("invokeStream should respect concurrency limits", async () => {
        let running = 0;
        let maxConcurrent = 0;

        async function handler(id: number) {
            running++;
            maxConcurrent = Math.max(maxConcurrent, running);
            await delay(20);
            running--;
            return { id };
        }

        const action = createAction(handler).setConcurrency(2);
        
        const results: any[] = [];
        for await (const result of action.invokeStream([
            [1], [2], [3], [4], [5]
        ])) {
            results.push(result);
        }
        
        assert.strictEqual(results.length, 5);
        assert.ok(maxConcurrent <= 2, `Expected max 2 concurrent, got ${maxConcurrent}`);
    })();

    printSection("Edge Cases");

    // Test 23: Very high concurrency (effectively unlimited)
    await test("should handle very high concurrency limit", async () => {
        let maxConcurrent = 0;
        let running = 0;

        async function handler(id: number) {
            running++;
            maxConcurrent = Math.max(maxConcurrent, running);
            await delay(10);
            running--;
            return { id };
        }

        const action = createAction(handler).setConcurrency(1000);
        
        const promises = Array(10).fill(null).map((_, i) => action.invoke(i).data);
        await Promise.all(promises);
        
        // All 10 should run concurrently
        assert.strictEqual(maxConcurrent, 10);
    })();

    // Test 24: Error in one doesn't affect queue
    await test("error in one execution should not affect queue", async () => {
        const results: number[] = [];

        async function handler(id: number) {
            if (id === 2) {
                throw new Error("Intentional error");
            }
            results.push(id);
            return { id };
        }

        const action = createAction(handler).setConcurrency(1);
        
        const promises = [
            action.invoke(1).data.catch(() => null),
            action.invoke(2).data.catch(() => null),
            action.invoke(3).data.catch(() => null),
        ];
        
        await Promise.all(promises);
        
        // Should still process 1 and 3
        assert.ok(results.includes(1));
        assert.ok(results.includes(3));
    })();
}

await runTests();

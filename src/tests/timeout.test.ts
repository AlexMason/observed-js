import { createAction, withContext, withAbortSignal, TimeoutError, type WideEvent } from "../actions/index.js";
import { test, assert, delay, printSection } from "./helpers.js";

printSection("Timeout Tests");

// Test 1: Handler completes before timeout
await test("should return result when handler completes before timeout", async () => {
    const action = createAction(async (value: number) => {
        await delay(50);
        return value * 2;
    }).setTimeout(200);

    const result = await action.invoke(5).data;
    assert.strictEqual(result, 10);
})();

// Test 2: Handler exceeds timeout
await test("should throw TimeoutError when handler exceeds timeout", async () => {
    const action = createAction(async (value: number) => {
        await delay(200);
        return value * 2;
    }).setTimeout(50);

    try {
        await action.invoke(5).data;
        assert.fail("Should have thrown TimeoutError");
    } catch (error) {
        assert.ok(error instanceof TimeoutError);
        assert.strictEqual((error as TimeoutError).duration, 50);
    }
})();

// Test 3: Timeout metadata in events
await test("should include timeout metadata in events", async () => {
    const events: WideEvent<[number], number>[] = [];
    
    const action = createAction(async (value: number) => {
        await delay(50);
        return value * 2;
    })
    .setTimeout(200)
    .onEvent((event) => {
        events.push(event);
    });

    await action.invoke(5).data;
    
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0]!.timeout, 200);
    assert.strictEqual(events[0]!.timedOut, false);
    assert.strictEqual(events[0]!.output, 10);
})();

// Test 4: Timeout event with timedOut flag
await test("should set timedOut flag in event when timeout occurs", async () => {
    const events: WideEvent<[number], number>[] = [];
    
    const action = createAction(async (value: number) => {
        await delay(200);
        return value * 2;
    })
    .setTimeout(50)
    .onEvent((event) => {
        events.push(event);
    });

    try {
        await action.invoke(5).data;
    } catch (error) {
        // Expected timeout error
    }
    
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0]!.timeout, 50);
    assert.strictEqual(events[0]!.timedOut, true);
    assert.ok(events[0]!.error instanceof TimeoutError);
    assert.ok(events[0]!.executionTime !== undefined);
    assert.ok(events[0]!.executionTime! >= 45); // Allow some timing variance
})();

// Test 5: Attachments preserved in timeout events
await test("should preserve attachments in timeout events", async () => {
    const events: WideEvent<[string], string>[] = [];
    
    const action = createAction(
        withContext(async (ctx, userId: string) => {
            ctx.attach("userId", userId);
            ctx.attach("step", "started");
            await delay(200);
            ctx.attach("step", "completed"); // Won't be reached
            return `processed-${userId}`;
        })
    )
    .setTimeout(50)
    .onEvent((event) => {
        events.push(event as any);
    });

    try {
        await action.invoke("user123").data;
    } catch (error) {
        // Expected timeout error
    }
    
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0]!.attachments.userId, "user123");
    assert.strictEqual(events[0]!.attachments.step, "started");
    assert.strictEqual(events[0]!.timedOut, true);
})();

// Test 6: Timeout with retry - each attempt gets fresh timeout
await test("should apply fresh timeout to each retry attempt", async () => {
    const events: WideEvent<[number], number>[] = [];
    let attemptCount = 0;
    
    const action = createAction(async (value: number) => {
        attemptCount++;
        await delay(100); // Takes 100ms each time
        if (attemptCount < 3) {
            throw new Error("Retry me");
        }
        return value * 2;
    })
    .setTimeout(150) // Each attempt has 150ms timeout
    .setRetry({
        maxRetries: 3,
        backoff: 'linear',
        baseDelay: 10
    })
    .onEvent((event) => {
        events.push(event);
    });

    const result = await action.invoke(5).data;
    
    assert.strictEqual(result, 10);
    assert.strictEqual(attemptCount, 3);
    // Should have intermediate events for failed attempts + final success
    assert.ok(events.length >= 1);
})();

// Test 7: Timeout with retry - timeout errors can be retried
await test("should retry timeout errors if shouldRetry allows", async () => {
    let attemptCount = 0;
    
    const action = createAction(async (value: number) => {
        attemptCount++;
        if (attemptCount === 1) {
            await delay(200); // First attempt times out
        } else {
            await delay(10); // Subsequent attempts succeed quickly
        }
        return value * 2;
    })
    .setTimeout(50)
    .setRetry({
        maxRetries: 2,
        backoff: 'linear',
        baseDelay: 10,
        shouldRetry: (error) => error instanceof TimeoutError
    });

    const result = await action.invoke(5).data;
    
    assert.strictEqual(result, 10);
    assert.strictEqual(attemptCount, 2); // First timed out, second succeeded
})();

// Test 8: Timeout in batch operations
await test("should handle timeouts in batch operations independently", async () => {
    const action = createAction(async (delay_ms: number) => {
        await delay(delay_ms);
        return delay_ms;
    }).setTimeout(100);

    const results = await action.invokeAll([
        [50],   // Succeeds
        [150],  // Times out
        [30],   // Succeeds
        [200]   // Times out
    ]);

    assert.strictEqual(results.length, 4);
    
    assert.strictEqual(results[0]!.error, undefined);
    assert.strictEqual(results[0]!.data, 50);
    
    assert.ok(results[1]!.error instanceof TimeoutError);
    assert.strictEqual(results[1]!.data, undefined);
    
    assert.strictEqual(results[2]!.error, undefined);
    assert.strictEqual(results[2]!.data, 30);
    
    assert.ok(results[3]!.error instanceof TimeoutError);
    assert.strictEqual(results[3]!.data, undefined);
})();

// Test 9: AbortSignal integration
await test("should provide AbortSignal when configured", async () => {
    let signalReceived: AbortSignal | null = null;
    
    const action = createAction(
        withAbortSignal(async (signal, value: number) => {
            signalReceived = signal;
            assert.strictEqual(signal.aborted, false);
            
            // Simulate checking signal periodically
            for (let i = 0; i < 5; i++) {
                if (signal.aborted) {
                    throw new Error("Aborted");
                }
                await delay(20);
            }
            
            return value * 2;
        })
    ).setTimeout({ duration: 200, abortSignal: true });

    const result = await action.invoke(5).data;
    
    assert.strictEqual(result, 10);
    assert.ok(signalReceived !== null);
    assert.ok((signalReceived as any) instanceof AbortSignal);
})();

// Test 10: AbortSignal cancellation on timeout
await test("should abort signal when timeout occurs", async () => {
    let wasAborted = false;
    
    const action = createAction(
        withAbortSignal(async (signal, value: number) => {
            // Listen for abort
            signal.addEventListener('abort', () => {
                wasAborted = true;
            });
            
            // Simulate long-running operation that should be cancelled
            await delay(200); // Will timeout at 50ms
            
            // Check if we were aborted
            if (signal.aborted) {
                throw new Error("Aborted");
            }
            
            return value * 2;
        })
    ).setTimeout({ duration: 50, abortSignal: true });

    try {
        await action.invoke(5).data;
        assert.fail("Should have thrown TimeoutError");
    } catch (error) {
        // The TimeoutError is thrown by the timeout mechanism, not the handler
        assert.ok(error instanceof TimeoutError || (error as Error).message === "Aborted");
    }
    
    // Give abort event time to fire
    await delay(50);
    assert.strictEqual(wasAborted, true);
})();

// Test 11: Timeout validation
await test("should validate timeout configuration", async () => {
    try {
        createAction(async () => "test").setTimeout(0);
        assert.fail("Should have thrown validation error");
    } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok((error as Error).message.includes("positive"));
    }
    
    try {
        createAction(async () => "test").setTimeout(-100);
        assert.fail("Should have thrown validation error");
    } catch (error) {
        assert.ok(error instanceof Error);
        assert.ok((error as Error).message.includes("positive"));
    }
})();

// Test 12: Timeout with concurrency
await test("should release concurrency slot after timeout", async () => {
    let startedCount = 0;
    let completedCount = 0;
    
    const action = createAction(async (delay_ms: number) => {
        startedCount++;
        await delay(delay_ms);
        completedCount++;
        return delay_ms;
    })
    .setTimeout(50)
    .setConcurrency(2);

    const promises = [
        action.invoke(200).data.catch(e => e), // Times out at 50ms
        action.invoke(200).data.catch(e => e), // Times out at 50ms
        action.invoke(10).data,  // Succeeds quickly
        action.invoke(10).data   // Succeeds quickly
    ];

    const results = await Promise.all(promises);
    
    // All 4 tasks should have started
    assert.strictEqual(startedCount, 4);
    
    // Check that 2 succeeded and 2 timed out
    const timeouts = results.filter(r => r instanceof TimeoutError);
    const successes = results.filter(r => typeof r === 'number');
    assert.strictEqual(timeouts.length, 2);
    assert.strictEqual(successes.length, 2);
})();

// Test 13: Timeout with rate limiting
await test("should respect rate limit with timeouts", async () => {
    const timestamps: number[] = [];
    
    const action = createAction(async (value: number) => {
        timestamps.push(Date.now());
        await delay(10);
        return value;
    })
    .setTimeout(100)
    .setRateLimit(5); // 5 per second

    // Execute 6 tasks
    const results = await action.invokeAll([
        [1], [2], [3], [4], [5], [6]
    ]);

    assert.strictEqual(results.length, 6);
    
    // Check that rate limiting was applied (6th should be delayed)
    if (timestamps.length >= 6) {
        const timeDiff = timestamps[5]! - timestamps[0]!;
        assert.ok(timeDiff >= 1000); // At least 1 second for 6 tasks at 5/sec
    }
})();

// Test 14: Timeout without throwOnTimeout (silent timeout)
await test("should not throw when throwOnTimeout is false", async () => {
    const events: WideEvent<[number], number>[] = [];
    
    const action = createAction(async (value: number) => {
        await delay(200);
        return value * 2;
    })
    .setTimeout({ duration: 50, throwOnTimeout: false })
    .onEvent((event) => {
        events.push(event);
    });

    // Should not throw, but result will be undefined
    const result = await action.invoke(5).data;
    
    assert.strictEqual(result, undefined);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0]!.timedOut, true);
    assert.strictEqual(events[0]!.output, undefined);
})();

// Test 15: Timeout with stream invocation
await test("should handle timeouts in stream invocations", async () => {
    const action = createAction(async (delay_ms: number) => {
        await delay(delay_ms);
        return delay_ms;
    }).setTimeout(100);

    const results: any[] = [];
    for await (const result of action.invokeStream([[50], [150], [30]])) {
        results.push(result);
    }

    assert.strictEqual(results.length, 3);
    
    // Find results by their data/error
    const successResults = results.filter(r => r.error === undefined);
    const failureResults = results.filter(r => r.error instanceof TimeoutError);
    
    assert.strictEqual(successResults.length, 2); // 50ms and 30ms
    assert.strictEqual(failureResults.length, 1); // 150ms
})();

printSection("Timeout Tests Complete ✓");

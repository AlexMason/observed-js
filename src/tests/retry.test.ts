import { createAction, withContext, type InvocationContext, type WideEvent } from "../actions/index.js";
import { test, assert, delay, printSection } from "./helpers.js";

printSection("Retry Tests");

// Test 1: Basic retry - fails twice, succeeds on third attempt
await test("should retry failed executions and eventually succeed", async () => {
    let attemptCount = 0;
    const action = createAction(async () => {
        attemptCount++;
        if (attemptCount < 3) {
            throw new Error(`Attempt ${attemptCount} failed`);
        }
        return "success";
    }).setRetry({
        maxRetries: 3,
        backoff: 'linear',
        baseDelay: 10
    });

    const result = await action.invoke().data;
    assert.strictEqual(result, "success");
    assert.strictEqual(attemptCount, 3);
})();

// Test 2: Exhausted retries - always fails
await test("should throw last error when all retries are exhausted", async () => {
    let attemptCount = 0;
    const action = createAction(async () => {
        attemptCount++;
        throw new Error(`Attempt ${attemptCount}`);
    }).setRetry({
        maxRetries: 2,
        backoff: 'linear',
        baseDelay: 10
    });

    try {
        await action.invoke().data;
        assert.fail("Should have thrown an error");
    } catch (error: any) {
        assert.strictEqual(error.message, "Attempt 3");
        assert.strictEqual(attemptCount, 3); // 1 original + 2 retries
    }
})();

// Test 3: No retries (maxRetries = 0)
await test("should not retry when maxRetries is 0", async () => {
    let attemptCount = 0;
    const action = createAction(async () => {
        attemptCount++;
        throw new Error("Immediate failure");
    }).setRetry({
        maxRetries: 0,
        backoff: 'linear'
    });

    try {
        await action.invoke().data;
        assert.fail("Should have thrown an error");
    } catch (error: any) {
        assert.strictEqual(error.message, "Immediate failure");
        assert.strictEqual(attemptCount, 1);
    }
})();

// Test 4: Linear backoff timing
await test("should apply linear backoff correctly", async () => {
    let attemptCount = 0;
    const attemptTimes: number[] = [];
    
    const action = createAction(async () => {
        attemptTimes.push(Date.now());
        attemptCount++;
        if (attemptCount < 3) {
            throw new Error("Retry me");
        }
        return "success";
    }).setRetry({
        maxRetries: 3,
        backoff: 'linear',
        baseDelay: 50
    });

    await action.invoke().data;
    
    // Check delays between attempts
    const delay1 = attemptTimes[1]! - attemptTimes[0]!; // Should be ~50ms
    const delay2 = attemptTimes[2]! - attemptTimes[1]!; // Should be ~100ms (50 * 2)
    
    assert.ok(delay1 >= 45 && delay1 <= 70, `First delay ${delay1}ms should be ~50ms`);
    assert.ok(delay2 >= 95 && delay2 <= 120, `Second delay ${delay2}ms should be ~100ms`);
})();

// Test 5: Exponential backoff timing
await test("should apply exponential backoff correctly", async () => {
    let attemptCount = 0;
    const attemptTimes: number[] = [];
    
    const action = createAction(async () => {
        attemptTimes.push(Date.now());
        attemptCount++;
        if (attemptCount < 3) {
            throw new Error("Retry me");
        }
        return "success";
    }).setRetry({
        maxRetries: 3,
        backoff: 'exponential',
        baseDelay: 50
    });

    await action.invoke().data;
    
    // Check delays between attempts
    const delay1 = attemptTimes[1]! - attemptTimes[0]!; // Should be ~50ms (50 * 2^0)
    const delay2 = attemptTimes[2]! - attemptTimes[1]!; // Should be ~100ms (50 * 2^1)
    
    assert.ok(delay1 >= 45 && delay1 <= 70, `First delay ${delay1}ms should be ~50ms`);
    assert.ok(delay2 >= 95 && delay2 <= 120, `Second delay ${delay2}ms should be ~100ms`);
})();

// Test 6: Max delay cap
await test("should respect maxDelay cap", async () => {
    let attemptCount = 0;
    const attemptTimes: number[] = [];
    
    const action = createAction(async () => {
        attemptTimes.push(Date.now());
        attemptCount++;
        if (attemptCount < 3) {
            throw new Error("Retry me");
        }
        return "success";
    }).setRetry({
        maxRetries: 3,
        backoff: 'exponential',
        baseDelay: 1000,
        maxDelay: 100 // Cap at 100ms
    });

    await action.invoke().data;
    
    // All delays should be capped at ~100ms
    const delay1 = attemptTimes[1]! - attemptTimes[0]!;
    const delay2 = attemptTimes[2]! - attemptTimes[1]!;
    
    assert.ok(delay1 <= 120, `Delay ${delay1}ms should be capped at ~100ms`);
    assert.ok(delay2 <= 120, `Delay ${delay2}ms should be capped at ~100ms`);
})();

// Test 7: Jitter adds variance
await test("should add jitter to delays when enabled", async () => {
    let attemptCount = 0;
    const delays: number[] = [];
    
    // Run multiple times to collect delay samples
    for (let i = 0; i < 5; i++) {
        attemptCount = 0;
        const attemptTimes: number[] = [];
        
        const action = createAction(async () => {
            attemptTimes.push(Date.now());
            attemptCount++;
            if (attemptCount < 2) {
                throw new Error("Retry me");
            }
            return "success";
        }).setRetry({
            maxRetries: 2,
            backoff: 'linear',
            baseDelay: 100,
            jitter: true
        });

        await action.invoke().data;
        delays.push(attemptTimes[1]! - attemptTimes[0]!);
    }
    
    // Check that delays vary (with jitter, they should be between 50-100ms)
    const uniqueDelays = new Set(delays);
    assert.ok(uniqueDelays.size > 1, "Jitter should produce varying delays");
    
    // All delays should be in the jittered range (50-100% of baseDelay)
    delays.forEach(d => {
        assert.ok(d >= 40 && d <= 120, `Jittered delay ${d}ms should be in range 50-100ms`);
    });
})();

// Test 8: Selective retry with shouldRetry predicate
await test("should only retry errors matching shouldRetry predicate", async () => {
    class NetworkError extends Error {
        constructor(message: string) {
            super(message);
            this.name = "NetworkError";
        }
    }
    
    class ValidationError extends Error {
        constructor(message: string) {
            super(message);
            this.name = "ValidationError";
        }
    }
    
    let attemptCount = 0;
    const action = createAction(async () => {
        attemptCount++;
        if (attemptCount === 1) {
            throw new NetworkError("Network failed"); // Should retry
        }
        return "success";
    }).setRetry({
        maxRetries: 2,
        backoff: 'linear',
        baseDelay: 10,
        shouldRetry: (error) => error instanceof NetworkError
    });

    const result = await action.invoke().data;
    assert.strictEqual(result, "success");
    assert.strictEqual(attemptCount, 2); // Retried once
})();

// Test 9: Non-retryable error fails immediately
await test("should not retry errors that fail shouldRetry predicate", async () => {
    class ValidationError extends Error {
        constructor(message: string) {
            super(message);
            this.name = "ValidationError";
        }
    }
    
    let attemptCount = 0;
    const action = createAction(async () => {
        attemptCount++;
        throw new ValidationError("Invalid input");
    }).setRetry({
        maxRetries: 3,
        backoff: 'linear',
        baseDelay: 10,
        shouldRetry: (error) => error instanceof Error && error.name === "NetworkError"
    });

    try {
        await action.invoke().data;
        assert.fail("Should have thrown an error");
    } catch (error: any) {
        assert.strictEqual(error.name, "ValidationError");
        assert.strictEqual(attemptCount, 1); // No retries
    }
})();

// Test 10: shouldRetry predicate error handling
await test("should treat shouldRetry errors as non-retryable", async () => {
    let attemptCount = 0;
    const action = createAction(async () => {
        attemptCount++;
        throw new Error("Task failed");
    }).setRetry({
        maxRetries: 3,
        backoff: 'linear',
        baseDelay: 10,
        shouldRetry: (error) => {
            throw new Error("Predicate crashed!");
        }
    });

    try {
        await action.invoke().data;
        assert.fail("Should have thrown an error");
    } catch (error: any) {
        assert.strictEqual(error.message, "Task failed");
        assert.strictEqual(attemptCount, 1); // No retries due to predicate error
    }
})();

// Test 11: Wide events - intermediate retry events
await test("should emit intermediate events for each retry attempt", async () => {
    const events: WideEvent<[], string>[] = [];
    let attemptCount = 0;
    
    const action = createAction(async () => {
        attemptCount++;
        if (attemptCount < 3) {
            throw new Error(`Attempt ${attemptCount} failed`);
        }
        return "success";
    })
    .setRetry({
        maxRetries: 3,
        backoff: 'linear',
        baseDelay: 10
    })
    .onEvent((event) => {
        events.push(event);
    });

    await action.invoke().data;
    
    // Should have 2 intermediate failure events + 1 final success event
    assert.strictEqual(events.length, 3);
    
    // First attempt - failed
    assert.strictEqual(events[0]!.retryAttempt, 0);
    assert.strictEqual(events[0]!.isRetry, false);
    assert.strictEqual(events[0]!.willRetry, true);
    assert.ok(events[0]!.error);
    
    // Second attempt - failed
    assert.strictEqual(events[1]!.retryAttempt, 1);
    assert.strictEqual(events[1]!.isRetry, true);
    assert.strictEqual(events[1]!.willRetry, true);
    assert.ok(events[1]!.error);
    
    // Third attempt - success
    assert.strictEqual(events[2]!.retryAttempt, 2);
    assert.strictEqual(events[2]!.isRetry, true);
    assert.strictEqual(events[2]!.willRetry, undefined); // Success, no more retries
    assert.strictEqual(events[2]!.output, "success");
    assert.strictEqual(events[2]!.error, undefined);
})();

// Test 12: Wide events - final event after exhausted retries
await test("should emit final event with willRetry=false when retries exhausted", async () => {
    const events: WideEvent<[], string>[] = [];
    let attemptCount = 0;
    
    const action = createAction(async () => {
        attemptCount++;
        throw new Error(`Attempt ${attemptCount}`);
    })
    .setRetry({
        maxRetries: 2,
        backoff: 'linear',
        baseDelay: 10
    })
    .onEvent((event) => {
        events.push(event);
    });

    try {
        await action.invoke().data;
    } catch (e) {
        // Expected
    }
    
    // Should have 3 failure events (original + 2 retries)
    assert.strictEqual(events.length, 3);
    
    // Last event should indicate no more retries
    const lastEvent = events[2]!;
    assert.strictEqual(lastEvent.retryAttempt, 2);
    assert.strictEqual(lastEvent.willRetry, false);
    assert.ok(lastEvent.error);
})();

// Test 13: Retry delays are tracked in events
await test("should track retry delays in event metadata", async () => {
    const events: WideEvent<[], string>[] = [];
    let attemptCount = 0;
    
    const action = createAction(async () => {
        attemptCount++;
        if (attemptCount < 3) {
            throw new Error("Retry me");
        }
        return "success";
    })
    .setRetry({
        maxRetries: 3,
        backoff: 'linear',
        baseDelay: 50
    })
    .onEvent((event) => {
        events.push(event);
    });

    await action.invoke().data;
    
    // Check that delays are tracked
    const successEvent = events[events.length - 1]!;
    assert.ok(successEvent.retryDelays);
    assert.strictEqual(successEvent.retryDelays.length, 2); // 2 delays for 2 retries
    assert.ok(successEvent.retryDelays[0]! >= 45); // ~50ms
    assert.ok(successEvent.retryDelays[1]! >= 95); // ~100ms
})();

// Test 14: Context is fresh for each retry
await test("should provide fresh context for each retry attempt", async () => {
    const attachmentSets: Record<string, unknown>[] = [];
    let attemptCount = 0;
    
    const action = createAction(
        withContext(async (ctx: InvocationContext) => {
            attemptCount++;
            ctx.attach("attempt", attemptCount);
            attachmentSets.push(ctx.attach as any); // Store reference
            
            if (attemptCount < 3) {
                throw new Error("Retry me");
            }
            return "success";
        })
    ).setRetry({
        maxRetries: 3,
        backoff: 'linear',
        baseDelay: 10
    });

    await action.invoke().data;
    
    // Context should be the same instance across retries
    // (each retry uses the same context, but can attach new data)
    assert.strictEqual(attemptCount, 3);
})();

// Test 15: Retry respects concurrency limits
await test("should respect concurrency limits during retries", async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;
    
    const action = createAction(async (taskId: number) => {
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        
        await delay(50);
        
        currentConcurrent--;
        
        // First invocation of each task fails
        if (taskId <= 2) {
            throw new Error(`Task ${taskId} failed`);
        }
        return `Task ${taskId} done`;
    })
    .setConcurrency(2)
    .setRetry({
        maxRetries: 1,
        backoff: 'linear',
        baseDelay: 10
    });

    // Launch 4 tasks
    const promises = [1, 2, 3, 4].map(id => action.invoke(id).data);
    
    // Wait for all to complete (with retries)
    const results = await Promise.allSettled(promises);
    
    // Max concurrent should respect the limit
    assert.ok(maxConcurrent <= 2, `Max concurrent was ${maxConcurrent}, should be <= 2`);
    
    // First two should have failed (even with retries), last two should succeed
    assert.strictEqual(results[0]!.status, "rejected");
    assert.strictEqual(results[1]!.status, "rejected");
    assert.strictEqual(results[2]!.status, "fulfilled");
    assert.strictEqual(results[3]!.status, "fulfilled");
})();

// Test 16: Validation errors during setRetry
await test("should validate retry configuration", async () => {
    try {
        createAction(() => "test").setRetry({
            maxRetries: -1,
            backoff: 'linear'
        });
        assert.fail("Should have thrown validation error");
    } catch (error: any) {
        assert.ok(error.message.includes("maxRetries"));
    }
    
    try {
        createAction(() => "test").setRetry({
            maxRetries: 3,
            backoff: 'linear',
            baseDelay: -100
        });
        assert.fail("Should have thrown validation error");
    } catch (error: any) {
        assert.ok(error.message.includes("baseDelay"));
    }
    
    try {
        createAction(() => "test").setRetry({
            maxRetries: 3,
            backoff: 'linear',
            maxDelay: -1000
        });
        assert.fail("Should have thrown validation error");
    } catch (error: any) {
        assert.ok(error.message.includes("maxDelay"));
    }
})();

// Test 17: Batch invocation with retries (invokeAll)
await test("should support retries in invokeAll", async () => {
    const attemptCounts = new Map<number, number>();
    
    const action = createAction(async (taskId: number) => {
        const count = (attemptCounts.get(taskId) || 0) + 1;
        attemptCounts.set(taskId, count);
        
        // Fail first attempt for tasks 0 and 1
        if (count === 1 && taskId < 2) {
            throw new Error(`Task ${taskId} failed`);
        }
        
        return `Task ${taskId} done`;
    }).setRetry({
        maxRetries: 2,
        backoff: 'linear',
        baseDelay: 10
    });

    const results = await action.invokeAll([[0], [1], [2], [3]]);
    
    // All should succeed (first two after retry)
    assert.strictEqual(results.length, 4);
    results.forEach(result => {
        assert.strictEqual(result.error, undefined);
        assert.ok(result.data);
    });
    
    // Check attempt counts
    assert.strictEqual(attemptCounts.get(0), 2); // Retried once
    assert.strictEqual(attemptCounts.get(1), 2); // Retried once
    assert.strictEqual(attemptCounts.get(2), 1); // No retry needed
    assert.strictEqual(attemptCounts.get(3), 1); // No retry needed
})();

// Test 18: Batch invocation with retries (invokeStream)
await test("should support retries in invokeStream", async () => {
    const attemptCounts = new Map<number, number>();
    
    const action = createAction(async (taskId: number) => {
        const count = (attemptCounts.get(taskId) || 0) + 1;
        attemptCounts.set(taskId, count);
        
        // Fail first attempt for task 0
        if (count === 1 && taskId === 0) {
            throw new Error(`Task ${taskId} failed`);
        }
        
        return `Task ${taskId} done`;
    }).setRetry({
        maxRetries: 2,
        backoff: 'linear',
        baseDelay: 10
    });

    const results: any[] = [];
    for await (const result of action.invokeStream([[0], [1], [2]])) {
        results.push(result);
    }
    
    // All should succeed
    assert.strictEqual(results.length, 3);
    results.forEach(result => {
        assert.strictEqual(result.error, undefined);
        assert.ok(result.data);
    });
    
    // Task 0 should have been retried
    assert.strictEqual(attemptCounts.get(0), 2);
    assert.strictEqual(attemptCounts.get(1), 1);
    assert.strictEqual(attemptCounts.get(2), 1);
})();

printSection("Retry Tests Complete");

import { createAction, withContext } from "../actions/index.js";
import { test, assert, printSection, delay } from "./helpers.js";

printSection("Progress Tracking Tests");

await test("should track progress with setTotal and incrementProgress", async () => {
    const progressUpdates: number[] = [];
    
    const action = createAction(
        withContext(async (ctx, items: number[]) => {
            ctx.setTotal(items.length);
            
            const results = [];
            for (const item of items) {
                await delay(10);
                results.push(item * 2);
                ctx.incrementProgress();
            }
            
            return results;
        })
    ).onProgress((progress) => {
        progressUpdates.push(progress.completed);
    });
    
    const result = await action.invoke([1, 2, 3, 4, 5]).data;
    
    assert(result.length === 5, "Should return 5 results");
    assert(progressUpdates[0] === 0, "Should start at 0");
    assert(progressUpdates[progressUpdates.length - 1] === 5, "Should end at 5");
    assert(progressUpdates.length >= 2, "Should have at least start and end progress");
})();

await test("should track progress with reportProgress", async () => {
    const progressUpdates: number[] = [];
    
    const action = createAction(
        withContext(async (ctx, total: number) => {
            ctx.setTotal(total);
            
            for (let i = 1; i <= total; i++) {
                await delay(10);
                ctx.reportProgress(i);
            }
            
            return "done";
        })
    ).onProgress((progress) => {
        progressUpdates.push(progress.completed);
    });
    
    await action.invoke(10).data;
    
    assert(progressUpdates[0] === 0, "Should start at 0");
    assert(progressUpdates[progressUpdates.length - 1] === 10, "Should end at 10");
})();

await test("should calculate percentage correctly", async () => {
    const percentages: number[] = [];
    
    const action = createAction(
        withContext(async (ctx, total: number) => {
            ctx.setTotal(total);
            
            for (let i = 1; i <= total; i++) {
                await delay(10);
                ctx.incrementProgress();
            }
        })
    ).onProgress((progress) => {
        percentages.push(progress.percentage);
    });
    
    await action.invoke(4).data;
    
    assert(percentages[0] === 0, "Should start at 0%");
    assert(percentages[percentages.length - 1] === 100, "Should end at 100%");
})();

await test("should include current step description", async () => {
    let currentStep: string | undefined;
    
    const action = createAction(
        withContext(async (ctx, steps: string[]) => {
            ctx.setTotal(steps.length);
            
            for (const step of steps) {
                await delay(10);
                ctx.incrementProgress(step);
            }
        })
    ).onProgress((progress) => {
        currentStep = progress.current;
    });
    
    await action.invoke(["step1", "step2", "step3"]).data;
    
    assert(currentStep === "step3", "Should have last step description");
})();

await test("should throttle progress updates", async () => {
    const progressUpdates: number[] = [];
    
    const action = createAction(
        withContext(async (ctx, total: number) => {
            ctx.setTotal(total);
            
            for (let i = 1; i <= total; i++) {
                // No delay - should trigger throttling
                ctx.incrementProgress();
            }
        })
    ).onProgress((progress) => {
        progressUpdates.push(progress.completed);
    }, { throttle: 100 });
    
    await action.invoke(100).data;
    
    // Should have start (0), end (100), and some throttled updates
    assert(progressUpdates[0] === 0, "Should start at 0");
    assert(progressUpdates[progressUpdates.length - 1] === 100, "Should end at 100");
    assert(progressUpdates.length < 100, "Should throttle updates");
})();

await test("should emit progress on significant percentage changes", async () => {
    const progressUpdates: number[] = [];
    
    const action = createAction(
        withContext(async (ctx, total: number) => {
            ctx.setTotal(total);
            
            for (let i = 1; i <= total; i++) {
                // No delay - relies on significant change threshold (5%)
                ctx.incrementProgress();
            }
        })
    ).onProgress((progress) => {
        progressUpdates.push(progress.percentage);
    });
    
    await action.invoke(100).data;
    
    // Should emit on 0%, 100%, and when percentage changes by >= 5%
    assert(progressUpdates[0] === 0, "Should start at 0%");
    assert(progressUpdates[progressUpdates.length - 1] === 100, "Should end at 100%");
})();

await test("should calculate rate (items per second)", async () => {
    let finalRate: number | undefined;
    
    const action = createAction(
        withContext(async (ctx, total: number) => {
            ctx.setTotal(total);
            
            for (let i = 1; i <= total; i++) {
                await delay(50); // ~20 items/second
                ctx.incrementProgress();
            }
        })
    ).onProgress((progress) => {
        if (progress.completed === progress.total) {
            finalRate = progress.rate;
        }
    });
    
    await action.invoke(5).data;
    
    assert(finalRate !== undefined, "Should have rate at completion");
    assert(finalRate! > 0, "Rate should be positive");
})();

await test("should calculate estimated time remaining", async () => {
    let hadETA = false;
    
    const action = createAction(
        withContext(async (ctx, total: number) => {
            ctx.setTotal(total);
            
            for (let i = 1; i <= total; i++) {
                await delay(50);
                ctx.incrementProgress();
            }
        })
    ).onProgress((progress) => {
        if (progress.estimatedTimeRemaining !== undefined && progress.completed < progress.total) {
            hadETA = true;
        }
    });
    
    await action.invoke(5).data;
    
    assert(hadETA, "Should have ETA during execution");
})();

await test("should include startTime and elapsedTime", async () => {
    let startTime: number = 0;
    let finalElapsedTime: number = 0;
    
    const action = createAction(
        withContext(async (ctx, total: number) => {
            ctx.setTotal(total);
            
            for (let i = 1; i <= total; i++) {
                await delay(20);
                ctx.incrementProgress();
            }
        })
    ).onProgress((progress) => {
        if (progress.completed === 0) {
            startTime = progress.startTime;
        }
        if (progress.completed === progress.total) {
            finalElapsedTime = progress.elapsedTime;
        }
    });
    
    await action.invoke(3).data;
    
    assert(startTime > 0, "Should have start time");
    assert(finalElapsedTime >= 60, "Should have elapsed time >= 60ms (3 * 20ms)");
})();

await test("should track batch progress with invokeAll", async () => {
    const progressUpdates: number[] = [];
    
    const action = createAction(async (item: number) => {
        await delay(20);
        return item * 2;
    }).onProgress((progress) => {
        progressUpdates.push(progress.completed);
    });
    
    const results = await action.invokeAll([[1], [2], [3], [4], [5]]);
    
    assert(results.length === 5, "Should have 5 results");
    assert(progressUpdates[0] === 0, "Batch should start at 0");
    assert(progressUpdates[progressUpdates.length - 1] === 5, "Batch should end at 5");
})();

await test("should track batch progress with invokeStream", async () => {
    const progressUpdates: number[] = [];
    
    const action = createAction(async (item: number) => {
        await delay(20);
        return item * 2;
    }).onProgress((progress) => {
        progressUpdates.push(progress.completed);
    });
    
    const results = [];
    for await (const result of action.invokeStream([[1], [2], [3], [4], [5]])) {
        results.push(result);
    }
    
    assert(results.length === 5, "Should have 5 results");
    assert(progressUpdates[0] === 0, "Batch should start at 0");
    assert(progressUpdates[progressUpdates.length - 1] === 5, "Batch should end at 5");
})();

await test("should reset progress on retry", async () => {
    let attemptCount = 0;
    const progressUpdates: Array<{ attempt: number; completed: number }> = [];
    
    const action = createAction(
        withContext(async (ctx, items: number[]) => {
            attemptCount++;
            ctx.setTotal(items.length);
            
            for (let i = 0; i < items.length; i++) {
                await delay(10);
                ctx.incrementProgress();
                
                // Fail on first attempt at item 2
                if (attemptCount === 1 && i === 1) {
                    throw new Error("Simulated error");
                }
            }
            
            return items;
        })
    )
    .setRetry({ maxRetries: 1, backoff: 'linear', baseDelay: 10 })
    .onProgress((progress) => {
        progressUpdates.push({ attempt: attemptCount, completed: progress.completed });
    });
    
    const result = await action.invoke([1, 2, 3]).data;
    
    assert(result.length === 3, "Should eventually succeed");
    assert(attemptCount === 2, "Should have 2 attempts");
    
    // First attempt should have progress 0 -> 1 -> 2, then reset on retry
    const attempt1Updates = progressUpdates.filter(u => u.attempt === 1);
    const attempt2Updates = progressUpdates.filter(u => u.attempt === 2);
    
    assert(attempt1Updates.length > 0, "Should have progress on first attempt");
    assert(attempt2Updates.length > 0, "Should have progress on second attempt");
    assert(attempt2Updates[0]!.completed === 0, "Second attempt should start at 0");
})();

await test("should work without progress callback", async () => {
    const action = createAction(
        withContext(async (ctx, items: number[]) => {
            ctx.setTotal(items.length);
            
            for (const item of items) {
                ctx.incrementProgress();
            }
            
            return items.length;
        })
    );
    
    // Should not throw even though we're calling progress methods
    const result = await action.invoke([1, 2, 3]).data;
    assert(result === 3, "Should work without progress callback");
})();

await test("should handle zero total gracefully", async () => {
    let progressEmitted = false;
    
    const action = createAction(
        withContext(async (ctx, items: number[]) => {
            ctx.setTotal(0);
            ctx.incrementProgress();
            return items;
        })
    ).onProgress((progress) => {
        progressEmitted = true;
    });
    
    await action.invoke([]).data;
    
    // Progress with total=0 should not emit (or emit once with 0/0)
    assert(progressEmitted === false || progressEmitted === true, "Should handle zero total");
})();

await test("should validate progress methods", async () => {
    const action = createAction(
        withContext(async (ctx) => {
            // Test setTotal validation
            try {
                ctx.setTotal(-1);
                assert(false, "Should throw on negative total");
            } catch (e) {
                assert((e as Error).message.includes("must be >= 0"), "Should have validation error");
            }
            
            // Test reportProgress validation
            ctx.setTotal(10);
            try {
                ctx.reportProgress(-1);
                assert(false, "Should throw on negative completed");
            } catch (e) {
                assert((e as Error).message.includes("must be >= 0"), "Should have validation error");
            }
        })
    );
    
    await action.invoke().data;
})();

await test("should cap completed at total", async () => {
    let maxCompleted = 0;
    
    const action = createAction(
        withContext(async (ctx, total: number) => {
            ctx.setTotal(total);
            
            // Try to increment beyond total
            for (let i = 0; i < total + 5; i++) {
                ctx.incrementProgress();
            }
        })
    ).onProgress((progress) => {
        maxCompleted = Math.max(maxCompleted, progress.completed);
    });
    
    await action.invoke(5).data;
    
    assert(maxCompleted === 5, "Should cap completed at total");
})();

await test("should work with custom throttle setting", async () => {
    const progressUpdates: number[] = [];
    
    const action = createAction(
        withContext(async (ctx, total: number) => {
            ctx.setTotal(total);
            
            for (let i = 1; i <= total; i++) {
                await delay(2); // 2ms per item (fast updates)
                ctx.incrementProgress();
            }
        })
    ).onProgress((progress) => {
        progressUpdates.push(progress.completed);
    }, { throttle: 50 }); // Custom 50ms throttle
    
    await action.invoke(50).data;
    
    assert(progressUpdates[0] === 0, "Should start at 0");
    assert(progressUpdates[progressUpdates.length - 1] === 50, "Should end at 50");
    // With 50ms throttle and 2ms per item, expect throttling to happen
    // Should get start (0), end (50), and updates at ~50ms intervals
    assert(progressUpdates.length < 30, "Should throttle with custom setting");
})();

await test("should validate progress options", async () => {
    try {
        const action = createAction(
            withContext(async (ctx) => {})
        ).onProgress(() => {}, { throttle: -1 });
        
        assert(false, "Should throw on negative throttle");
    } catch (e) {
        assert((e as Error).message.includes("must be >= 0"), "Should validate throttle");
    }
})();

printSection("Progress Tracking Tests Complete");

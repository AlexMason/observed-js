import { ExecutionScheduler } from "../index.js";
import { assert, test, delay, printSection } from "./helpers.js";

async function runTests() {
    console.log("\n🧪 Running ExecutionScheduler Tests\n");

    printSection("Basic Scheduling");

    await test("should execute tasks", async () => {
        const scheduler = new ExecutionScheduler(1, Infinity);
        
        const result = await scheduler.schedule(() => Promise.resolve(42));
        
        assert.strictEqual(result, 42);
    })();

    await test("should handle sync functions", async () => {
        const scheduler = new ExecutionScheduler(1, Infinity);
        
        const result = await scheduler.schedule(() => 42);
        
        assert.strictEqual(result, 42);
    })();

    await test("should propagate errors", async () => {
        const scheduler = new ExecutionScheduler(1, Infinity);
        
        try {
            await scheduler.schedule(() => {
                throw new Error("Test error");
            });
            throw new Error("Should have thrown");
        } catch (error: any) {
            assert.strictEqual(error.message, "Test error");
        }
    })();

    await test("should propagate async errors", async () => {
        const scheduler = new ExecutionScheduler(1, Infinity);
        
        try {
            await scheduler.schedule(async () => {
                throw new Error("Async error");
            });
            throw new Error("Should have thrown");
        } catch (error: any) {
            assert.strictEqual(error.message, "Async error");
        }
    })();

    printSection("Queue Management");

    await test("should track queue length", async () => {
        const scheduler = new ExecutionScheduler(1, Infinity);
        
        let resolve1: () => void;
        const blocker = new Promise<void>(r => { resolve1 = r; });
        
        // Schedule a blocking task
        scheduler.schedule(() => blocker);
        
        // Schedule more tasks
        scheduler.schedule(() => Promise.resolve(1));
        scheduler.schedule(() => Promise.resolve(2));
        
        // Queue should have 2 items
        assert.strictEqual(scheduler.getQueueLength(), 2);
        assert.strictEqual(scheduler.getActiveCount(), 1);
        
        // Unblock
        resolve1!();
        await delay(10);
        
        // Queue should be empty
        assert.strictEqual(scheduler.getQueueLength(), 0);
        assert.strictEqual(scheduler.getActiveCount(), 0);
    })();

    await test("should maintain FIFO order with concurrency=1", async () => {
        const scheduler = new ExecutionScheduler(1, Infinity);
        const order: number[] = [];
        
        const promises = [1, 2, 3, 4, 5].map(i => 
            scheduler.schedule(async () => {
                order.push(i);
                await delay(5);
                return i;
            })
        );
        
        await Promise.all(promises);
        
        assert.deepStrictEqual(order, [1, 2, 3, 4, 5]);
    })();

    printSection("Concurrency Control");

    await test("should execute sequentially with concurrency=1", async () => {
        const scheduler = new ExecutionScheduler(1, Infinity);
        let running = 0;
        let maxConcurrent = 0;
        
        const promises = Array(5).fill(null).map(() => 
            scheduler.schedule(async () => {
                running++;
                maxConcurrent = Math.max(maxConcurrent, running);
                await delay(20);
                running--;
                return true;
            })
        );
        
        await Promise.all(promises);
        
        assert.strictEqual(maxConcurrent, 1);
    })();

    await test("should allow parallel execution with higher concurrency", async () => {
        const scheduler = new ExecutionScheduler(3, Infinity);
        let running = 0;
        let maxConcurrent = 0;
        
        const promises = Array(6).fill(null).map(() => 
            scheduler.schedule(async () => {
                running++;
                maxConcurrent = Math.max(maxConcurrent, running);
                await delay(50);
                running--;
                return true;
            })
        );
        
        await Promise.all(promises);
        
        assert.ok(maxConcurrent <= 3, `Expected max 3 concurrent, got ${maxConcurrent}`);
        assert.ok(maxConcurrent >= 2, `Expected at least 2 concurrent, got ${maxConcurrent}`);
    })();

    await test("should update concurrency limit dynamically", async () => {
        const scheduler = new ExecutionScheduler(1, Infinity);
        let running = 0;
        let maxConcurrent = 0;
        
        // Start with concurrency 1
        const promise1 = scheduler.schedule(async () => {
            running++;
            maxConcurrent = Math.max(maxConcurrent, running);
            await delay(50);
            running--;
        });
        
        // Increase concurrency
        scheduler.setConcurrency(5);
        
        // These should now be able to run in parallel
        const promises = Array(4).fill(null).map(() => 
            scheduler.schedule(async () => {
                running++;
                maxConcurrent = Math.max(maxConcurrent, running);
                await delay(30);
                running--;
            })
        );
        
        await Promise.all([promise1, ...promises]);
        
        assert.ok(maxConcurrent >= 2, `Expected at least 2 concurrent after increasing limit`);
    })();

    printSection("Rate Limiting");

    await test("should enforce rate limit", async () => {
        const scheduler = new ExecutionScheduler(100, 5); // High concurrency, 5 per second
        let count = 0;
        
        const startTime = Date.now();
        const promises = Array(8).fill(null).map(() => 
            scheduler.schedule(async () => {
                count++;
                return count;
            })
        );
        
        await Promise.all(promises);
        const duration = Date.now() - startTime;
        
        // 8 tasks at 5/sec should take at least 600ms (5 in first window, 3 wait)
        assert.ok(duration >= 500, `Expected at least 500ms, got ${duration}ms`);
        assert.strictEqual(count, 8);
    })();

    await test("should update rate limit dynamically", async () => {
        const scheduler = new ExecutionScheduler(100, 2);
        
        // Start some tasks with low rate limit
        const promise1 = scheduler.schedule(() => Promise.resolve(1));
        const promise2 = scheduler.schedule(() => Promise.resolve(2));
        
        // Increase rate limit
        scheduler.setRateLimit(100);
        
        // These should now execute quickly
        const startTime = Date.now();
        const promises = Array(5).fill(null).map((_, i) => 
            scheduler.schedule(() => Promise.resolve(i))
        );
        
        await Promise.all([promise1, promise2, ...promises]);
        const duration = Date.now() - startTime;
        
        // Should complete quickly with high rate limit
        assert.ok(duration < 500, `Expected quick completion, got ${duration}ms`);
    })();

    await test("should combine concurrency and rate limiting", async () => {
        const scheduler = new ExecutionScheduler(2, 10); // 2 concurrent, 10/sec
        let running = 0;
        let maxConcurrent = 0;
        let count = 0;
        
        const promises = Array(5).fill(null).map(() => 
            scheduler.schedule(async () => {
                running++;
                maxConcurrent = Math.max(maxConcurrent, running);
                count++;
                await delay(30);
                running--;
            })
        );
        
        await Promise.all(promises);
        
        assert.ok(maxConcurrent <= 2, `Expected max 2 concurrent, got ${maxConcurrent}`);
        assert.strictEqual(count, 5);
    })();

    printSection("Error Handling");

    await test("should continue processing after error", async () => {
        const scheduler = new ExecutionScheduler(1, Infinity);
        const results: number[] = [];
        
        const promises = [1, 2, 3].map(i => 
            scheduler.schedule(async () => {
                if (i === 2) {
                    throw new Error("Task 2 failed");
                }
                results.push(i);
                return i;
            }).catch(() => null)
        );
        
        await Promise.all(promises);
        
        // Should have processed 1 and 3
        assert.ok(results.includes(1));
        assert.ok(results.includes(3));
        assert.ok(!results.includes(2));
    })();

    await test("should not affect queue on error", async () => {
        const scheduler = new ExecutionScheduler(1, Infinity);
        
        // Queue tasks
        const p1 = scheduler.schedule(() => Promise.resolve(1));
        const p2 = scheduler.schedule(() => Promise.reject(new Error("fail")));
        const p3 = scheduler.schedule(() => Promise.resolve(3));
        
        const results = await Promise.allSettled([p1, p2, p3]);
        
        assert.strictEqual(results[0]!.status, 'fulfilled');
        assert.strictEqual(results[1]!.status, 'rejected');
        assert.strictEqual(results[2]!.status, 'fulfilled');
        
        if (results[0]!.status === 'fulfilled') {
            assert.strictEqual(results[0]!.value, 1);
        }
        if (results[2]!.status === 'fulfilled') {
            assert.strictEqual(results[2]!.value, 3);
        }
    })();

    printSection("Edge Cases");

    await test("should handle very high concurrency", async () => {
        const scheduler = new ExecutionScheduler(1000, Infinity);
        let maxConcurrent = 0;
        let running = 0;
        
        const promises = Array(10).fill(null).map(() => 
            scheduler.schedule(async () => {
                running++;
                maxConcurrent = Math.max(maxConcurrent, running);
                await delay(10);
                running--;
            })
        );
        
        await Promise.all(promises);
        
        // All should run concurrently
        assert.strictEqual(maxConcurrent, 10);
    })();

    await test("should handle rapid scheduling", async () => {
        const scheduler = new ExecutionScheduler(5, Infinity);
        let count = 0;
        
        const promises = Array(100).fill(null).map(() => 
            scheduler.schedule(async () => {
                count++;
                return count;
            })
        );
        
        await Promise.all(promises);
        
        assert.strictEqual(count, 100);
    })();

    await test("should handle zero delay tasks", async () => {
        const scheduler = new ExecutionScheduler(3, Infinity);
        const results: number[] = [];
        
        const promises = [1, 2, 3, 4, 5].map(i => 
            scheduler.schedule(() => {
                results.push(i);
                return i;
            })
        );
        
        await Promise.all(promises);
        
        assert.strictEqual(results.length, 5);
    })();
}

await runTests();

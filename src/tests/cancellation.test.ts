import assert from 'node:assert';
import { test, delay, printSection } from './helpers.js';
import { createAction, withContext, withAbortSignal, CancellationError } from '../index.js';

printSection('Cancellation Tests');

// Test: Cancel queued task
await test('should cancel queued task', async () => {
    let executionCount = 0;
    
    const action = createAction(async (n: number) => {
        executionCount++;
        await delay(50);
        return n * 2;
    }).setConcurrency(1);
    
    // Start three tasks - first will run, others will be queued
    const inv1 = action.invoke(1);
    const inv2 = action.invoke(2);
    const inv3 = action.invoke(3);
    
    // Cancel the second task while it's queued
    inv2.cancel('Testing cancellation');
    
    // Wait for results
    const result1 = await inv1.data;
    assert.strictEqual(result1, 2, 'First task should complete');
    
    try {
        await inv2.data;
        assert.fail('Second task should have been cancelled');
    } catch (error) {
        assert.ok(error instanceof CancellationError, 'Should throw CancellationError');
        assert.strictEqual((error as CancellationError).reason, 'Testing cancellation');
        assert.strictEqual((error as CancellationError).state, 'queued');
    }
    
    const result3 = await inv3.data;
    assert.strictEqual(result3, 6, 'Third task should complete');
    
    assert.strictEqual(executionCount, 2, 'Should only execute 2 tasks');
    assert.strictEqual(inv2.cancelled, true, 'inv2 should be marked as cancelled');
    assert.strictEqual(inv2.cancelReason, 'Testing cancellation');
})();

// Test: Cancel running task with AbortSignal
await test('should cancel running task with AbortSignal', async () => {
    let signalRef: AbortSignal | null = null;
    
    const action = createAction(
        withAbortSignal(async (signal, duration: number) => {
            signalRef = signal;
            const startTime = Date.now();
            
            // Check signal in a loop
            while (Date.now() - startTime < duration) {
                if (signal.aborted) {
                    throw new CancellationError('Aborted by signal', 'running');
                }
                await delay(10);
            }
            
            return 'completed';
        })
    );
    
    const invocation = action.invoke(200);
    
    // Wait for handler to start
    await delay(50);
    
    // Cancel the running task
    invocation.cancel('User cancelled');
    
    try {
        await invocation.data;
        assert.fail('Task should have been cancelled');
    } catch (error) {
        assert.ok(error instanceof CancellationError, 'Should throw CancellationError');
        // The signal should be aborted after cancel is called
        assert.strictEqual(signalRef?.aborted, true, 'Signal should be aborted');
    }
})();

// Test: Cancel during retry delay
await test('should cancel during retry delay', async () => {
    let attemptCount = 0;
    
    const action = createAction(async () => {
        attemptCount++;
        throw new Error('Always fails');
    }).setRetry({
        maxRetries: 3,
        baseDelay: 1000,
        backoff: 'linear'
    });
    
    const invocation = action.invoke();
    
    // Wait for first attempt to fail
    await delay(50);
    
    // Cancel during retry delay
    invocation.cancel('Cancelled during retry');
    
    try {
        await invocation.data;
        assert.fail('Should have been cancelled');
    } catch (error) {
        assert.ok(error instanceof CancellationError);
        assert.strictEqual((error as CancellationError).state, 'retry-delay');
        assert.strictEqual(attemptCount, 1, 'Should only have attempted once');
    }
})();

// Test: Cancel already completed task (no-op)
await test('should no-op when cancelling completed task', async () => {
    const action = createAction(async (n: number) => n * 2);
    
    const invocation = action.invoke(5);
    const result = await invocation.data;
    
    assert.strictEqual(result, 10);
    assert.strictEqual(invocation.cancelled, false);
    
    // Cancel after completion - should be no-op
    invocation.cancel('Too late');
    
    assert.strictEqual(invocation.cancelled, false, 'Should not mark as cancelled after completion');
})();

// Test: Cancel already cancelled task (idempotent)
await test('should be idempotent when cancelling twice', async () => {
    const action = createAction(async () => {
        await delay(100);
        return 'done';
    }).setConcurrency(1);
    
    const inv1 = action.invoke(1); // Block the queue
    const invocation = action.invoke(2); // Will be queued
    
    invocation.cancel('First cancel');
    invocation.cancel('Second cancel');
    
    assert.strictEqual(invocation.cancelReason, 'First cancel', 'First reason should be kept');
    
    try {
        await invocation.data;
        assert.fail('Should have been cancelled');
    } catch (error) {
        assert.ok(error instanceof CancellationError);
        assert.strictEqual((error as CancellationError).reason, 'First cancel');
    }
    
    // Cleanup: wait for first task to complete
    await inv1.data;
})();

// Test: action.cancelAll()
await test('should cancel all invocations via action.cancelAll()', async () => {
    const action = createAction(async (n: number) => {
        await delay(100);
        return n * 2;
    }).setConcurrency(2);
    
    const inv1 = action.invoke(1);
    const inv2 = action.invoke(2);
    const inv3 = action.invoke(3);
    
    await delay(20);
    
    const cancelledCount = action.cancelAll('Cancelling all');
    
    assert.ok(cancelledCount >= 1, 'Should cancel at least one task');
    
    // Collect results
    const results = await Promise.allSettled([inv1.data, inv2.data, inv3.data]);
    
    const cancelledResults = results.filter(r => 
        r.status === 'rejected' && r.reason instanceof CancellationError
    );
    
    assert.ok(cancelledResults.length >= 1, 'At least one should be cancelled');
})();

// Test: action.cancelAll() with predicate
await test('should cancel with predicate filter', async () => {
    const action = createAction(async (n: number) => {
        await delay(100);
        return n * 2;
    }).setConcurrency(1);
    
    // Start multiple tasks
    const inv1 = action.invoke(1);
    const inv2 = action.invoke(2);
    const inv3 = action.invoke(3);
    
    await delay(20);
    
    // Cancel only inv3 using predicate
    const cancelledCount = action.cancelAll((inv) => inv.actionId === inv3.actionId);
    
    assert.strictEqual(cancelledCount, 1, 'Should cancel exactly one task');
    
    try {
        await inv3.data;
        assert.fail('inv3 should be cancelled');
    } catch (error) {
        assert.ok(error instanceof CancellationError);
    }
    
    // Cleanup: wait for remaining tasks and handle cancellation errors
    await Promise.allSettled([inv1.data, inv2.data]);
})();

// Test: action.clearQueue()
await test('should clear queue but not running tasks', async () => {
    let runningCount = 0;
    
    const action = createAction(async (n: number) => {
        runningCount++;
        await delay(100);
        return n * 2;
    }).setConcurrency(1);
    
    const inv1 = action.invoke(1); // Will run
    const inv2 = action.invoke(2); // Queued
    const inv3 = action.invoke(3); // Queued
    
    await delay(20);
    
    const clearedCount = action.clearQueue('Clearing queue');
    
    assert.ok(clearedCount >= 1, 'Should clear at least one queued task');
    
    // First should complete
    const result1 = await inv1.data;
    assert.strictEqual(result1, 2);
    
    // Queued tasks should be cancelled
    const results = await Promise.allSettled([inv2.data, inv3.data]);
    const cancelledCount = results.filter(r => 
        r.status === 'rejected' && r.reason instanceof CancellationError
    ).length;
    
    assert.ok(cancelledCount >= 1, 'Queued tasks should be cancelled');
})();

// Test: Cancellation with context attachments
await test('should preserve attachments in cancellation event', async () => {
    let capturedEvent: any = null;
    
    const action = createAction(
        withContext(async (ctx, n: number) => {
            ctx.attach('inputValue', n);
            ctx.attach('processing', true);
            await delay(100);
            return n * 2;
        })
    )
    .setConcurrency(1)
    .onEvent((event) => {
        if (event.cancelled) {
            capturedEvent = event;
        }
    });
    
    const inv1 = action.invoke(1); // Block the queue
    const inv2 = action.invoke(2);
    
    await delay(20);
    inv2.cancel('Test cancellation');
    
    // Wait for event to be processed
    await inv2.eventLogged;
    
    assert.ok(capturedEvent, 'Should have captured cancellation event');
    assert.strictEqual(capturedEvent.cancelled, true);
    assert.strictEqual(capturedEvent.cancelReason, 'Test cancellation');
    assert.strictEqual(capturedEvent.cancelledAt, 'queued');
    
    // Cleanup: wait for first task to complete
    await inv1.data;
})();

// Test: Cancellation priority over timeout
await test('cancellation should take priority over timeout', async () => {
    const action = createAction(async () => {
        await delay(500);
        return 'done';
    }).setTimeout(1000);
    
    const invocation = action.invoke();
    
    await delay(50);
    invocation.cancel('Manual cancel');
    
    try {
        await invocation.data;
        assert.fail('Should have been cancelled');
    } catch (error) {
        assert.ok(error instanceof CancellationError, 'Should throw CancellationError, not TimeoutError');
    }
})();

// Test: scheduler.shutdown() graceful
await test('should gracefully shutdown scheduler', async () => {
    const action = createAction(async (n: number) => {
        await delay(50);
        return n * 2;
    }).setConcurrency(2);
    
    const inv1 = action.invoke(1);
    const inv2 = action.invoke(2);
    const inv3 = action.invoke(3); // Will be queued
    const inv4 = action.invoke(4); // Will be queued
    
    await delay(20);
    
    // Graceful shutdown - should wait for running, cancel queued
    const shutdownPromise = action['scheduler'].shutdown({ mode: 'graceful', timeout: 1000 });
    
    // Running tasks should complete
    const result1 = await inv1.data;
    const result2 = await inv2.data;
    assert.strictEqual(result1, 2);
    assert.strictEqual(result2, 4);
    
    await shutdownPromise;
    
    // Cleanup: await queued tasks (they should be cancelled)
    await Promise.allSettled([inv3.data, inv4.data]);
})();

// Test: scheduler.shutdown() immediate
await test('should immediately shutdown scheduler', async () => {
    const action = createAction(async (n: number) => {
        await delay(100);
        return n * 2;
    }).setConcurrency(2);
    
    const inv1 = action.invoke(1);
    const inv2 = action.invoke(2);
    const inv3 = action.invoke(3);
    const inv4 = action.invoke(4);
    
    await delay(20);
    
    // Immediate shutdown - cancel everything
    await action['scheduler'].shutdown({ mode: 'immediate' });
    
    // All queued/running should be cancelled
    const results = await Promise.allSettled([inv1.data, inv2.data, inv3.data, inv4.data]);
    
    const cancelledCount = results.filter(r => 
        r.status === 'rejected' && r.reason instanceof CancellationError
    ).length;
    
    assert.ok(cancelledCount >= 1, 'Should cancel queued tasks');
})();

// Test: scheduler.drain()
await test('should drain scheduler queue', async () => {
    const action = createAction(async (n: number) => {
        await delay(50);
        return n * 2;
    }).setConcurrency(1);
    
    const inv1 = action.invoke(1); // Will run
    const inv2 = action.invoke(2); // Queued
    const inv3 = action.invoke(3); // Queued
    
    await delay(20);
    
    // Drain - cancel queued, wait for running
    await action['scheduler'].drain();
    
    // First task should complete
    const result1 = await inv1.data;
    assert.strictEqual(result1, 2);
    
    // Cleanup: await queued tasks (they should be cancelled by drain)
    await Promise.allSettled([inv2.data, inv3.data]);
})();

// Test: Batch operations cancellation via clearQueue
await test('should handle cancellation in batch operations', async () => {
    const action = createAction(async (n: number) => {
        await delay(100);  // Longer delay to ensure tasks are queued
        return n * 2;
    }).setConcurrency(1);  // Process one at a time to have more in queue
    
    // invokeAll expects an array of argument-tuples
    const batchPromise = action.invokeAll([[1], [2], [3], [4]]);

    // Wait until the first task is actually running before clearing the queue.
    // (The scheduler may start work on a microtask, so fixed delays can be flaky.)
    const scheduler = action['scheduler'];
    const startWaitUntil = Date.now();
    while (scheduler.runningCount === 0 && Date.now() - startWaitUntil < 500) {
        await delay(5);
    }
    
    // Clear the queue (cancel queued tasks, not running ones)
    const clearedCount = action.clearQueue('Batch cancelled');
    
    const results = await batchPromise;
    
    // First task should complete, others should be cancelled
    const successCount = results.filter(r => r.error === undefined).length;
    const cancelledCount = results.filter(r => 
        r.error instanceof CancellationError
    ).length;
    
    assert.ok(successCount >= 1, 'At least first should succeed');
    assert.ok(cancelledCount >= 1, 'Some should be cancelled');
    assert.strictEqual(results.length, 4, 'Should have all 4 results');
})();

// Test: Cancellation with retry - stops retry sequence
await test('should stop retry sequence on cancellation', async () => {
    let attemptCount = 0;
    let eventCount = 0;
    
    const action = createAction(async () => {
        attemptCount++;
        await delay(50);
        throw new Error('Always fails');
    })
    .setRetry({
        maxRetries: 5,
        baseDelay: 100,
        backoff: 'linear'
    })
    .onEvent(() => {
        eventCount++;
    });
    
    const invocation = action.invoke();
    
    // Wait for first attempt
    await delay(80);
    
    // Cancel during retry delay
    invocation.cancel('Stop retrying');
    
    try {
        await invocation.data;
        assert.fail('Should have been cancelled');
    } catch (error) {
        assert.ok(error instanceof CancellationError);
    }
    
    // Should only have attempted once (no retries after cancellation)
    assert.strictEqual(attemptCount, 1, 'Should not retry after cancellation');
})();

// Test: Cancellation state tracking
await test('should track cancellation state correctly', async () => {
    const action = createAction(async (n: number) => {
        await delay(100);
        return n;
    }).setConcurrency(1);
    
    const inv1 = action.invoke(1); // Block
    const inv2 = action.invoke(2);
    
    assert.strictEqual(inv2.cancelled, false, 'Should not be cancelled initially');
    assert.strictEqual(inv2.cancelReason, undefined);
    
    inv2.cancel('Testing state');
    
    assert.strictEqual(inv2.cancelled, true, 'Should be cancelled after cancel()');
    assert.strictEqual(inv2.cancelReason, 'Testing state');
    
    // Wait for first task to complete to avoid dangling promises
    await inv1.data;
    // Second task is already cancelled, just catch its rejection
    await inv2.data.catch(() => {});
})();

// Test: Scheduler counts
await test('should track queued and running counts', async () => {
    const action = createAction(async (n: number) => {
        await delay(50);  // Use shorter delay
        return n;
    }).setConcurrency(2);
    
    const scheduler = action['scheduler'];
    
    assert.strictEqual(scheduler.queuedCount, 0);
    assert.strictEqual(scheduler.runningCount, 0);
    
    const inv1 = action.invoke(1);
    const inv2 = action.invoke(2);
    const inv3 = action.invoke(3);
    const inv4 = action.invoke(4);
    
    await delay(20);
    
    // Should have some running and some queued
    const totalTasks = scheduler.queuedCount + scheduler.runningCount;
    assert.ok(totalTasks >= 2, 'Should have tasks in queue or running');
    
    // Wait for all tasks to complete to avoid dangling promises
    await Promise.all([inv1.data, inv2.data, inv3.data, inv4.data]);
})();

// Allow any final microtasks/promises to settle before exiting
await delay(100);

console.log('\nCancellation tests finished.');

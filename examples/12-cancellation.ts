/**
 * Cancellation Examples
 * 
 * Demonstrates how to cancel tasks manually, including:
 * - Individual invocation cancellation
 * - Cancelling queued vs running tasks
 * - Cancelling with AbortSignal support
 * - Cancelling during retry sequences
 * - Action-level cancelAll
 * - Graceful shutdown
 */

import { createAction, withAbortSignal, CancellationError } from '../index.js';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

console.log('🔴 Cancellation Examples\n');

// Example 1: Basic Invocation Cancellation
console.log('1️⃣  Basic Invocation Cancellation');
console.log('─────────────────────────────────\n');

const searchAction = createAction(async (query: string) => {
    console.log(`   🔍 Searching for: ${query}`);
    await delay(1000);
    return `Results for: ${query}`;
});

const searchInvocation = searchAction.invoke('javascript frameworks');

// Simulate user cancelling the search
setTimeout(() => {
    console.log('   ❌ User cancelled the search');
    searchInvocation.cancel('User cancelled');
}, 300);

try {
    const results = await searchInvocation.data;
    console.log(`   ✅ ${results}`);
} catch (error) {
    if (error instanceof CancellationError) {
        console.log(`   🚫 Search cancelled: ${error.reason}`);
        console.log(`   📊 Cancelled while: ${error.state}\n`);
    }
}

// Example 2: Cancel Queued Task
console.log('2️⃣  Cancel Queued Task');
console.log('─────────────────────\n');

const processAction = createAction(async (taskId: number) => {
    console.log(`   ⚙️  Processing task ${taskId}`);
    await delay(500);
    return `Task ${taskId} completed`;
}).setConcurrency(1);

// Start multiple tasks - only first will run immediately
const task1 = processAction.invoke(1);
const task2 = processAction.invoke(2);
const task3 = processAction.invoke(3);

// Cancel task 2 while it's queued
await delay(100);
console.log('   ❌ Cancelling task 2 (queued)');
task2.cancel('Not needed anymore');

// Wait for results
const results = await Promise.allSettled([task1.data, task2.data, task3.data]);

results.forEach((result, idx) => {
    if (result.status === 'fulfilled') {
        console.log(`   ✅ Task ${idx + 1}: ${result.value}`);
    } else if (result.reason instanceof CancellationError) {
        console.log(`   🚫 Task ${idx + 1}: Cancelled (${result.reason.reason})`);
    }
});

console.log();

// Example 3: Cooperative Cancellation with AbortSignal
console.log('3️⃣  Cooperative Cancellation with AbortSignal');
console.log('──────────────────────────────────────────\n');

const downloadAction = createAction(
    withAbortSignal(async (signal, url: string) => {
        console.log(`   📥 Downloading: ${url}`);
        
        // Simulate download in chunks
        for (let i = 0; i < 10; i++) {
            // Check if cancelled
            if (signal.aborted) {
                console.log('   🛑 Download aborted via signal');
                throw new CancellationError('Download cancelled', 'running');
            }
            
            console.log(`   📦 Chunk ${i + 1}/10 downloaded`);
            await delay(200);
        }
        
        return 'Download complete';
    })
);

const download = downloadAction.invoke('https://example.com/large-file.zip');

// Cancel after downloading 3 chunks
setTimeout(() => {
    console.log('   ❌ User cancelled download\n');
    download.cancel('User cancelled');
}, 700);

try {
    await download.data;
} catch (error) {
    if (error instanceof CancellationError) {
        console.log(`   🚫 ${error.message}\n`);
    }
}

// Example 4: Cancel During Retry
console.log('4️⃣  Cancel During Retry');
console.log('────────────────────\n');

let attemptCount = 0;

const unreliableAction = createAction(async () => {
    attemptCount++;
    console.log(`   🔄 Attempt ${attemptCount}`);
    await delay(100);
    throw new Error('Service unavailable');
})
.setRetry({
    maxRetries: 5,
    baseDelay: 1000,
    backoff: 'linear'
})
.onEvent((event) => {
    if (event.cancelled) {
        console.log(`   🚫 Cancelled after ${event.retryAttempt! + 1} attempts`);
    }
});

const retryInvocation = unreliableAction.invoke();

// Cancel during retry delay
setTimeout(() => {
    console.log('   ❌ Cancelling retry sequence\n');
    retryInvocation.cancel('Service is down, stop retrying');
}, 500);

try {
    await retryInvocation.data;
} catch (error) {
    if (error instanceof CancellationError) {
        console.log(`   🚫 ${error.message}`);
        console.log(`   📊 State: ${error.state}\n`);
    }
}

// Example 5: Cancel All Invocations
console.log('5️⃣  Cancel All Invocations');
console.log('─────────────────────────\n');

const batchAction = createAction(async (jobId: number) => {
    console.log(`   🔨 Processing job ${jobId}`);
    await delay(800);
    return `Job ${jobId} done`;
}).setConcurrency(2);

// Start multiple jobs
console.log('   📋 Starting 6 jobs...');
const jobs = [1, 2, 3, 4, 5, 6].map(id => batchAction.invoke(id));

// After a moment, cancel all remaining jobs
await delay(500);
console.log('   ❌ Cancelling all remaining jobs\n');
const cancelledCount = batchAction.cancelAll('System shutdown');
console.log(`   🚫 Cancelled ${cancelledCount} jobs\n`);

// Check results
const jobResults = await Promise.allSettled(jobs.map(j => j.data));
const completed = jobResults.filter(r => r.status === 'fulfilled').length;
const cancelled = jobResults.filter(
    r => r.status === 'rejected' && r.reason instanceof CancellationError
).length;

console.log(`   ✅ Completed: ${completed}`);
console.log(`   🚫 Cancelled: ${cancelled}\n`);

// Example 6: Cancel with Predicate
console.log('6️⃣  Cancel with Predicate (Low Priority)');
console.log('────────────────────────────────────────\n');

// Simulate a system under load - cancel low priority tasks
const taskAction = createAction(async (priority: 'high' | 'low', taskName: string) => {
    console.log(`   ⚙️  [${priority.toUpperCase()}] ${taskName}`);
    await delay(500);
    return `${taskName} completed`;
}).setConcurrency(2);

// Mix of high and low priority tasks
const t1 = taskAction.invoke('high', 'Critical Update');
const t2 = taskAction.invoke('low', 'Cache Cleanup');
const t3 = taskAction.invoke('high', 'Database Backup');
const t4 = taskAction.invoke('low', 'Log Rotation');
const t5 = taskAction.invoke('low', 'Analytics Sync');

// Track tasks for filtering
const taskMap = new Map([
    [t1.actionId, { priority: 'high', invocation: t1 }],
    [t2.actionId, { priority: 'low', invocation: t2 }],
    [t3.actionId, { priority: 'high', invocation: t3 }],
    [t4.actionId, { priority: 'low', invocation: t4 }],
    [t5.actionId, { priority: 'low', invocation: t5 }],
]);

await delay(200);

// Cancel all low priority tasks
console.log('   ⚠️  System under load - cancelling low priority tasks\n');
const lowPriorityCancelled = taskAction.cancelAll((inv) => {
    const task = taskMap.get(inv.actionId);
    return task?.priority === 'low' || false;
});

console.log(`   🚫 Cancelled ${lowPriorityCancelled} low priority tasks\n`);

// Wait for all to finish
await Promise.allSettled([t1.data, t2.data, t3.data, t4.data, t5.data]);

console.log();

// Example 7: Graceful Shutdown
console.log('7️⃣  Graceful Shutdown');
console.log('──────────────────\n');

const serverAction = createAction(async (requestId: number) => {
    console.log(`   📨 Handling request ${requestId}`);
    await delay(600);
    return `Response ${requestId}`;
}).setConcurrency(3);

// Simulate incoming requests
console.log('   🌐 Server receiving requests...');
serverAction.invoke(1);
serverAction.invoke(2);
serverAction.invoke(3);
serverAction.invoke(4);
serverAction.invoke(5);

await delay(300);

// Initiate graceful shutdown
console.log('   🛑 SIGTERM received - starting graceful shutdown\n');
console.log('   ⏳ Waiting for running requests to complete...');
console.log('   ❌ Cancelling queued requests...\n');

await serverAction['scheduler'].shutdown({
    mode: 'graceful',
    timeout: 2000
});

console.log('   ✅ Graceful shutdown complete\n');

// Example 8: Immediate Shutdown
console.log('8️⃣  Immediate Shutdown');
console.log('────────────────────\n');

const emergencyAction = createAction(async (id: number) => {
    console.log(`   🔧 Processing ${id}`);
    await delay(1000);
    return `Result ${id}`;
}).setConcurrency(2);

console.log('   ⚙️  Starting processes...');
emergencyAction.invoke(1);
emergencyAction.invoke(2);
emergencyAction.invoke(3);

await delay(200);

console.log('   🚨 EMERGENCY SHUTDOWN INITIATED\n');

await emergencyAction['scheduler'].shutdown({
    mode: 'immediate'
});

console.log('   ✅ Immediate shutdown complete\n');

// Example 9: Clear Queue Only
console.log('9️⃣  Clear Queue (Keep Running)');
console.log('────────────────────────────\n');

const cleanupAction = createAction(async (item: number) => {
    console.log(`   🧹 Cleaning ${item}`);
    await delay(500);
    return `Cleaned ${item}`;
}).setConcurrency(1);

console.log('   📋 Queuing cleanup tasks...');
const c1 = cleanupAction.invoke(1); // Will run
const c2 = cleanupAction.invoke(2); // Queued
const c3 = cleanupAction.invoke(3); // Queued
const c4 = cleanupAction.invoke(4); // Queued

await delay(100);

console.log('   ❌ Clearing queue (keeping current task)\n');
const cleared = cleanupAction.clearQueue('Queue cleared');
console.log(`   🚫 Cleared ${cleared} queued tasks\n`);

// First task should complete
try {
    const result1 = await c1.data;
    console.log(`   ✅ ${result1}`);
} catch (e) {
    console.log(`   ❌ Task 1 failed: ${e}`);
}

// Check others are cancelled
const otherResults = await Promise.allSettled([c2.data, c3.data, c4.data]);
const otherCancelled = otherResults.filter(
    r => r.status === 'rejected' && r.reason instanceof CancellationError
).length;

console.log(`   🚫 ${otherCancelled} tasks were cancelled from queue\n`);

// Example 10: Cancellation State Tracking
console.log('🔟 Cancellation State Tracking');
console.log('───────────────────────────────\n');

const monitoredAction = createAction(async (id: number) => {
    await delay(1000);
    return `Result ${id}`;
})
.setConcurrency(1)
.onEvent((event) => {
    if (event.cancelled) {
        console.log(`   📊 Event logged:`);
        console.log(`      - Action ID: ${event.actionId}`);
        console.log(`      - Cancelled: ${event.cancelled}`);
        console.log(`      - Reason: ${event.cancelReason}`);
        console.log(`      - State when cancelled: ${event.cancelledAt}`);
        console.log(`      - Duration: ${event.duration}ms\n`);
    }
});

monitoredAction.invoke(1); // Block queue
const mon2 = monitoredAction.invoke(2);

console.log(`   📌 Initial state:`);
console.log(`      - Cancelled: ${mon2.cancelled}`);
console.log(`      - Reason: ${mon2.cancelReason}\n`);

await delay(100);

console.log('   ❌ Cancelling task...\n');
mon2.cancel('State tracking demo');

console.log(`   📌 After cancel():`);
console.log(`      - Cancelled: ${mon2.cancelled}`);
console.log(`      - Reason: ${mon2.cancelReason}\n`);

await mon2.eventLogged;

console.log('✅ All cancellation examples completed!\n');

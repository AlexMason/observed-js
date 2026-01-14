/**
 * Batch Invocation
 * 
 * This example demonstrates two styles of batch invocation:
 * - invokeAll(): Promise.all style, returns results in order
 * - invokeStream(): AsyncGenerator, yields results as they complete
 */

import { createAction } from "../src/index.js";

console.log("=== Batch Invocation ===\n");

// Example 1: invokeAll for ordered results
console.log("Example 1: invokeAll() - Promise.all style");
const fetchUser = createAction(async (userId: string) => {
    // Simulate variable latency
    const delay = Math.random() * 100;
    await new Promise(resolve => setTimeout(resolve, delay));
    return {
        userId,
        name: `User ${userId}`,
        delay: Math.round(delay)
    };
}).setConcurrency(3);

const userIds = ["user1", "user2", "user3", "user4", "user5"];
const results = await fetchUser.invokeAll(userIds.map(id => [id]));

console.log("  Results (in input order):");
results.forEach((result, index) => {
    if (result.data) {
        console.log(`    [${index}] ${result.data.userId} - ${result.data.delay}ms`);
    }
});

// Example 2: invokeStream for results as they complete
console.log("\nExample 2: invokeStream() - Process as completed");
const processJob = createAction(async (jobId: number) => {
    // Jobs have variable processing time
    const delay = (jobId % 3 + 1) * 50; // 50ms, 100ms, or 150ms
    await new Promise(resolve => setTimeout(resolve, delay));
    return {
        jobId,
        processingTime: delay,
        result: `Job ${jobId} complete`
    };
}).setConcurrency(3);

const jobIds = [1, 2, 3, 4, 5, 6];
console.log("  Processing jobs (order of completion):");

for await (const result of processJob.invokeStream(jobIds.map(id => [id]))) {
    if (result.data) {
        console.log(`    Job ${result.data.jobId} done (${result.data.processingTime}ms) [input index: ${result.index}]`);
    }
}

// Example 3: Handling partial failures with invokeAll
console.log("\nExample 3: Handling failures in batch");
let callCount = 0;
const flakeyTask = createAction(async (taskId: number) => {
    callCount++;
    if (taskId === 2) {
        throw new Error(`Task ${taskId} failed`);
    }
    return `Task ${taskId} success`;
});

const taskResults = await flakeyTask.invokeAll([[1], [2], [3], [4]]);

console.log("  Batch results:");
taskResults.forEach((result, index) => {
    if (result.data) {
        console.log(`    [${index}] ✓ ${result.data}`);
    } else if (result.error) {
        console.log(`    [${index}] ✗ Error: ${result.error.message}`);
    }
});

// Example 4: invokeStream with error handling
console.log("\nExample 4: Stream with mixed success/failure");
const riskyJob = createAction(async (jobId: number) => {
    await new Promise(resolve => setTimeout(resolve, 30));
    if (jobId % 3 === 0) {
        throw new Error(`Job ${jobId} failed validation`);
    }
    return `Job ${jobId} completed`;
});

console.log("  Streaming results:");
for await (const result of riskyJob.invokeStream([[1], [2], [3], [4], [5], [6]])) {
    if (result.data) {
        console.log(`    ✓ ${result.data}`);
    } else if (result.error) {
        console.log(`    ✗ ${result.error.message}`);
    }
}

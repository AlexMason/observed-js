/**
 * Concurrency Control
 * 
 * This example demonstrates how to limit parallel execution of actions.
 * By default, actions execute sequentially (concurrency = 1).
 */

import { createAction } from "../src/index.js";

console.log("=== Concurrency Control ===\n");

// Example 1: Sequential execution (default)
console.log("Example 1: Sequential (concurrency = 1)");
let counter1 = 0;
const sequentialTask = createAction(async (taskId: number) => {
    counter1++;
    console.log(`  Task ${taskId} started (active: ${counter1})`);
    await new Promise(resolve => setTimeout(resolve, 100));
    counter1--;
    return `Task ${taskId} done`;
});

const seq = await Promise.all([
    sequentialTask.invoke(1).data,
    sequentialTask.invoke(2).data,
    sequentialTask.invoke(3).data
]);
console.log(`✓ Results:`, seq);

// Example 2: Parallel execution with limited concurrency
console.log("\nExample 2: Limited concurrency (max 3 parallel)");
let counter2 = 0;
const concurrentTask = createAction(async (taskId: number) => {
    counter2++;
    const active = counter2;
    console.log(`  Task ${taskId} started (active: ${active})`);
    await new Promise(resolve => setTimeout(resolve, 100));
    counter2--;
    return `Task ${taskId} done`;
}).setConcurrency(3);

const concurrent = await Promise.all([
    concurrentTask.invoke(1).data,
    concurrentTask.invoke(2).data,
    concurrentTask.invoke(3).data,
    concurrentTask.invoke(4).data,
    concurrentTask.invoke(5).data
]);
console.log(`✓ Results:`, concurrent);

// Example 3: High concurrency for I/O-bound operations
console.log("\nExample 3: High concurrency for I/O operations");
const apiCall = createAction(async (endpoint: string) => {
    console.log(`  Fetching ${endpoint}`);
    await new Promise(resolve => setTimeout(resolve, 50));
    return { endpoint, status: 200 };
}).setConcurrency(10);

const endpoints = Array.from({ length: 10 }, (_, i) => `/api/resource-${i}`);
const results = await Promise.all(endpoints.map(ep => apiCall.invoke(ep).data));
console.log(`✓ Fetched ${results.length} resources`);

/**
 * Rate Limiting
 * 
 * This example demonstrates how to control the rate of action execution
 * using sliding window rate limiting.
 */

import { createAction } from "../src/index.js";

console.log("=== Rate Limiting ===\n");

// Example 1: Basic rate limiting (10 requests per second)
console.log("Example 1: Rate limiting to 10 requests/second");
const rateLimitedTask = createAction(async (taskId: number) => {
    const timestamp = Date.now();
    console.log(`  Task ${taskId} executed at ${timestamp}`);
    return `Task ${taskId} done`;
}).setRateLimit(10); // Max 10 executions per second

const start = Date.now();
const tasks = Array.from({ length: 15 }, (_, i) => rateLimitedTask.invoke(i).data);
await Promise.all(tasks);
const duration = Date.now() - start;
console.log(`✓ Completed 15 tasks in ${duration}ms (expected ~1000ms)`);

// Example 2: Combining concurrency and rate limiting
console.log("\nExample 2: Concurrency + Rate limiting");
const apiCall = createAction(async (endpoint: string) => {
    console.log(`  Calling ${endpoint}`);
    await new Promise(resolve => setTimeout(resolve, 50));
    return { endpoint, status: 200 };
})
.setConcurrency(5)   // Max 5 parallel
.setRateLimit(20);   // Max 20 per second

const endpoints = Array.from({ length: 30 }, (_, i) => `/api/resource-${i}`);
const start2 = Date.now();
const results = await Promise.all(endpoints.map(ep => apiCall.invoke(ep).data));
const duration2 = Date.now() - start2;
console.log(`✓ Completed ${results.length} API calls in ${duration2}ms`);

// Example 3: Conservative rate limiting for external APIs
console.log("\nExample 3: Conservative rate limiting (2 req/sec)");
const externalApi = createAction(async (userId: string) => {
    console.log(`  Fetching data for ${userId}`);
    return { userId, data: "..." };
}).setRateLimit(2); // Very conservative - 2 requests per second

const start3 = Date.now();
const users = ["user1", "user2", "user3", "user4", "user5"];
const userData = await Promise.all(users.map(u => externalApi.invoke(u).data));
const duration3 = Date.now() - start3;
console.log(`✓ Fetched data for ${userData.length} users in ${duration3}ms`);

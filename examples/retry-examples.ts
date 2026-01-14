import { createAction, withContext, type InvocationContext } from "../src/index.js";

// Example 1: Basic retry with exponential backoff
console.log("\n=== Example 1: Basic Retry ===");

let attempt1 = 0;
const flakyCacheQuery = createAction(async (userId: string) => {
    attempt1++;
    console.log(`Attempt ${attempt1} for user ${userId}`);
    
    if (attempt1 < 3) {
        throw new Error("Cache miss - simulated failure");
    }
    
    return `User data for ${userId}`;
}).setRetry({
    maxRetries: 3,
    backoff: 'exponential',
    baseDelay: 100,
    jitter: true
});

const result1 = await flakyCacheQuery.invoke("user123").data;
console.log(`✓ Success:`, result1);

// Example 2: Selective retry based on error type
console.log("\n=== Example 2: Selective Retry (Network Errors Only) ===");

class NetworkError extends Error {
    name = "NetworkError";
}

class ValidationError extends Error {
    name = "ValidationError";
}

let attempt2 = 0;
const apiCall = createAction(async (endpoint: string) => {
    attempt2++;
    console.log(`API call attempt ${attempt2} to ${endpoint}`);
    
    if (attempt2 === 1) {
        throw new NetworkError("Connection timeout");
    }
    
    return { status: 200, data: "Success" };
}).setRetry({
    maxRetries: 3,
    backoff: 'exponential',
    baseDelay: 100,
    shouldRetry: (error) => {
        // Only retry network errors, not validation errors
        return error instanceof NetworkError;
    }
});

const result2 = await apiCall.invoke("/api/users").data;
console.log(`✓ Success:`, result2);

// Example 3: Retry with wide event tracking
console.log("\n=== Example 3: Retry with Event Tracking ===");

let attempt3 = 0;
const monitoredTask = createAction(
    withContext(async (ctx: InvocationContext, taskId: number) => {
        attempt3++;
        ctx.attach("attemptNumber", attempt3);
        ctx.attach("taskId", taskId);
        
        if (attempt3 < 2) {
            throw new Error("Temporary failure");
        }
        
        return `Task ${taskId} completed`;
    })
)
.setRetry({
    maxRetries: 3,
    backoff: 'linear',
    baseDelay: 50
})
.onEvent((event) => {
    if (event.error) {
        console.log(`  [Event] Attempt ${event.retryAttempt} failed, willRetry: ${event.willRetry}`);
    } else {
        console.log(`  [Event] Success on attempt ${event.retryAttempt}, total attempts: ${event.totalAttempts}`);
        console.log(`  [Event] Retry delays:`, event.retryDelays);
    }
});

const result3 = await monitoredTask.invoke(42).data;
console.log(`✓ Final result:`, result3);

// Example 4: Combining retry with concurrency
console.log("\n=== Example 4: Retry + Concurrency ===");

const taskAttempts = new Map<number, number>();

const parallelTask = createAction(async (taskId: number) => {
    const attempts = (taskAttempts.get(taskId) || 0) + 1;
    taskAttempts.set(taskId, attempts);
    
    // First two tasks fail once
    if (attempts === 1 && taskId < 2) {
        throw new Error(`Task ${taskId} failed on first attempt`);
    }
    
    return `Task ${taskId} done`;
})
.setConcurrency(3)
.setRetry({
    maxRetries: 2,
    backoff: 'linear',
    baseDelay: 50
});

const tasks = [0, 1, 2, 3, 4].map(id => parallelTask.invoke(id).data);
const results = await Promise.all(tasks);
console.log(`✓ All tasks completed:`, results);
console.log(`  Task 0 attempts:`, taskAttempts.get(0)); // Should be 2
console.log(`  Task 1 attempts:`, taskAttempts.get(1)); // Should be 2
console.log(`  Task 2 attempts:`, taskAttempts.get(2)); // Should be 1

/**
 * Timeout Examples
 * 
 * Demonstrates timeout capabilities for preventing tasks from running indefinitely.
 */

import { createAction, withContext, withAbortSignal, TimeoutError } from "../src/index.js";

// Helper for simulating delays
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

console.log("=== Timeout Examples ===\n");

// Example 1: Basic Timeout
console.log("1. Basic Timeout");
console.log("   Simple timeout that throws TimeoutError if handler takes too long\n");

const basicTimeoutAction = createAction(async (url: string) => {
    // Simulate slow API call
    await delay(150);
    return { url, data: "response data" };
}).setTimeout(100); // 100ms timeout

try {
    const result = await basicTimeoutAction.invoke("https://api.example.com/data").data;
    console.log("   Result:", result);
} catch (error) {
    if (error instanceof TimeoutError) {
        console.log(`   ❌ Timed out after ${error.duration}ms`);
    }
}

console.log();

// Example 2: Successful Completion Before Timeout
console.log("2. Handler Completes Before Timeout");
console.log("   Handler completes successfully within timeout window\n");

const fastAction = createAction(async (value: number) => {
    await delay(50);
    return value * 2;
}).setTimeout(200);

const fastResult = await fastAction.invoke(21).data;
console.log("   Result:", fastResult, "✓");
console.log();

// Example 3: Timeout with Retry
console.log("3. Timeout with Retry");
console.log("   Retry timeout errors automatically\n");

let attemptCount = 0;
const retryableTimeoutAction = createAction(async (value: number) => {
    attemptCount++;
    console.log(`   Attempt ${attemptCount}`);
    
    if (attemptCount === 1) {
        await delay(150); // First attempt times out
    } else {
        await delay(10); // Second attempt succeeds
    }
    
    return value * 2;
})
.setTimeout(100)
.setRetry({
    maxRetries: 2,
    backoff: 'linear',
    baseDelay: 50,
    shouldRetry: (error) => error instanceof TimeoutError
});

const retryResult = await retryableTimeoutAction.invoke(5).data;
console.log("   Final result:", retryResult, "✓");
console.log();

// Example 4: Timeout with Wide Events
console.log("4. Timeout Metadata in Wide Events");
console.log("   Capture timeout information in event logs\n");

const monitoredAction = createAction(
    withContext(async (ctx, userId: string) => {
        ctx.attach("userId", userId);
        ctx.attach("operation", "fetchUserData");
        await delay(80);
        return { id: userId, name: "John Doe" };
    })
)
.setTimeout(200)
.onEvent((event) => {
    console.log("   Event captured:");
    console.log("     - Duration:", event.duration, "ms");
    console.log("     - Timeout:", event.timeout, "ms");
    console.log("     - Timed out:", event.timedOut);
    console.log("     - Attachments:", event.attachments);
    console.log("     - Output:", event.output);
});

await monitoredAction.invoke("user-123").data;
console.log();

// Example 5: Timeout with Partial Results Preserved
console.log("5. Attachments Preserved on Timeout");
console.log("   Capture partial progress even when timeout occurs\n");

const partialProgressAction = createAction(
    withContext(async (ctx, jobId: string) => {
        ctx.attach("jobId", jobId);
        ctx.attach("stage", "initialization");
        await delay(30);
        
        ctx.attach("stage", "processing");
        ctx.attach("itemsProcessed", 42);
        await delay(30);
        
        ctx.attach("stage", "finalizing");
        await delay(100); // This will cause timeout
        
        return { jobId, status: "complete" };
    })
)
.setTimeout(75)
.onEvent((event) => {
    console.log("   Job status at timeout:");
    console.log("     - Stage reached:", event.attachments.stage);
    console.log("     - Items processed:", event.attachments.itemsProcessed);
    console.log("     - Execution time:", event.executionTime, "ms");
});

try {
    await partialProgressAction.invoke("job-456").data;
} catch (error) {
    console.log("   ❌ Job timed out (expected)");
}
console.log();

// Example 6: Cooperative Timeout with AbortSignal
console.log("6. Cooperative Timeout with AbortSignal");
console.log("   Handler receives AbortSignal for graceful cancellation\n");

const cooperativeAction = createAction(
    withAbortSignal(async (signal, url: string) => {
        console.log("   Starting fetch operation...");
        
        // Simulate checking signal periodically
        for (let i = 0; i < 10; i++) {
            if (signal.aborted) {
                console.log("   Detected abort signal, cleaning up...");
                throw new Error("Operation cancelled");
            }
            await delay(20);
        }
        
        return { url, data: "complete" };
    })
).setTimeout({ duration: 100, abortSignal: true });

try {
    await cooperativeAction.invoke("https://api.example.com/data").data;
} catch (error) {
    if (error instanceof TimeoutError) {
        console.log("   ❌ Timed out with signal cancellation");
    }
}
console.log();

// Example 7: Batch Operations with Timeouts
console.log("7. Batch Operations with Independent Timeouts");
console.log("   Each task gets its own timeout, failures don't stop the batch\n");

const batchAction = createAction(async (taskDuration: number) => {
    await delay(taskDuration);
    return { duration: taskDuration, status: "complete" };
}).setTimeout(100);

const batchResults = await batchAction.invokeAll([
    [50],   // Fast task - succeeds
    [150],  // Slow task - times out
    [30],   // Fast task - succeeds
    [200],  // Very slow - times out
]);

console.log("   Batch results:");
batchResults.forEach((result, idx) => {
    if (result.error) {
        console.log(`     Task ${idx + 1}: ❌ ${result.error.message}`);
    } else {
        console.log(`     Task ${idx + 1}: ✓ Completed in ${result.data.duration}ms`);
    }
});
console.log();

// Example 8: Database Query Timeout
console.log("8. Database Query with Timeout");
console.log("   Prevent long-running queries from blocking resources\n");

const queryAction = createAction(
    withContext(async (ctx, query: string) => {
        ctx.attach("query", query);
        ctx.attach("startTime", Date.now());
        
        // Simulate database query
        const queryTime = query.includes("SLOW") ? 150 : 50;
        await delay(queryTime);
        
        const rows = [{ id: 1, name: "Result" }];
        ctx.attach("rowCount", rows.length);
        ctx.attach("queryDuration", queryTime);
        
        return rows;
    })
)
.setTimeout(100)
.setConcurrency(5) // Connection pool size
.onEvent((event) => {
    if (event.timedOut) {
        console.log(`   ⚠️  Query timed out: ${event.attachments.query}`);
        console.log(`       Execution time: ${event.executionTime}ms`);
    } else {
        console.log(`   ✓ Query completed: ${event.attachments.rowCount} rows in ${event.attachments.queryDuration}ms`);
    }
});

await queryAction.invoke("SELECT * FROM users").data;

try {
    await queryAction.invoke("SELECT * FROM SLOW_table").data;
} catch (error) {
    // Handled in event callback
}
console.log();

// Example 9: API Request with Retry on Timeout
console.log("9. API Request - Retry on Transient Timeouts");
console.log("   Retry timeouts in case of temporary network issues\n");

let apiCallCount = 0;
const apiAction = createAction(async (endpoint: string) => {
    apiCallCount++;
    const callDelay = apiCallCount === 1 ? 120 : 30; // First call times out
    
    console.log(`   API call #${apiCallCount} (${callDelay}ms delay)`);
    await delay(callDelay);
    
    return { endpoint, data: "success", attempt: apiCallCount };
})
.setTimeout(100)
.setRetry({
    maxRetries: 2,
    backoff: 'exponential',
    baseDelay: 100,
    shouldRetry: (error) => error instanceof TimeoutError
});

const apiResult = await apiAction.invoke("/api/users").data;
console.log("   API Result:", apiResult, "✓");
console.log();

// Example 10: Timeout with Rate Limiting
console.log("10. Timeout with Rate Limiting");
console.log("    Prevent resource exhaustion while enforcing timeouts\n");

const rateLimitedAction = createAction(async (taskId: number) => {
    const taskDuration = taskId % 2 === 0 ? 120 : 30; // Even IDs timeout
    await delay(taskDuration);
    return { taskId, duration: taskDuration };
})
.setTimeout(100)
.setRateLimit(10) // Max 10 per second
.onEvent((event) => {
    const taskId = event.input[0];
    if (event.timedOut) {
        console.log(`    Task ${taskId}: ❌ Timed out`);
    } else {
        console.log(`    Task ${taskId}: ✓ Completed`);
    }
});

// Execute 4 tasks (2 will timeout, 2 will succeed)
const rateLimitResults = await rateLimitedAction.invokeAll([
    [1], [2], [3], [4]
]);

console.log(`    Completed ${rateLimitResults.filter(r => !r.error).length}/4 tasks`);
console.log();

console.log("=== All Examples Complete ===");

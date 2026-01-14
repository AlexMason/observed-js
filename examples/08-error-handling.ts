/**
 * Error Handling
 * 
 * This example demonstrates different error handling patterns and
 * how errors propagate through the action system.
 */

import { createAction, withContext } from "../src/index.js";

console.log("=== Error Handling ===\n");

// Example 1: Basic error propagation
console.log("Example 1: Basic error propagation");
const failingTask = createAction(async (shouldFail: boolean) => {
    if (shouldFail) {
        throw new Error("Task failed as requested");
    }
    return "Success";
});

try {
    await failingTask.invoke(true).data;
} catch (error) {
    console.log(`  ✓ Caught error: ${error instanceof Error ? error.message : String(error)}`);
}

// Example 2: Error tracking with wide events
console.log("\nExample 2: Error tracking with events");
const monitoredTask = createAction(
    withContext(async (ctx, operation: string) => {
        ctx.attach("operation", operation);
        ctx.attach("startTime", Date.now());
        
        try {
            if (operation === "fail") {
                throw new Error("Operation failed");
            }
            return "success";
        } catch (error) {
            ctx.attach("errorPhase", "execution");
            if (error instanceof Error) {
                ctx.attach("errorMessage", error.message);
            }
            throw error;
        }
    })
).onEvent((event) => {
    if (event.error) {
        console.log(`  [Error Event]`, {
            operation: event.attachments?.operation,
            error: event.error.message,
            duration: event.duration
        });
    } else {
        console.log(`  [Success Event]`, {
            operation: event.attachments?.operation,
            duration: event.duration
        });
    }
});

await monitoredTask.invoke("success").data;
try {
    await monitoredTask.invoke("fail").data;
} catch (error) {
    console.log(`  ✓ Error handled: ${error instanceof Error ? error.message : String(error)}`);
}

// Example 3: Batch error handling with invokeAll
console.log("\nExample 3: Handling errors in batches");
const batchTask = createAction(async (taskId: number) => {
    if (taskId % 3 === 0) {
        throw new Error(`Task ${taskId} failed`);
    }
    return `Task ${taskId} success`;
});

const results = await batchTask.invokeAll([[1], [2], [3], [4], [5], [6]]);
console.log("  Results:");
results.forEach((result, index) => {
    if (result.data) {
        console.log(`    [${index}] ✓ ${result.data}`);
    } else if (result.error) {
        console.log(`    [${index}] ✗ ${result.error.message}`);
    }
});

// Example 4: Typed errors with selective handling
console.log("\nExample 4: Typed errors");

class ValidationError extends Error {
    name = "ValidationError";
}

class DatabaseError extends Error {
    name = "DatabaseError";
}

const typedErrorTask = createAction(async (errorType: "none" | "validation" | "database") => {
    if (errorType === "validation") {
        throw new ValidationError("Invalid input data");
    } else if (errorType === "database") {
        throw new DatabaseError("Database connection failed");
    }
    return "Success";
});

const errorResults = await typedErrorTask.invokeAll([["none"], ["validation"], ["database"]]);
console.log("  Error classification:");
errorResults.forEach((result, index) => {
    if (result.data) {
        console.log(`    [${index}] Success`);
    } else if (result.error) {
        console.log(`    [${index}] ${result.error.name}: ${result.error.message}`);
    }
});

// Example 5: Event callbacks for logging
console.log("\nExample 5: Event callbacks for observability");
const observedTask = createAction(async (value: string) => {
    return value.toUpperCase();
}).onEvent((event) => {
    console.log(`  [Event] Input: ${event.input[0]}, Output: ${event.output}`);
});

const safeResult = await observedTask.invoke("hello").data;
console.log(`  ✓ Task completed successfully: ${safeResult}`);

// Example 6: Stream error handling
console.log("\nExample 6: Errors in stream processing");
const streamTask = createAction(async (id: number) => {
    await new Promise(resolve => setTimeout(resolve, 20));
    if (id === 3 || id === 5) {
        throw new Error(`Stream item ${id} failed`);
    }
    return `Item ${id}`;
});

console.log("  Stream results:");
for await (const result of streamTask.invokeStream([[1], [2], [3], [4], [5], [6]])) {
    if (result.data) {
        console.log(`    ✓ ${result.data}`);
    } else if (result.error) {
        console.log(`    ✗ ${result.error.message}`);
    }
}
console.log(`  ✓ Stream completed despite errors`);

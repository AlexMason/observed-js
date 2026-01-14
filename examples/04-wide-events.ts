/**
 * Wide Events and Context Attachment
 * 
 * This example demonstrates how to capture rich, structured context
 * for observability using the InvocationContext.
 */

import { createAction, withContext } from "../src/index.js";

console.log("=== Wide Events & Context ===\n");

// Example 1: Basic context attachment
console.log("Example 1: Basic context attachment");
const dbQuery = createAction(
    withContext(async (ctx, userId: string) => {
        ctx.attach("userId", userId);
        ctx.attach("operation", "SELECT");
        
        // Simulate database query
        const startTime = Date.now();
        await new Promise(resolve => setTimeout(resolve, 50));
        const duration = Date.now() - startTime;
        
        ctx.attach("queryDurationMs", duration);
        ctx.attach("rowsReturned", 42);
        
        return { userId, rows: 42 };
    })
).onEvent((event) => {
    console.log("  [Event]", {
        actionId: event.actionId,
        attachments: event.attachments,
        duration: event.duration,
        success: !event.error
    });
});

await dbQuery.invoke("user-123").data;

// Example 2: Bulk attachment with objects
console.log("\nExample 2: Bulk attachment");
const apiCall = createAction(
    withContext(async (ctx, endpoint: string) => {
        // Attach multiple values at once
        ctx.attach({
            endpoint,
            method: "GET",
            requestId: Math.random().toString(36).substring(7)
        });
        
        await new Promise(resolve => setTimeout(resolve, 30));
        
        // Response metadata
        ctx.attach({
            statusCode: 200,
            contentType: "application/json",
            responseTime: 30
        });
        
        return { data: "success" };
    })
).onEvent((event) => {
    console.log("  [Event] API call completed:", event.attachments);
});

await apiCall.invoke("/api/users").data;

// Example 3: Deep merge for nested objects
console.log("\nExample 3: Deep merge for nested attachments");
const enrichedTask = createAction(
    withContext(async (ctx, taskId: number) => {
        // Initial metadata
        ctx.attach("metadata", { taskId, stage: "init" });
        
        await new Promise(resolve => setTimeout(resolve, 20));
        
        // Additional metadata merges deeply
        ctx.attach("metadata", { stage: "processing", progress: 0.5 });
        
        await new Promise(resolve => setTimeout(resolve, 20));
        
        // Final metadata
        ctx.attach("metadata", { stage: "complete", progress: 1.0 });
        
        return `Task ${taskId} complete`;
    })
).onEvent((event) => {
    console.log("  [Event] Task metadata:", event.attachments?.metadata);
});

await enrichedTask.invoke(1).data;

// Example 4: Error tracking with context
console.log("\nExample 4: Error tracking with context");
const riskyOperation = createAction(
    withContext(async (ctx, operationId: string) => {
        ctx.attach("operationId", operationId);
        ctx.attach("startTime", new Date().toISOString());
        
        try {
            await new Promise(resolve => setTimeout(resolve, 10));
            throw new Error("Operation failed");
        } catch (error) {
            ctx.attach("errorContext", {
                phase: "execution",
                attemptNumber: 1
            });
            throw error;
        }
    })
).onEvent((event) => {
    if (event.error) {
        console.log("  [Event] Error occurred:", {
            error: event.error.message,
            context: event.attachments
        });
    }
});

try {
    await riskyOperation.invoke("op-456").data;
} catch (error) {
    console.log("  ✓ Error handled");
}

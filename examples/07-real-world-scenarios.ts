/**
 * Real-World Scenarios
 * 
 * This example demonstrates practical use cases with realistic implementations.
 */

import { createAction, withContext } from "../src/index.js";

console.log("=== Real-World Scenarios ===\n");

// Scenario 1: Image processing service
console.log("Scenario 1: Image Processing Service");

interface ImageProcessingJob {
    imageId: string;
    url: string;
    operations: string[];
}

const processImage = createAction(
    withContext(async (ctx, job: ImageProcessingJob) => {
        ctx.attach({
            imageId: job.imageId,
            operations: job.operations,
            startTime: Date.now()
        });
        
        // Simulate downloading image
        await new Promise(resolve => setTimeout(resolve, 50));
        ctx.attach("downloadTimeMs", 50);
        
        // Simulate processing each operation
        for (const op of job.operations) {
            await new Promise(resolve => setTimeout(resolve, 30));
            ctx.attach(`operation_${op}`, "completed");
        }
        
        const totalTime = 50 + (job.operations.length * 30);
        ctx.attach({
            totalProcessingTimeMs: totalTime,
            outputUrl: `https://cdn.example.com/processed/${job.imageId}.jpg`
        });
        
        return {
            imageId: job.imageId,
            processedUrl: `https://cdn.example.com/processed/${job.imageId}.jpg`
        };
    })
)
.setConcurrency(4)     // CPU-bound: limit parallelism
.setRateLimit(50)      // API rate limit
.onEvent((event) => {
    if (!event.error) {
        const { imageId, totalProcessingTimeMs } = event.attachments || {};
        console.log(`  [Processed] ${imageId} in ${totalProcessingTimeMs}ms`);
    }
});

const jobs: ImageProcessingJob[] = [
    { imageId: "img-1", url: "https://example.com/1.jpg", operations: ["resize", "compress"] },
    { imageId: "img-2", url: "https://example.com/2.jpg", operations: ["resize", "watermark", "compress"] },
    { imageId: "img-3", url: "https://example.com/3.jpg", operations: ["crop", "resize"] }
];

const processed = await processImage.invokeAll(jobs.map(job => [job]));
console.log(`✓ Processed ${processed.filter(r => r.data).length} images\n`);

// Scenario 2: Email campaign sender
console.log("Scenario 2: Email Campaign Sender");

interface EmailRecipient {
    email: string;
    name: string;
    variables: Record<string, string>;
}

const sendEmail = createAction(
    withContext(async (ctx, recipient: EmailRecipient) => {
        ctx.attach({
            recipientEmail: recipient.email,
            templateVariables: recipient.variables
        });
        
        // Simulate email sending
        await new Promise(resolve => setTimeout(resolve, 40));
        
        // Simulate occasional delivery issues
        if (Math.random() < 0.1) {
            ctx.attach("deliveryStatus", "bounced");
            throw new Error("Email bounced");
        }
        
        ctx.attach({
            deliveryStatus: "sent",
            messageId: Math.random().toString(36).substring(7)
        });
        
        return {
            email: recipient.email,
            status: "sent"
        };
    })
)
.setConcurrency(10)    // Send multiple emails concurrently
.setRateLimit(50)      // Email provider rate limit
.setRetry({
    maxRetries: 2,
    backoff: 'exponential',
    baseDelay: 1000,
    shouldRetry: (error) => error instanceof Error && error.message === "Email bounced"
})
.onEvent((event) => {
    if (!event.error) {
        console.log(`  [Sent] ${event.attachments?.recipientEmail}`);
    } else if (!event.willRetry) {
        console.log(`  [Failed] ${event.attachments?.recipientEmail}`);
    }
});

const recipients: EmailRecipient[] = [
    { email: "user1@example.com", name: "Alice", variables: { code: "ABC123" } },
    { email: "user2@example.com", name: "Bob", variables: { code: "DEF456" } },
    { email: "user3@example.com", name: "Carol", variables: { code: "GHI789" } },
    { email: "user4@example.com", name: "Dave", variables: { code: "JKL012" } },
    { email: "user5@example.com", name: "Eve", variables: { code: "MNO345" } }
];

const emailResults = await sendEmail.invokeAll(recipients.map(r => [r]));
const sentCount = emailResults.filter(r => r.data).length;
console.log(`✓ Sent ${sentCount}/${recipients.length} emails\n`);

// Scenario 3: Webhook delivery system
console.log("Scenario 3: Webhook Delivery System");

interface WebhookPayload {
    webhookUrl: string;
    event: string;
    data: Record<string, unknown>;
}

class WebhookError extends Error {
    constructor(message: string, public statusCode: number) {
        super(message);
        this.name = "WebhookError";
    }
}

const deliverWebhook = createAction(
    withContext(async (ctx, payload: WebhookPayload) => {
        ctx.attach({
            webhookUrl: payload.webhookUrl,
            eventType: payload.event,
            attemptTime: new Date().toISOString()
        });
        
        // Simulate HTTP request
        await new Promise(resolve => setTimeout(resolve, 60));
        
        // Simulate various HTTP responses
        const rand = Math.random();
        if (rand < 0.15) {
            ctx.attach("responseStatus", 500);
            throw new WebhookError("Internal Server Error", 500);
        } else if (rand < 0.25) {
            ctx.attach("responseStatus", 429);
            throw new WebhookError("Rate Limited", 429);
        }
        
        ctx.attach({
            responseStatus: 200,
            responseTime: 60
        });
        
        return {
            url: payload.webhookUrl,
            delivered: true
        };
    })
)
.setConcurrency(5)     // Limit parallel webhook deliveries
.setRateLimit(30)      // Overall rate limit
.setRetry({
    maxRetries: 3,
    backoff: 'exponential',
    baseDelay: 500,
    maxDelay: 10000,
    jitter: true,
    shouldRetry: (error) => {
        // Retry on 5xx errors and rate limits, not on 4xx client errors
        if (error instanceof WebhookError) {
            return error.statusCode >= 500 || error.statusCode === 429;
        }
        return true;
    }
})
.onEvent((event) => {
    if (!event.error) {
        console.log(`  [Delivered] ${event.attachments?.webhookUrl} (${event.attachments?.eventType})`);
    } else if (event.willRetry && event.retryAttempt !== undefined) {
        console.log(`  [Retry] ${event.attachments?.webhookUrl} - attempt ${event.retryAttempt + 1}`);
    } else {
        console.log(`  [Failed] ${event.attachments?.webhookUrl} after ${event.totalAttempts} attempts`);
    }
});

const webhooks: WebhookPayload[] = [
    { webhookUrl: "https://api.partner1.com/webhook", event: "user.created", data: { userId: "123" } },
    { webhookUrl: "https://api.partner2.com/webhook", event: "user.created", data: { userId: "123" } },
    { webhookUrl: "https://api.partner3.com/webhook", event: "user.created", data: { userId: "123" } },
    { webhookUrl: "https://api.partner4.com/webhook", event: "user.created", data: { userId: "123" } }
];

const webhookResults = await deliverWebhook.invokeAll(webhooks.map(w => [w]));
const deliveredCount = webhookResults.filter(r => r.data).length;
console.log(`✓ Delivered ${deliveredCount}/${webhooks.length} webhooks`);

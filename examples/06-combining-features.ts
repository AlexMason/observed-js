/**
 * Combining Multiple Features
 * 
 * This example demonstrates how to combine concurrency, rate limiting,
 * retry, and wide events for production-ready action configuration.
 */

import { createAction, withContext } from "../src/index.js";

console.log("=== Combining Features ===\n");

// Example 1: Resilient API client
console.log("Example 1: Resilient API client with full configuration");

class NetworkError extends Error {
    name = "NetworkError";
}

let apiCallCount = 0;
const resilientApiCall = createAction(
    withContext(async (ctx, endpoint: string) => {
        apiCallCount++;
        const requestId = Math.random().toString(36).substring(7);
        
        ctx.attach({
            endpoint,
            requestId,
            timestamp: Date.now()
        });
        
        // Simulate intermittent failures
        if (apiCallCount === 2) {
            ctx.attach("error", "network_timeout");
            throw new NetworkError("Request timeout");
        }
        
        // Simulate API call
        await new Promise(resolve => setTimeout(resolve, 50));
        
        ctx.attach({
            statusCode: 200,
            responseTime: 50
        });
        
        return {
            requestId,
            endpoint,
            data: { status: "success" }
        };
    })
)
.setConcurrency(5)      // Max 5 concurrent requests
.setRateLimit(20)       // Max 20 requests per second
.setRetry({
    maxRetries: 3,
    backoff: 'exponential',
    baseDelay: 100,
    maxDelay: 5000,
    jitter: true,
    shouldRetry: (error) => error instanceof NetworkError
})
.onEvent((event) => {
    if (event.error && event.willRetry) {
        console.log(`  [Retry] ${event.attachments?.endpoint} - attempt ${event.retryAttempt}`);
    } else if (!event.error) {
        console.log(`  [Success] ${event.attachments?.endpoint} - ${event.attachments?.requestId}`);
    }
});

const endpoints = ["/api/users", "/api/posts", "/api/comments"];
const apiResults = await resilientApiCall.invokeAll(endpoints.map(ep => [ep]));
console.log(`✓ Completed ${apiResults.length} API calls`);

// Example 2: Database batch processor with observability
console.log("\nExample 2: Batch database processor");

interface BatchRecord {
    id: string;
    data: Record<string, unknown>;
}

const batchProcessor = createAction(
    withContext(async (ctx, batch: BatchRecord[]) => {
        ctx.attach("batchSize", batch.length);
        ctx.attach("batchIds", batch.map(r => r.id));
        
        const startTime = Date.now();
        
        // Process each record
        const processed = [];
        for (const record of batch) {
            await new Promise(resolve => setTimeout(resolve, 10));
            processed.push({ ...record, processedAt: Date.now() });
        }
        
        const duration = Date.now() - startTime;
        ctx.attach({
            processingTimeMs: duration,
            recordsPerSecond: (batch.length / duration) * 1000,
            successCount: processed.length
        });
        
        return processed;
    })
)
.setConcurrency(3)     // Process 3 batches in parallel
.setRateLimit(10)      // Max 10 batches per second
.onEvent((event) => {
    if (!event.error) {
        const { batchSize, processingTimeMs, recordsPerSecond } = event.attachments || {};
        console.log(`  [Batch] ${batchSize} records in ${processingTimeMs}ms (${Math.round(Number(recordsPerSecond))} rec/sec)`);
    }
});

const batches = [
    [{ id: "1", data: {} }, { id: "2", data: {} }],
    [{ id: "3", data: {} }, { id: "4", data: {} }, { id: "5", data: {} }],
    [{ id: "6", data: {} }]
];

for await (const result of batchProcessor.invokeStream(batches.map(b => [b]))) {
    if (result.data) {
        const data = await result.data;
        console.log(`  ✓ Batch processed: ${data.length} records`);
    }
}

// Example 3: Rate-limited crawler with retry
console.log("\nExample 3: Web crawler with rate limiting and retry");

const crawl = createAction(
    withContext(async (ctx, url: string) => {
        ctx.attach("url", url);
        ctx.attach("crawlTime", new Date().toISOString());
        
        // Simulate crawling
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Simulate occasional failures
        if (Math.random() < 0.2) {
            throw new Error("Crawl failed");
        }
        
        ctx.attach("linksFound", Math.floor(Math.random() * 50));
        
        return { url, status: "crawled" };
    })
)
.setConcurrency(2)     // Polite crawling - only 2 concurrent
.setRateLimit(5)       // Max 5 pages per second
.setRetry({
    maxRetries: 2,
    backoff: 'exponential',
    baseDelay: 200
})
.onEvent((event) => {
    if (!event.error) {
        console.log(`  [Crawl] ${event.attachments?.url} - ${event.attachments?.linksFound} links`);
    } else if (event.willRetry && event.retryAttempt !== undefined) {
        console.log(`  [Retry] ${event.attachments?.url} - attempt ${event.retryAttempt + 1}`);
    }
});

const urls = [
    "https://example.com/page1",
    "https://example.com/page2",
    "https://example.com/page3",
    "https://example.com/page4",
    "https://example.com/page5"
];

const crawlResults = await crawl.invokeAll(urls.map(url => [url]));
const successCount = crawlResults.filter(r => r.data).length;
console.log(`✓ Successfully crawled ${successCount}/${urls.length} pages`);

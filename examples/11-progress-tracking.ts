import { createAction, withContext } from "../src/index.js";

console.log("=== Progress Tracking Examples ===\n");

// Helper to simulate work
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Example 1: Basic handler progress tracking
console.log("1. Basic Handler Progress Tracking");
const processItems = createAction(
    withContext(async (ctx, items: string[]) => {
        ctx.setTotal(items.length);
        
        const results = [];
        for (let i = 0; i < items.length; i++) {
            await delay(100); // Simulate work
            results.push(items[i]!.toUpperCase());
            ctx.incrementProgress(`Processing ${items[i]}`);
        }
        
        return results;
    })
).onProgress((progress) => {
    console.log(
        `Progress: ${progress.completed}/${progress.total} (${progress.percentage}%) ` +
        `${progress.current ? `- ${progress.current}` : ''} ` +
        `${progress.rate ? `[${progress.rate.toFixed(2)} items/s]` : ''} ` +
        `${progress.estimatedTimeRemaining ? `ETA: ${(progress.estimatedTimeRemaining / 1000).toFixed(1)}s` : ''}`
    );
});

await processItems.invoke(["apple", "banana", "cherry", "date", "elderberry"]).data;
console.log();

// Example 2: Batch progress with invokeAll
console.log("2. Batch Progress with invokeAll");
const fetchData = createAction(async (url: string) => {
    await delay(150); // Simulate network request
    return { url, data: `Data from ${url}` };
}).onProgress((progress) => {
    console.log(`Fetching: ${progress.completed}/${progress.total} URLs (${progress.percentage}%)`);
});

const urls = [
    "https://api.example.com/users",
    "https://api.example.com/posts",
    "https://api.example.com/comments",
    "https://api.example.com/albums",
    "https://api.example.com/photos"
];

await fetchData.invokeAll(urls.map(url => [url]));
console.log();

// Example 3: Progress with retry
console.log("3. Progress with Retry");
let attemptNumber = 0;
const unreliableTask = createAction(
    withContext(async (ctx, steps: number) => {
        attemptNumber++;
        ctx.setTotal(steps);
        
        for (let i = 1; i <= steps; i++) {
            await delay(80);
            ctx.incrementProgress(`Step ${i}`);
            
            // Fail on first attempt at step 3
            if (attemptNumber === 1 && i === 3) {
                throw new Error("Simulated failure");
            }
        }
        
        return "Success!";
    })
)
.setRetry({ maxRetries: 2, backoff: 'linear', baseDelay: 100 })
.onProgress((progress) => {
    console.log(
        `Attempt ${attemptNumber}: ${progress.completed}/${progress.total} (${progress.percentage}%) ` +
        `${progress.current || ''}`
    );
});

try {
    await unreliableTask.invoke(5).data;
} catch (e) {
    console.log("Task failed:", (e as Error).message);
}
console.log();

// Example 4: Fine-grained progress reporting
console.log("4. Fine-grained Progress (Sub-steps)");
const processFile = createAction(
    withContext(async (ctx, filename: string) => {
        const chunks = 20; // Simulate file with 20 chunks
        ctx.setTotal(chunks);
        
        for (let chunk = 1; chunk <= chunks; chunk++) {
            await delay(50); // Simulate processing chunk
            ctx.reportProgress(chunk, `Processing chunk ${chunk}/${chunks}`);
        }
        
        return `Processed ${filename}`;
    })
).onProgress((progress) => {
    // Only log on significant progress to reduce noise
    if (progress.percentage % 20 === 0 || progress.completed === progress.total) {
        console.log(
            `File progress: ${progress.percentage}% ` +
            `(${progress.completed}/${progress.total} chunks) ` +
            `${progress.rate ? `[${progress.rate.toFixed(1)} chunks/s]` : ''}`
        );
    }
});

await processFile.invoke("large-data.csv").data;
console.log();

// Example 5: Batch progress with concurrent execution
console.log("5. Batch Progress with Concurrency");
const slowTask = createAction(async (id: number) => {
    await delay(200);
    return `Task ${id} complete`;
})
.setConcurrency(3) // Process 3 at a time
.onProgress((progress) => {
    console.log(
        `Concurrent batch: ${progress.completed}/${progress.total} ` +
        `(${progress.percentage}%) ` +
        `${progress.rate ? `[${progress.rate.toFixed(2)} tasks/s]` : ''} ` +
        `${progress.estimatedTimeRemaining ? `ETA: ${(progress.estimatedTimeRemaining / 1000).toFixed(1)}s` : ''}`
    );
});

await slowTask.invokeAll(Array.from({ length: 10 }, (_, i) => [i + 1]));
console.log();

// Example 6: Streaming with progress
console.log("6. Streaming with Progress");
const streamTask = createAction(async (id: number) => {
    await delay(100 + Math.random() * 100); // Variable duration
    return `Stream item ${id}`;
}).onProgress((progress) => {
    console.log(
        `Stream progress: ${progress.completed}/${progress.total} ` +
        `(${progress.percentage}%)`
    );
});

console.log("Results as they complete:");
for await (const result of streamTask.invokeStream(Array.from({ length: 5 }, (_, i) => [i + 1]))) {
    if (result.error) {
        console.log(`  ❌ Item ${result.index} failed:`, result.error.message);
    } else {
        console.log(`  ✓ Item ${result.index}:`, result.data);
    }
}
console.log();

// Example 7: Custom throttle for high-frequency updates
console.log("7. Custom Throttle (High-frequency updates)");
const highFrequencyTask = createAction(
    withContext(async (ctx) => {
        const total = 1000;
        ctx.setTotal(total);
        
        for (let i = 1; i <= total; i++) {
            // Very fast operations
            if (i % 10 === 0) await delay(1); // Occasional delay
            ctx.incrementProgress();
        }
        
        return total;
    })
).onProgress((progress) => {
    // With throttle, only significant updates are logged
    console.log(`Fast progress: ${progress.completed}/${progress.total} (${progress.percentage}%)`);
}, { throttle: 200 }); // Only emit every 200ms

await highFrequencyTask.invoke().data;
console.log();

// Example 8: Progress without context (batch-level only)
console.log("8. Batch-Level Progress (No Handler Progress)");
const simpleTask = createAction(async (n: number) => {
    await delay(100);
    return n * 2;
}).onProgress((progress) => {
    console.log(
        `Batch only: ${progress.completed}/${progress.total} ` +
        `(${progress.percentage}%)`
    );
});

await simpleTask.invokeAll(Array.from({ length: 5 }, (_, i) => [i + 1]));
console.log();

console.log("=== All Examples Complete ===");

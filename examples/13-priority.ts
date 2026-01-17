/**
 * Priority Overrides
 *
 * This example demonstrates priority-based scheduling.
 * Higher-priority queued tasks execute before lower-priority queued tasks.
 * Within the same priority, FIFO order is preserved.
 */

import { createAction } from "../src/index.js";

console.log("=== Priority Overrides ===\n");

const started: string[] = [];

const task = createAction(async (label: string) => {
    started.push(label);
    // Keep the first task running long enough for others to queue.
    await new Promise((resolve) => setTimeout(resolve, 50));
    return label;
})
.setConcurrency(1)
.setPriority('normal');

// First invocation starts immediately.
const a = task.invoke("A");

// Give the scheduler a microtask to start A before queueing others.
await Promise.resolve();

// These queue behind A.
const b = task.invoke("B", { priority: 'low' });
const c = task.invoke("C", { priority: 'high' });
const d = task.invoke("D", { priority: 'critical' });

const results = await Promise.all([a.data, b.data, c.data, d.data]);

console.log("Execution start order:", started.join(" -> "));
console.log("Results:", results);
console.log("Expected start order: A -> D -> C -> B");

/**
 * getContext()
 *
 * getContext() returns the running invocation's context from the handler
 * or from any function it calls, at any depth - no need to thread `ctx`
 * through your helpers. It throws when called outside an invocation.
 */

import { createAction, getContext, TimeoutError } from "../src/index.js";

console.log("=== getContext() ===\n");

// a. Helpers attach data without receiving ctx
console.log("1. Helpers two calls deep attach to the wide event");

function recordLookup(userId: string) {
    getContext().attach({ lookupUser: userId, source: "cache" });
}

async function loadUser(userId: string) {
    recordLookup(userId);
    await Promise.resolve();
    getContext().attach("loaded", true);
    return { userId, name: "Ada" };
}

const fetchUser = createAction(async (userId: string) => loadUser(userId))
    .onEvent((event) => {
        console.log("   attachments:", event.attachments);
    });

await fetchUser.invoke("user-1").data;
console.log();

// b. Nested actions get their own context, linked to the caller
console.log("2. Nested action links to its parent");

const childEvents: { actionId: string }[] = [];
const child = createAction(async () => {
    const ctx = getContext();
    console.log(`   child sees actionId=${ctx.actionId}, parent=${ctx.parent?.actionId}`);
    return { actionId: ctx.actionId, parentId: ctx.parent?.actionId };
}).onEvent((event) => childEvents.push(event));

const parent = createAction(async () => {
    console.log(`   parent actionId=${getContext().actionId}`);
    return child.invoke().data;
});

const parentInvocation = parent.invoke();
const childResult = await parentInvocation.data;
console.log(`   child event actionId matches: ${childEvents[0]?.actionId === childResult.actionId}`);
console.log(`   child.parent === parent event actionId: ${childResult.parentId === parentInvocation.actionId}`);
console.log();

// c. ctx.signal is aborted on timeout
console.log("3. Timeout rejects and aborts getContext().signal");

function cancellableDelay(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(signal.reason);
        }, { once: true });
    });
}

let timeoutSignal: AbortSignal | undefined;
const slow = createAction(async () => {
    timeoutSignal = getContext().signal;
    await cancellableDelay(5_000, timeoutSignal);
    return "done";
}).setTimeout(100);

try {
    await slow.invoke().data;
} catch (error) {
    if (error instanceof TimeoutError) {
        console.log(`   caught ${error.name}`);
        console.log(`   signal aborted: ${(timeoutSignal?.reason as Error).name}`);
    }
}
console.log();

// d. ctx.signal is aborted on cancel
console.log("4. cancel() aborts getContext().signal");

let cancelSignal: AbortSignal | undefined;
const longJob = createAction(async () => {
    cancelSignal = getContext().signal;
    await cancellableDelay(5_000, cancelSignal);
});

const job = longJob.invoke();
setTimeout(() => job.cancel("User cancelled"), 50);
try {
    await job.data;
} catch (error) {
    console.log(`   invocation rejected: ${(error as Error).name}`);
}
console.log(`   signal aborted: ${cancelSignal?.aborted}, reason: ${String(cancelSignal?.reason)}`);
console.log();

// e. Outside an invocation
console.log("5. getContext() outside an invocation throws");
try {
    getContext();
} catch (error) {
    console.log(`   ${(error as Error).message}`);
}

console.log("\n=== Done ===");

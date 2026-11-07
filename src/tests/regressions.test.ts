/**
 * Regression tests for bugs found during the component audit.
 * These are EXPECTED TO FAIL until the corresponding bugs are fixed.
 * Each test name is prefixed with the audit bug number.
 */
import { ExecutionScheduler, createAction } from "../index.js";
import { assert, test, delay, printSection, printSummary, getUnhandledRejections } from "./helpers.js";

/** Max number of timestamps inside any sliding window of `win` ms. */
function maxInWindow(starts: number[], win = 1000): number {
    let max = 0;
    for (let i = 0; i < starts.length; i++) {
        let c = 0;
        for (let j = i; j < starts.length; j++) if (starts[j]! - starts[i]! < win) c++;
        max = Math.max(max, c);
    }
    return max;
}

const timeoutResourceCount = () =>
    process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

printSection("Bug 1: unhandled rejections");

await test("[bug 1] failed action must not cause an unhandled rejection when caller handles .data", async () => {
    const marker = `boom-${Math.random()}`;
    const action = createAction(async () => {
        throw new Error(marker);
    });
    await action.invoke().data.catch(() => {});
    await delay(50);
    const leaked = getUnhandledRejections().filter((r) => (r.reason as Error)?.message === marker);
    assert.strictEqual(leaked.length, 0, `expected no unhandled rejection, got ${leaked.length}`);
})();

await test("[bug 1] cancelled action must not cause an unhandled rejection when caller handles .data", async () => {
    const action = createAction(async () => {
        await delay(100);
        return "x";
    }).setConcurrency(1);
    action.invoke(); // occupy the slot
    const queued = action.invoke();
    queued.cancel("nope");
    await queued.data.catch(() => {});
    await delay(50);
    const leaked = getUnhandledRejections().filter((r) => (r.reason as Error)?.name === "CancellationError");
    assert.strictEqual(leaked.length, 0, `expected no unhandled rejection, got ${leaked.length}`);
})();

printSection("Bug 2: retries and rate limiting");

await test("[bug 2] retry attempts must count against the action's rate limit (2/s)", async () => {
    const starts: number[] = [];
    const action = createAction(async () => {
        starts.push(Date.now());
        throw new Error("always fails");
    })
        .setRetry({ maxRetries: 4, backoff: "linear", baseDelay: 1 })
        .setRateLimit(2);
    await action.invoke().data.catch(() => {});
    assert.strictEqual(starts.length, 5, "should still make 5 attempts");
    const m = maxInWindow(starts);
    assert.ok(m <= 2, `max attempts in a 1s window was ${m}, expected <= 2`);
})();

printSection("Bug 3: retry back-off and concurrency slot (design decision: assumes slot is released)");

await test("[bug 3] other invocations can run while one is backing off before a retry (concurrency 1)", async () => {
    const order: string[] = [];
    let failedOnce = false;
    const action = createAction(async (tag: string) => {
        if (tag === "A" && !failedOnce) {
            failedOnce = true;
            throw new Error("fail once");
        }
        order.push(tag);
        return tag;
    })
        .setRetry({ maxRetries: 1, backoff: "linear", baseDelay: 200 })
        .setConcurrency(1);
    const a = action.invoke("A").data;
    const b = action.invoke("B").data;
    await Promise.all([a, b]);
    assert.deepStrictEqual(order, ["B", "A"], `expected B to run during A's back-off, got ${order.join(",")}`);
})();

printSection("Retry slot accounting (guards the bug 2/3 fix)");

await test("[retry] concurrency cap is never exceeded while many invocations retry, and counters return to 0", async () => {
    let cur = 0;
    let max = 0;
    const attempts = new Map<number, number>();
    const action = createAction(async (n: number) => {
        cur++;
        max = Math.max(max, cur);
        try {
            await delay(5);
            const a = (attempts.get(n) ?? 0) + 1;
            attempts.set(n, a);
            if (a < 3) throw new Error("retry me");
            return n;
        } finally {
            cur--;
        }
    })
        .setConcurrency(3)
        .setRetry({ maxRetries: 3, backoff: "linear", baseDelay: 5 });
    const results = await action.invokeAll(Array.from({ length: 15 }, (_, i) => [i] as [number]));
    assert.ok(results.every((r: any) => r.data !== undefined), "all invocations should eventually succeed");
    assert.ok(max <= 3, `max concurrent handlers was ${max}, expected <= 3`);
    await delay(20);
    assert.strictEqual(action.getActiveCount(), 0, "active count must return to 0");
    assert.strictEqual(action.getQueueLength(), 0, "queue must be empty");
})();

await test("[retry] cancelling during back-off releases accounting and lets queued work proceed", async () => {
    const action = createAction(async (tag: string) => {
        if (tag === "fail") throw new Error("f");
        return tag;
    })
        .setRetry({ maxRetries: 3, backoff: "linear", baseDelay: 200 })
        .setConcurrency(1);
    const a = action.invoke("fail");
    await delay(30); // attempt 1 failed, now backing off
    const b = action.invoke("ok");
    a.cancel("stop");
    const [ra, rb] = await Promise.all([a.data.then(() => "ok", (e) => e.name), b.data]);
    assert.strictEqual(ra, "CancellationError");
    assert.strictEqual(rb, "ok");
    await delay(20);
    assert.strictEqual(action.getActiveCount(), 0);
})();

await test("[retry] graceful shutdown waits for an invocation that is in retry back-off", async () => {
    let n = 0;
    const s = new ExecutionScheduler(1);
    const p = s.schedule("r", async () => {
        await s.suspend("r", () => delay(30));
        n++;
        return "done";
    });
    await delay(5);
    await s.shutdown({ mode: "graceful", timeout: 2000 });
    assert.strictEqual(await p.promise, "done");
    assert.strictEqual(n, 1);
})();

printSection("Bug 4: limit validation");

for (const bad of [0, -1, NaN]) {
    await test(`[bug 4] setConcurrency(${bad}) should throw`, async () => {
        const s = new ExecutionScheduler();
        assert.throws(() => s.setConcurrency(bad));
    })();
    await test(`[bug 4] new ExecutionScheduler(${bad}) should throw`, async () => {
        assert.throws(() => new ExecutionScheduler(bad));
    })();
    await test(`[bug 4] setRateLimit(${bad}) should throw`, async () => {
        const s = new ExecutionScheduler();
        assert.throws(() => s.setRateLimit(bad));
    })();
}

await test("[bug 4] createAction().setConcurrency(0) should throw instead of hanging forever", async () => {
    assert.throws(() => createAction(async () => 1).setConcurrency(0));
})();

printSection("Bug 5: shutdown");

await test("[bug 5] schedule() after shutdown() should reject, not run", async () => {
    const s = new ExecutionScheduler(1);
    await s.shutdown({ mode: "immediate" });
    let ran = false;
    const outcome = await s
        .schedule(async () => {
            ran = true;
            return "ran";
        })
        .then(
            () => "resolved",
            () => "rejected"
        );
    assert.strictEqual(ran, false, "task must not execute after shutdown");
    assert.strictEqual(outcome, "rejected");
})();

await test("[bug 5] graceful shutdown must not leave its timeout timer alive after tasks finish", async () => {
    await delay(20); // let earlier tests' timers settle
    const before = timeoutResourceCount();
    const s = new ExecutionScheduler(1);
    s.schedule(async () => {
        await delay(10);
    });
    await delay(1);
    await s.shutdown({ mode: "graceful", timeout: 5000 });
    await delay(20);
    const after = timeoutResourceCount();
    assert.ok(after <= before, `leaked ${after - before} Timeout handle(s) (5s shutdown timer still pending)`);
})();

printSection("Bug 7: timeout timer leak");

await test("[bug 7] setTimeout() must clear its timer when the handler finishes first", async () => {
    await delay(50);
    const before = timeoutResourceCount();
    await createAction(async () => 1).setTimeout(5000).invoke().data;
    await delay(30);
    const after = timeoutResourceCount();
    assert.ok(after <= before, `leaked ${after - before} Timeout handle(s); a 5s timer keeps the process alive`);
})();

await test("[bug 7] setTimeout() timer is also cleared when the handler throws", async () => {
    await delay(50);
    const before = timeoutResourceCount();
    await createAction(async () => {
        throw new Error("x");
    })
        .setTimeout(5000)
        .invoke()
        .data.catch(() => {});
    await delay(30);
    const after = timeoutResourceCount();
    assert.ok(after <= before, `leaked ${after - before} Timeout handle(s)`);
})();

printSection("Bug 8: onEvent callback errors must be isolated (README)");

await test("[bug 8] throwing onEvent must not cause an unhandled rejection when caller ignores eventLogged", async () => {
    const marker = `cb-${Math.random()}`;
    const origErr = console.error;
    console.error = () => {};
    try {
        const action = createAction(async () => "ok").onEvent(() => {
            throw new Error(marker);
        });
        await action.invoke().data;
        await delay(50);
    } finally {
        console.error = origErr;
    }
    const leaked = getUnhandledRejections().filter((r) => (r.reason as Error)?.message === marker);
    assert.strictEqual(leaked.length, 0, "eventLogged rejection leaked as an unhandled rejection");
})();

await test("[bug 8] eventLogged still rejects with the callback error for callers who await it (documented API)", async () => {
    const origErr = console.error;
    console.error = () => {};
    let outcome: string;
    try {
        const h = createAction(async () => "ok")
            .onEvent(() => {
                throw new Error("cb");
            })
            .invoke();
        await h.data;
        outcome = await h.eventLogged.then(
            () => "resolved",
            () => "rejected"
        );
    } finally {
        console.error = origErr;
    }
    assert.strictEqual(outcome, "rejected");
})();

printSection("Bug 9: childDuration with parallel children");

await test("[bug 9] childDuration must not exceed the parent's wall-clock duration for parallel children", async () => {
    const events: any[] = [];
    const child = createAction(async () => {
        await delay(50);
    }).setConcurrency(5);
    const parent = createAction(async () => {
        await Promise.all([child.invoke().data, child.invoke().data, child.invoke().data]);
    }).onEvent((e) => {
        events.push(e);
    });
    const h = parent.invoke();
    await h.data;
    await h.eventLogged;
    const e = events[0];
    assert.ok(
        e.childDuration <= e.duration + 5,
        `childDuration=${e.childDuration} > duration=${e.duration} (summed instead of union of intervals)`
    );
})();

// Only print/exit when run directly (npm run test:regressions); run-all prints its own summary.
if (process.argv[1]?.endsWith("regressions.test.ts")) {
    printSummary();
}

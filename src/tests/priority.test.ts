import { ExecutionScheduler, createAction } from "../index.js";
import { assert, test, delay, printSection } from "./helpers.js";

async function runTests() {
    console.log("\n🧪 Running Priority Queue Tests\n");

    printSection("Scheduler Priority Ordering");

    await test("should execute higher priority first when queued", async () => {
        const scheduler = new ExecutionScheduler(1, Infinity);
        const order: string[] = [];

        const low = scheduler.schedule(
            "low",
            async () => {
                order.push("low");
                await delay(5);
                return "low";
            },
            { priority: 0 }
        ).promise;

        const normal = scheduler.schedule(
            "normal",
            async () => {
                order.push("normal");
                await delay(5);
                return "normal";
            },
            { priority: 50 }
        ).promise;

        const high = scheduler.schedule(
            "high",
            async () => {
                order.push("high");
                await delay(5);
                return "high";
            },
            { priority: 100 }
        ).promise;

        const results = await Promise.all([low, normal, high]);

        // The promises resolve in submission order, but execution should be priority-ordered.
        assert.deepStrictEqual(results, ["low", "normal", "high"]);
        assert.deepStrictEqual(order, ["high", "normal", "low"]);
    })();

    await test("should preserve FIFO ordering within the same priority", async () => {
        const scheduler = new ExecutionScheduler(1, Infinity);
        const order: number[] = [];

        const a = scheduler.schedule(
            "a",
            async () => {
                order.push(1);
                await delay(2);
                return 1;
            },
            { priority: 75 }
        ).promise;

        const b = scheduler.schedule(
            "b",
            async () => {
                order.push(2);
                await delay(2);
                return 2;
            },
            { priority: 75 }
        ).promise;

        const c = scheduler.schedule(
            "c",
            async () => {
                order.push(3);
                await delay(2);
                return 3;
            },
            { priority: 75 }
        ).promise;

        await Promise.all([a, b, c]);
        assert.deepStrictEqual(order, [1, 2, 3]);
    })();

    await test("should validate priority range", async () => {
        const scheduler = new ExecutionScheduler(1, Infinity);

        assert.throws(() => {
            scheduler.schedule(() => 1, { priority: 101 });
        }, /priority must be in range \[0, 100\]/);

        assert.throws(() => {
            scheduler.schedule(() => 1, { priority: -1 });
        }, /priority must be in range \[0, 100\]/);
    })();

    printSection("Action-Level Overrides");

    await test("should not preempt running tasks, but reorder queued tasks", async () => {
        let release: () => void;
        const blocker = new Promise<void>((resolve) => {
            release = resolve;
        });

        const started: string[] = [];

        const action = createAction(async (label: string, shouldHold: boolean) => {
            started.push(label);
            if (shouldHold) {
                await blocker;
            }
            return label;
        })
            .setConcurrency(1)
            .setPriority("normal");

        const a = action.invoke("A", true);

        // Ensure A starts before enqueueing others.
        await Promise.resolve();

        const b = action.invoke("B", false, { priority: "low" });
        const c = action.invoke("C", false, { priority: "high" });

        // Allow B and C to be enqueued behind A.
        await delay(5);
        release!();

        await Promise.all([a.data, b.data, c.data]);
        assert.deepStrictEqual(started, ["A", "C", "B"]);
    })();

    await test("should include priority and metadata in wide events", async () => {
        const events: any[] = [];

        const action = createAction(async (n: number) => n * 2)
            .setConcurrency(1)
            .setPriority("low")
            .onEvent((event) => {
                events.push(event);
            });

        const handle = action.invoke(2, { priority: "critical", metadata: { feature: "priority" } });
        await handle.data;
        await handle.eventLogged;

        assert.strictEqual(events.length, 1);
        assert.strictEqual(events[0].priority, 100);
        assert.deepStrictEqual(events[0].metadata, { feature: "priority" });
    })();
}

runTests().catch((error) => {
    console.error("Priority queue tests failed:", error);
    process.exit(1);
});

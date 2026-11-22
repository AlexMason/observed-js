import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { format, inspect } from "node:util";
import v8 from "node:v8";
import vm from "node:vm";
import { test, assert, printSection } from "./helpers.js";
import { createAction, setConsoleCapture, withContext } from "../index.js";
import type { WideEvent } from "../index.js";

type AnyEvent = WideEvent<any[], any>;

/** Run fn with stdout/stderr redirected into a string (silences captured output too). */
async function withOutput<T>(fn: () => Promise<T>): Promise<{ result: T; output: string }> {
    const stdoutWrite = process.stdout.write;
    const stderrWrite = process.stderr.write;
    let output = "";
    const sink = ((chunk: unknown) => {
        output += String(chunk);
        return true;
    }) as typeof process.stdout.write;
    process.stdout.write = sink;
    process.stderr.write = sink;
    try {
        const result = await fn();
        return { result, output };
    } finally {
        process.stdout.write = stdoutWrite;
        process.stderr.write = stderrWrite;
    }
}

const messages = (event: AnyEvent | undefined) => event?.logs?.map((entry) => entry.message);
const occurrences = (text: string, needle: string) => text.split(needle).length - 1;

/** Returns an arrive() function whose promise resolves once `count` callers have arrived. */
function barrier(count: number): () => Promise<void> {
    let arrived = 0;
    let release!: () => void;
    const all = new Promise<void>((resolve) => { release = resolve; });
    return () => {
        if (++arrived === count) release();
        return all;
    };
}

/** A one-shot signal. */
function latch(): { open: () => void; opened: Promise<void> } {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => { open = resolve; });
    return { open, opened };
}

printSection("Console Capture: configuration");

const invalidOptions = [
    { maxEntries: -1 },
    { maxEntries: 1.5 },
    { maxMessageLength: 0 }
];

await test("setConsoleCapture rejects invalid limits", () => {
    try {
        for (const options of invalidOptions) {
            assert.throws(() => setConsoleCapture(options), /must be an integer/);
        }
    } finally {
        setConsoleCapture();
    }
})();

await test("captureConsole rejects invalid limits", () => {
    for (const options of invalidOptions) {
        assert.throws(() => createAction(async () => 1).captureConsole(options), /must be an integer/);
    }
})();

printSection("Console Capture: recording");

await test("captures every level by default with formatted, frozen entries", async () => {
    const events: AnyEvent[] = [];
    const action = createAction(async (name: string) => {
        console.log("log %s", name);
        console.info("info %d", 42);
        console.warn("warn", { a: 1 });
        console.error("error");
        console.debug("debug");
        console.trace("trace");
        return name;
    }).onEvent((e) => { events.push(e); });

    await withOutput(async () => {
        await action.invoke("x").eventLogged;
    });

    const event = events[0]!;
    assert.deepStrictEqual(event.logs!.map((l) => l.level), ["log", "info", "warn", "error", "debug", "trace"]);
    assert.deepStrictEqual(messages(event), [
        "log x", "info 42", format("warn", { a: 1 }), "error", "debug", "trace"
    ]);
    for (const entry of event.logs!) {
        assert.ok(entry.timestamp >= event.startedAt && entry.timestamp <= event.completedAt);
        assert.strictEqual(entry.attempt, 0);
        assert.strictEqual(entry.actionId, event.actionId);
        assert.ok(Object.isFrozen(entry));
    }
    assert.strictEqual("logsDropped" in event, false);
})();

await test("delegating console methods record under the level they call; dir records nothing", async () => {
    const events: AnyEvent[] = [];
    const action = createAction(async () => {
        console.table([{ a: 1 }]);
        console.count("hits");
        console.assert(false, "nope");
        console.dir({ d: 1 });
    }).onEvent((e) => { events.push(e); });

    await withOutput(async () => {
        await action.invoke().eventLogged;
    });

    const logs = events[0]!.logs!;
    assert.deepStrictEqual(logs.map((l) => l.level), ["log", "log", "warn"]);
    assert.ok(logs[0]!.message.includes("┌"));
    assert.strictEqual(logs[1]!.message, "hits: 1");
    assert.ok(logs[2]!.message.includes("nope"));
})();

await test("importing does not patch console; the first capturing invocation does", async () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const tsx = path.resolve(here, "../../node_modules/.bin/tsx");
    const run = spawnSync(tsx, [path.join(here, "fixtures/console-capture-lazy.ts")], { encoding: "utf8", timeout: 60_000 });
    assert.strictEqual(run.status, 0, run.stderr);
    assert.deepStrictEqual(JSON.parse(run.stdout), {
        afterImport: true,
        afterOptedOutInvoke: true,
        afterCapturingInvoke: false
    });
})();

await test("global and per-action opt-out", async () => {
    const events: Record<string, AnyEvent> = {};
    const make = (key: string) => createAction(async () => {
        console.log(`msg-${key}`);
    }).onEvent((e) => { events[key] = e; });

    try {
        const { output } = await withOutput(async () => {
            setConsoleCapture(false);
            await make("globalOff").invoke().eventLogged;
            await make("actionOn").captureConsole().invoke().eventLogged;
            setConsoleCapture();
            await make("restored").invoke().eventLogged;
            await make("actionOff").captureConsole(false).invoke().eventLogged;
        });
        assert.strictEqual("logs" in events.globalOff!, false);
        assert.ok(output.includes("msg-globalOff"));
        assert.deepStrictEqual(messages(events.actionOn), ["msg-actionOn"]);
        assert.deepStrictEqual(messages(events.restored), ["msg-restored"]);
        assert.strictEqual("logs" in events.actionOff!, false);
        assert.ok(output.includes("msg-actionOff"));
    } finally {
        setConsoleCapture();
    }
})();

await test("concurrent invocations keep their own logs", async () => {
    const events: AnyEvent[] = [];
    const rounds = [barrier(2), barrier(2)];
    const action = createAction(async (id: string) => {
        for (let i = 0; i < 3; i++) {
            console.log(`${id}-${i}`);
            if (i < 2) await rounds[i]!();
        }
    }).setConcurrency(2).onEvent((e) => { events.push(e); });

    await withOutput(async () => {
        await Promise.all([action.invoke("a").eventLogged, action.invoke("b").eventLogged]);
    });

    const byId = new Map(events.map((e) => [e.input[0], e]));
    assert.deepStrictEqual(messages(byId.get("a")), ["a-0", "a-1", "a-2"]);
    assert.deepStrictEqual(messages(byId.get("b")), ["b-0", "b-1", "b-2"]);
})();

await test("passthrough prints by default and can be turned off", async () => {
    const shown = createAction(async () => { console.log("shown-msg"); });
    const hidden = createAction(async () => { console.log("hidden-msg"); }).captureConsole({ passthrough: false });

    const { output } = await withOutput(async () => {
        await shown.invoke().data;
        await hidden.invoke().data;
        console.log("outside-msg");
    });

    assert.ok(output.includes("shown-msg"));
    assert.ok(!output.includes("hidden-msg"));
    assert.ok(output.includes("outside-msg"));
})();

await test("maxEntries drops extras into logsDropped; maxMessageLength truncates", async () => {
    const events: AnyEvent[] = [];
    const chatty = createAction(async () => {
        for (let i = 0; i < 5; i++) console.log(`m${i}`);
    }).captureConsole({ maxEntries: 2 }).onEvent((e) => { events.push(e); });
    const long = createAction(async () => {
        console.log("abcdefghij");
    }).captureConsole({ maxMessageLength: 5 }).onEvent((e) => { events.push(e); });

    await withOutput(async () => {
        await chatty.invoke().eventLogged;
        await long.invoke().eventLogged;
    });

    assert.deepStrictEqual(messages(events[0]), ["m0", "m1"]);
    assert.strictEqual(events[0]!.logsDropped, 3);
    assert.strictEqual(events[1]!.logs![0]!.message, "abcde");
    assert.strictEqual(events[1]!.logs![0]!.truncated, true);
})();

await test("calls past the limit are counted without being formatted", async () => {
    const events: AnyEvent[] = [];
    let formatted = 0;
    const probe = { [inspect.custom]: () => { formatted++; return "probe"; } };
    const none = createAction(async () => {
        for (let i = 0; i < 3; i++) console.log(probe);
    }).captureConsole({ maxEntries: 0, passthrough: false }).onEvent((e) => { events.push(e); });
    const one = createAction(async () => {
        for (let i = 0; i < 3; i++) console.log(probe);
    }).captureConsole({ maxEntries: 1, passthrough: false }).onEvent((e) => { events.push(e); });

    await none.invoke().eventLogged;
    assert.strictEqual(formatted, 0);
    assert.deepStrictEqual(events[0]!.logs, []);
    assert.strictEqual(events[0]!.logsDropped, 3);

    await one.invoke().eventLogged;
    assert.strictEqual(formatted, 1);
    assert.deepStrictEqual(messages(events[1]), ["probe"]);
    assert.strictEqual(events[1]!.logsDropped, 2);
})();

await test("retry events carry cumulative, attempt-tagged logs", async () => {
    const events: AnyEvent[] = [];
    let attempt = 0;
    const action = createAction(async () => {
        console.log(`a${attempt}`);
        if (attempt++ === 0) throw new Error("first attempt fails");
        return "ok";
    }).setRetry({ maxRetries: 1, baseDelay: 0 }).onEvent((e) => { events.push(e); });

    await withOutput(async () => {
        await action.invoke().eventLogged;
    });

    const intermediate = events.find((e) => e.willRetry)!;
    const final = events.find((e) => !e.error)!;
    assert.deepStrictEqual(intermediate.logs!.map((l) => [l.message, l.attempt]), [["a0", 0]]);
    assert.deepStrictEqual(final.logs!.map((l) => [l.message, l.attempt]), [["a0", 0], ["a1", 1]]);
})();

printSection("Console Capture: nesting");

await test("child logs are copied into the parent in call order", async () => {
    const childEvents: AnyEvent[] = [];
    const parentEvents: AnyEvent[] = [];
    const child = createAction(async () => { console.log("c"); }).onEvent((e) => { childEvents.push(e); });
    const parent = createAction(async () => {
        console.log("p1");
        await child.invoke().data;
        console.log("p2");
    }).onEvent((e) => { parentEvents.push(e); });

    await withOutput(async () => {
        await parent.invoke().eventLogged;
    });

    const parentEvent = parentEvents[0]!;
    const childEvent = childEvents[0]!;
    assert.deepStrictEqual(messages(parentEvent), ["p1", "c", "p2"]);
    assert.strictEqual(parentEvent.logs![1]!.actionId, childEvent.actionId);
    assert.deepStrictEqual(messages(childEvent), ["c"]);
    assert.deepStrictEqual(messages(parentEvent.children![0]), ["c"]);
})();

await test("grandchild logs reach every ancestor with the grandchild's actionId", async () => {
    const events = new Map<string, AnyEvent>();
    const record = (name: string) => (e: AnyEvent) => { events.set(name, e); };
    const grandchild = createAction(async () => { console.log("g"); }).onEvent(record("g"));
    const child = createAction(async () => { await grandchild.invoke().data; }).onEvent(record("c"));
    const root = createAction(async () => { await child.invoke().data; }).onEvent(record("r"));

    await withOutput(async () => {
        await root.invoke().eventLogged;
    });

    const gId = events.get("g")!.actionId;
    for (const name of ["g", "c", "r"]) {
        assert.deepStrictEqual(events.get(name)!.logs!.map((l) => [l.message, l.actionId]), [["g", gId]]);
    }
})();

await test("concurrent invokeAll children are all copied with their own actionIds", async () => {
    const childEvents: AnyEvent[] = [];
    const parentEvents: AnyEvent[] = [];
    const allStarted = barrier(3);
    const child = createAction(async (id: string) => {
        console.log(`${id}-start`);
        await allStarted();
        console.log(`${id}-end`);
    }).setConcurrency(3).onEvent((e) => { childEvents.push(e); });
    const parent = createAction(async () => {
        await child.invokeAll([["x"], ["y"], ["z"]]);
    }).onEvent((e) => { parentEvents.push(e); });

    await withOutput(async () => {
        await parent.invoke().eventLogged;
    });

    const parentLogs = parentEvents[0]!.logs!;
    assert.strictEqual(parentLogs.length, 6);
    for (const childEvent of childEvents) {
        const id = childEvent.input[0];
        assert.deepStrictEqual(messages(childEvent), [`${id}-start`, `${id}-end`]);
        assert.deepStrictEqual(
            parentLogs.filter((l) => l.actionId === childEvent.actionId).map((l) => l.message),
            [`${id}-start`, `${id}-end`]
        );
    }
})();

await test("an opted-out child has no logs but is still copied into the parent", async () => {
    const childEvents: AnyEvent[] = [];
    const parentEvents: AnyEvent[] = [];
    const child = createAction(async () => { console.log("quiet-child"); })
        .captureConsole(false)
        .onEvent((e) => { childEvents.push(e); });
    const parent = createAction(async () => { await child.invoke().data; }).onEvent((e) => { parentEvents.push(e); });

    await withOutput(async () => {
        await parent.invoke().eventLogged;
    });

    assert.strictEqual("logs" in childEvents[0]!, false);
    assert.deepStrictEqual(parentEvents[0]!.logs!.map((l) => [l.message, l.actionId]), [["quiet-child", childEvents[0]!.actionId]]);
})();

await test("with global capture off, capture is inherited from a capturing parent only", async () => {
    const events = new Map<string, AnyEvent>();
    const record = (name: string) => (e: AnyEvent) => { events.set(name, e); };
    try {
        await withOutput(async () => {
            setConsoleCapture(false);
            const inheritingChild = createAction(async () => { console.log("inherit"); }).onEvent(record("inheritingChild"));
            const capturingParent = createAction(async () => { await inheritingChild.invoke().data; })
                .captureConsole()
                .onEvent(record("capturingParent"));
            await capturingParent.invoke().eventLogged;

            const capturingChild = createAction(async () => { console.log("own"); })
                .captureConsole()
                .onEvent(record("capturingChild"));
            const plainParent = createAction(async () => { await capturingChild.invoke().data; }).onEvent(record("plainParent"));
            await plainParent.invoke().eventLogged;
        });
    } finally {
        setConsoleCapture();
    }

    assert.deepStrictEqual(messages(events.get("inheritingChild")), ["inherit"]);
    assert.deepStrictEqual(messages(events.get("capturingParent")), ["inherit"]);
    assert.deepStrictEqual(messages(events.get("capturingChild")), ["own"]);
    assert.strictEqual("logs" in events.get("plainParent")!, false);
})();

await test("maxEntries is a per-source limit inside each event", async () => {
    const events = new Map<string, AnyEvent>();
    const record = (name: string) => (e: AnyEvent) => { events.set(name, e); };
    const logThree = (prefix: string) => async () => {
        for (let i = 0; i < 3; i++) console.log(`${prefix}${i}`);
    };
    const childA = createAction(logThree("a")).onEvent(record("a"));
    const childB = createAction(logThree("b")).captureConsole({ maxEntries: 5 }).onEvent(record("b"));
    const parent = createAction(async () => {
        await logThree("p")();
        await childA.invoke().data;
        await childB.invoke().data;
    }).captureConsole({ maxEntries: 2 }).onEvent(record("p"));

    await withOutput(async () => {
        await parent.invoke().eventLogged;
    });

    assert.deepStrictEqual(messages(events.get("a")), ["a0", "a1"]);
    assert.strictEqual(events.get("a")!.logsDropped, 1);
    assert.deepStrictEqual(messages(events.get("b")), ["b0", "b1", "b2"]);
    assert.deepStrictEqual(messages(events.get("p")), ["p0", "p1", "a0", "a1", "b0", "b1"]);
    assert.strictEqual(events.get("p")!.logsDropped, 3);
})();

await test("truncated entries do not keep the oversized message alive", async () => {
    v8.setFlagsFromString("--expose-gc");
    const gc = vm.runInNewContext("gc") as () => void;
    const events: AnyEvent[] = [];
    const action = createAction(async (i: number) => {
        console.log(`${i}`.repeat(4_000_000));
    }).captureConsole({ passthrough: false, maxMessageLength: 64 }).onEvent((e) => { events.push(e); });

    gc();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < 5; i++) await action.invoke(i).eventLogged;
    gc();
    const retained = process.memoryUsage().heapUsed - before;

    assert.strictEqual(events.length, 5);
    assert.ok(retained < 4_000_000, `retained ${retained} bytes after 5 truncated 4MB messages`);
})();

await test("messages are truncated once, at the source's maxMessageLength", async () => {
    const parentEvents: AnyEvent[] = [];
    const child = createAction(async () => { console.log("x".repeat(20)); }).captureConsole({ maxMessageLength: 100 });
    const parent = createAction(async () => { await child.invoke().data; })
        .captureConsole({ maxMessageLength: 5 })
        .onEvent((e) => { parentEvents.push(e); });

    await withOutput(async () => {
        await parent.invoke().eventLogged;
    });

    const entry = parentEvents[0]!.logs![0]!;
    assert.strictEqual(entry.message.length, 20);
    assert.strictEqual("truncated" in entry, false);
})();

await test("a late child call lands on the still-running parent, not the sealed child", async () => {
    const childEvents: AnyEvent[] = [];
    const parentEvents: AnyEvent[] = [];
    const releaseChild = latch();
    const lateLogged = latch();
    // The 20ms forced timeout is the library behavior under test, so it runs on the real clock.
    // The child is released only after its rejection (and therefore its seal) reached the parent.
    const child = createAction(async () => {
        await releaseChild.opened;
        console.log("late-call");
        lateLogged.open();
    }).setTimeout(20).onEvent((e) => { childEvents.push(e); });
    const parent = createAction(async () => {
        await child.invoke().data.catch(() => undefined);
        releaseChild.open();
        await lateLogged.opened;
    }).onEvent((e) => { parentEvents.push(e); });

    const { output } = await withOutput(async () => {
        await parent.invoke().eventLogged;
    });

    assert.ok(childEvents[0]!.timedOut);
    assert.deepStrictEqual(messages(childEvents[0]), []);
    assert.deepStrictEqual(parentEvents[0]!.logs!.map((l) => [l.message, l.actionId]), [["late-call", childEvents[0]!.actionId]]);
    assert.ok(output.includes("late-call"));
})();

await test("printing follows the source invocation's passthrough", async () => {
    const child = createAction(async () => { console.log("child-msg"); }).captureConsole({ passthrough: true });
    const parent = createAction(async () => {
        console.log("parent-msg");
        await child.invoke().data;
    }).captureConsole({ passthrough: false });

    const { output } = await withOutput(async () => {
        await parent.invoke().eventLogged;
    });

    assert.strictEqual(occurrences(output, "child-msg"), 1);
    assert.strictEqual(occurrences(output, "parent-msg"), 0);
})();

await test("root invokeAll and invokeStream items keep their own logs", async () => {
    const events: AnyEvent[] = [];
    const action = createAction(async (id: string) => {
        console.log(`item-${id}`);
    }).setConcurrency(3).onEvent((e) => { events.push(e); });

    await withOutput(async () => {
        await action.invokeAll([["1"], ["2"]]);
        for await (const _ of action.invokeStream([["3"], ["4"]])) { /* drain */ }
    });

    assert.strictEqual(events.length, 4);
    for (const event of events) {
        assert.deepStrictEqual(messages(event), [`item-${event.input[0]}`]);
    }
})();

await test("a cancelled invocation's event keeps logs made before the cancel", async () => {
    const events: AnyEvent[] = [];
    const started = latch();
    const action = createAction(async () => {
        console.log("before-cancel");
        started.open();
        await new Promise<never>(() => {});
    }).onEvent((e) => { events.push(e); });

    await withOutput(async () => {
        const handle = action.invoke();
        await started.opened;
        handle.cancel("stop");
        await handle.eventLogged;
    });

    // A cancel while running emits the failed-attempt event first, then the cancellation event.
    const cancelled = events.find((e) => e.cancelled)!;
    assert.ok(cancelled);
    assert.deepStrictEqual(messages(cancelled), ["before-cancel"]);
})();

printSection("Console Capture: lifecycle callbacks");

await test("progress, warning, shouldRetry and intermediate onEvent output land on the owning invocation", async () => {
    const events: AnyEvent[] = [];
    let attempt = 0;
    const action = createAction(withContext(async (ctx) => {
        if (attempt++ === 0) {
            ctx.setTotal(1);
            ctx.incrementProgress();
            ctx.attach("payload", "more than one byte");
            throw new Error("retry me");
        }
        return "ok";
    }))
        .setRetry({
            maxRetries: 1,
            baseDelay: 0,
            shouldRetry: () => {
                console.log("should-retry");
                return true;
            }
        })
        .setContextWarningThreshold({ maxAttachmentBytes: 1, onWarning: () => console.log("warning-cb") })
        .onProgress((p) => console.log(`progress-${p.percentage}`), { throttle: 0 })
        .onEvent((e) => {
            if (e.willRetry) console.log("intermediate-on-event");
            events.push(e);
        });

    await withOutput(async () => {
        await action.invoke().eventLogged;
    });

    const final = events.find((e) => !e.error)!;
    assert.deepStrictEqual(messages(final), [
        "progress-0", "progress-100", "warning-cb", "should-retry", "intermediate-on-event"
    ]);
    assert.ok(final.logs!.every((l) => l.actionId === final.actionId && l.attempt === 0));
})();

await test("a child's final onEvent output lands on the parent with the child's actionId", async () => {
    for (const mode of ["invoke", "invokeAll"] as const) {
        const childEvents: AnyEvent[] = [];
        const parentEvents: AnyEvent[] = [];
        const child = createAction(async () => "done").onEvent((e) => {
            console.log("child-final-cb");
            childEvents.push(e);
        });
        const parent = createAction(async () => {
            if (mode === "invoke") await child.invoke().eventLogged;
            else await child.invokeAll([[]]);
        }).onEvent((e) => { parentEvents.push(e); });

        await withOutput(async () => {
            await parent.invoke().eventLogged;
        });

        assert.deepStrictEqual(messages(childEvents[0]), [], mode);
        assert.deepStrictEqual(
            parentEvents[0]!.logs!.map((l) => [l.message, l.actionId]),
            [["child-final-cb", childEvents[0]!.actionId]],
            mode
        );
    }
})();

await test("a root's final onEvent output prints and is captured nowhere", async () => {
    const events: AnyEvent[] = [];
    const action = createAction(async () => "done").onEvent((e) => {
        console.log("root-final-cb");
        events.push(e);
    });

    const { output } = await withOutput(async () => {
        await action.invoke().eventLogged;
    });

    assert.ok(output.includes("root-final-cb"));
    assert.deepStrictEqual(messages(events[0]), []);
})();

await test("batch progress output belongs to the caller's invocation", async () => {
    const parentEvents: AnyEvent[] = [];
    const child = createAction(async () => "done").onProgress((p) => console.log(`batch-${p.percentage}`), { throttle: 0 });
    const parent = createAction(async () => {
        await child.invokeAll([[], []]);
    }).onEvent((e) => { parentEvents.push(e); });

    await withOutput(async () => {
        await parent.invoke().eventLogged;
    });

    const parentEvent = parentEvents[0]!;
    const batchLogs = parentEvent.logs!.filter((l) => l.message.startsWith("batch-"));
    assert.deepStrictEqual(batchLogs.map((l) => l.message), ["batch-0", "batch-50", "batch-100"]);
    assert.ok(batchLogs.every((l) => l.actionId === parentEvent.actionId));
})();

await test("library diagnostics are not captured and still honor console.error stubs", async () => {
    const runOnce = async () => {
        const events: AnyEvent[] = [];
        let attempt = 0;
        const action = createAction(async () => {
            if (attempt++ === 0) throw new Error("retry me");
            return "ok";
        }).setRetry({ maxRetries: 1, baseDelay: 0 }).onEvent((e) => {
            events.push(e);
            if (e.willRetry) throw new Error("callback failure");
        });
        const { output } = await withOutput(async () => {
            await action.invoke().eventLogged;
        });
        return { final: events.find((e) => !e.error)!, output };
    };

    const printed = await runOnce();
    assert.ok(printed.output.includes("Error in event callback"));
    assert.ok(!messages(printed.final)!.some((m) => m.includes("Error in event callback")));

    const originalError = console.error;
    console.error = () => {};
    try {
        const stubbed = await runOnce();
        assert.ok(!stubbed.output.includes("Error in event callback"));
    } finally {
        console.error = originalError;
    }
})();

await test("an action invoked from a callback attributes its handler output to itself", async () => {
    const innerEvents: AnyEvent[] = [];
    const inner = createAction(async () => { console.log("inner-handler"); }).onEvent((e) => { innerEvents.push(e); });
    const outer = createAction(async () => "done").onEvent(async () => {
        await inner.invoke().eventLogged;
    });

    await withOutput(async () => {
        await outer.invoke().eventLogged;
    });

    assert.deepStrictEqual(innerEvents[0]!.logs!.map((l) => [l.message, l.actionId]), [["inner-handler", innerEvents[0]!.actionId]]);
})();

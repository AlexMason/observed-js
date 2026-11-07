/**
 * Bug 6: the master runner must actually count every suite.
 * Spawns run-all and checks per-suite counts. Kept OUT of run-all to avoid recursion.
 * EXPECTED TO FAIL until priority.test.ts is awaited by run-all.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { assert, test, printSection, printSummary } from "./helpers.js";

printSection("Bug 6: test infrastructure");

const here = path.dirname(fileURLToPath(import.meta.url));
const tsx = path.resolve(here, "../../node_modules/.bin/tsx");
const run = spawnSync(tsx, [path.join(here, "run-all.ts")], { encoding: "utf8", timeout: 120_000 });
const out = run.stdout + run.stderr;

await test("[bug 6] run-all reports a non-zero count for the Priority Queue suite", async () => {
    const m = out.match(/Priority Queue Tests\s+Passed: (\d+)/);
    assert.ok(m, "Priority Queue suite missing from summary");
    assert.ok(Number(m![1]) > 0, `Priority Queue suite counted ${m![1]} passed tests`);
})();

await test("[bug 6] every suite in run-all reports at least one test", async () => {
    const empty = [...out.matchAll(/[✓✗] (.+)\n\s+Passed: 0\n\s+Failed: 0/g)].map((m) => m[1]);
    assert.deepStrictEqual(empty, [], `suites with zero counted tests: ${empty.join(", ")}`);
})();

printSummary();

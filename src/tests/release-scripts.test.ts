import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, assert, printSection } from "./helpers.js";

printSection("Release scripts: npm-version-status.sh");

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, "../../.github/scripts/npm-version-status.sh");

/** A fake `npm` that only answers `npm view pkg@1.2.3 version`, in the mode given by FAKE_NPM_MODE. */
const fakeNpm = `#!/usr/bin/env bash
if [ "$1 $2 $3" != "view pkg@1.2.3 version" ]; then echo "fake npm: unexpected args: $*" >&2; exit 99; fi
case "$FAKE_NPM_MODE" in
  published) echo "npm warn config something harmless" >&2; echo "1.2.3" ;;
  missing) echo "npm error code E404" >&2; echo "npm error 404 No match found for version 1.2.3" >&2; exit 1 ;;
  unexpected) echo "1.2.3-beta" ;;
  network) echo "npm error code ECONNREFUSED" >&2; exit 1 ;;
esac
`;

const runWith = (mode: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-npm-"));
    try {
        writeFileSync(path.join(dir, "npm"), fakeNpm);
        chmodSync(path.join(dir, "npm"), 0o755);
        return spawnSync("bash", [script, "pkg", "1.2.3"], {
            encoding: "utf8",
            env: { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}`, FAKE_NPM_MODE: mode }
        });
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

await test("reports published when npm prints the version, ignoring stderr warnings", () => {
    const run = runWith("published");
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.stdout, "published\n");
})();

await test("reports unpublished on E404", () => {
    const run = runWith("missing");
    assert.strictEqual(run.status, 0, run.stderr);
    assert.strictEqual(run.stdout, "unpublished\n");
})();

await test("fails on unexpected npm view output", () => {
    const run = runWith("unexpected");
    assert.notStrictEqual(run.status, 0);
    assert.strictEqual(run.stdout, "");
    assert.match(run.stderr, /unexpected npm view output: 1\.2\.3-beta/);
})();

await test("fails closed on any other npm error", () => {
    const run = runWith("network");
    assert.notStrictEqual(run.status, 0);
    assert.strictEqual(run.stdout, "");
    assert.match(run.stderr, /ECONNREFUSED/);
})();

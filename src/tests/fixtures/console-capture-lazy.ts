/**
 * Spawned by console-capture.test.ts in a fresh process: reports whether
 * console.log is still the original function at each stage.
 */
import { createAction, setConsoleCapture } from "../../index.js";

const original = console.log;
const afterImport = console.log === original;

setConsoleCapture(false);
await createAction(async () => 1).invoke().data;
const afterOptedOutInvoke = console.log === original;

await createAction(async () => 1).captureConsole().invoke().data;
const afterCapturingInvoke = console.log === original;

process.stdout.write(JSON.stringify({ afterImport, afterOptedOutInvoke, afterCapturingInvoke }));

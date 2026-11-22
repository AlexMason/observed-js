import { test, assert, printSection } from "./helpers.js";
import { createAction, setConsoleCapture } from "../index.js";

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

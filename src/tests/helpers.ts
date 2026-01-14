import assert from "node:assert";

export { assert };

export let testsPassed = 0;
export let testsFailed = 0;

export function resetTestCounts() {
    testsPassed = 0;
    testsFailed = 0;
}

export function test(name: string, fn: () => void | Promise<void>) {
    return async () => {
        try {
            await fn();
            console.log(`✓ ${name}`);
            testsPassed++;
        } catch (error) {
            console.error(`✗ ${name}`);
            console.error(`  ${error}`);
            testsFailed++;
        }
    };
}

/** Helper to delay execution */
export const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export function printSummary() {
    console.log(`\n${"═".repeat(50)}`);
    console.log(`Tests passed: ${testsPassed}`);
    console.log(`Tests failed: ${testsFailed}`);
    console.log(`Total: ${testsPassed + testsFailed}`);
    console.log(`${"═".repeat(50)}\n`);

    if (testsFailed > 0) {
        process.exit(1);
    }
}

export function printSection(title: string) {
    console.log("\n" + "─".repeat(50));
    console.log(title);
    console.log("─".repeat(50));
}

import assert from "node:assert";

export { assert };

export let testsPassed = 0;
export let testsFailed = 0;

interface TestFailure {
    testName: string;
    error: unknown;
}

interface TestSuiteResult {
    suiteName: string;
    passed: number;
    failed: number;
    failures: TestFailure[];
}

let currentSuiteName = "";
let suiteResults: TestSuiteResult[] = [];
let currentSuiteFailures: TestFailure[] = [];

export function startTestSuite(name: string) {
    // Save previous suite if exists
    if (currentSuiteName) {
        suiteResults.push({
            suiteName: currentSuiteName,
            passed: testsPassed,
            failed: testsFailed,
            failures: currentSuiteFailures
        });
    }
    
    currentSuiteName = name;
    testsPassed = 0;
    testsFailed = 0;
    currentSuiteFailures = [];
}

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
            currentSuiteFailures.push({ testName: name, error });
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

export function printComprehensiveSummary() {
    // Save the current suite
    if (currentSuiteName) {
        suiteResults.push({
            suiteName: currentSuiteName,
            passed: testsPassed,
            failed: testsFailed,
            failures: currentSuiteFailures
        });
    }

    console.log("\n" + "═".repeat(70));
    console.log("                        TEST SUITE SUMMARY");
    console.log("═".repeat(70) + "\n");

    let totalPassed = 0;
    let totalFailed = 0;

    for (const suite of suiteResults) {
        const status = suite.failed === 0 ? "✓" : "✗";
        console.log(`${status} ${suite.suiteName}`);
        console.log(`  Passed: ${suite.passed}`);
        console.log(`  Failed: ${suite.failed}`);
        
        if (suite.failures.length > 0) {
            console.log(`  Failures:`);
            for (const failure of suite.failures) {
                console.log(`    - ${failure.testName}`);
                const errorMsg = failure.error instanceof Error 
                    ? failure.error.message 
                    : String(failure.error);
                console.log(`      ${errorMsg}`);
            }
        }
        console.log("");
        
        totalPassed += suite.passed;
        totalFailed += suite.failed;
    }

    console.log("═".repeat(70));
    console.log("TOTAL RESULTS:");
    console.log(`  Total Passed: ${totalPassed}`);
    console.log(`  Total Failed: ${totalFailed}`);
    console.log(`  Total Tests:  ${totalPassed + totalFailed}`);
    console.log("═".repeat(70) + "\n");

    if (totalFailed > 0) {
        process.exit(1);
    }
}

export function printSection(title: string) {
    console.log("\n" + "─".repeat(50));
    console.log(title);
    console.log("─".repeat(50));
}

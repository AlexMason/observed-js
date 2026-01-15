#!/usr/bin/env node
/**
 * Master test runner that executes all test suites and provides
 * a comprehensive summary at the end.
 */

import { startTestSuite, printComprehensiveSummary } from "./helpers.js";

console.log("🧪 Running All Test Suites\n");

// Helper to wait for all pending tests to complete
const waitForTests = () => new Promise(resolve => setTimeout(resolve, 10));

// Import and run each test suite sequentially
// The imports will execute the tests

startTestSuite("Action Builder Tests");
await import("./actions.test.js");
await waitForTests();

startTestSuite("Execution Scheduler Tests");
await import("./scheduler.test.js");
await waitForTests();

startTestSuite("Wide Event Tests");
await import("./wide-events.test.js");
await waitForTests();

startTestSuite("Retry Tests");
await import("./retry.test.js");
await waitForTests();

startTestSuite("Timeout Tests");
await import("./timeout.test.js");
await waitForTests();

startTestSuite("Progress Tracking Tests");
await import("./progress.test.js");
await waitForTests();

// Print the comprehensive summary
printComprehensiveSummary();

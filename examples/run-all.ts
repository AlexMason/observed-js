/**
 * Run all examples sequentially for validation
 */

import { spawn } from "child_process";
import { resolve as pathResolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const examples = [
  "01-basic-action.ts",
  "02-concurrency.ts",
  "03-rate-limiting.ts",
  "04-wide-events.ts",
  "05-batch-invocation.ts",
  "06-combining-features.ts",
  "07-real-world-scenarios.ts",
  "08-error-handling.ts",
  "09-retry-examples.ts",
];

console.log("🚀 Running all examples...\n");

async function runExample(file: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const filePath = pathResolve(__dirname, file);
    const child = spawn("npx", ["tsx", filePath], {
      stdio: "inherit",
      shell: true,
    });

    child.on("error", (error) => {
      console.error(`Failed to run example "${file}":`, error);
      resolvePromise(false);
    });
    child.on("close", (code: number | null) => {
      resolvePromise(code === 0);
    });
  });
}

async function main() {
  let passed = 0;
  let failed = 0;

  for (const example of examples) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`Running: ${example}`);
    console.log("=".repeat(60));

    const success = await runExample(example);

    if (success) {
      passed++;
      console.log(`✅ ${example} - PASSED\n`);
    } else {
      failed++;
      console.log(`❌ ${example} - FAILED\n`);
    }
  }

  console.log("\n" + "=".repeat(60));
  console.log("Summary:");
  console.log(`  Total: ${examples.length}`);
  console.log(`  Passed: ${passed}`);
  console.log(`  Failed: ${failed}`);
  console.log("=".repeat(60));

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch(console.error);

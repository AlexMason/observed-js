/**
 * Console Capture
 *
 * console.* calls made while an action runs are captured on its wide event (on by default).
 * Output from child invocations is copied into every capturing ancestor, tagged with the
 * actionId that produced it, so one root event shows the whole trace and can be filtered.
 */

import { createAction } from "../src/index.js";
import type { WideEvent } from "../src/index.js";

console.log("=== Console Capture ===\n");

const short = (id: string) => id.slice(0, 8);

// Example 1: one root event holds the whole trace
console.log("Example 1: One root event holds the whole trace");

const childEvents: WideEvent<[string], string>[] = [];

const fetchUser = createAction(async (userId: string) => {
    console.log(`fetching ${userId}`); // existing logging, unchanged
    return `user:${userId}`;
}).onEvent((event) => {
    // Lifecycle callback output is captured too. This is the child's final event,
    // so the line lands on the still-running parent, tagged with the child's actionId.
    // It still prints: the child's own event is sealed, so passthrough no longer applies.
    console.info(`fetched ${event.input[0]}`);
    childEvents.push(event);
});

const loadTeam = createAction(async (teamId: string) => {
    console.log(`loading team ${teamId}`);
    const members = await fetchUser.invokeAll(["ada", "linus"]);
    console.warn(`team ${teamId} loaded with ${members.length} members`);
    return members.length;
})
    // Keep the terminal quiet and read the logs from the event instead.
    // Children inherit this setting.
    .captureConsole({ passthrough: false })
    .onEvent((event) => {
        console.log(`  root ${short(event.actionId)} logs:`);
        for (const entry of event.logs ?? []) {
            console.log(`    [${short(entry.actionId)}] ${entry.level.padEnd(5)} ${entry.message}`);
        }

        const child = childEvents[0]!;
        console.log(`  filtered to child ${short(child.actionId)}:`);
        for (const entry of event.logs!.filter((e) => e.actionId === child.actionId)) {
            console.log(`    ${entry.level.padEnd(5)} ${entry.message}`);
        }
    });

let res1 = await loadTeam.invoke("core").event;




// Example 2: opting out
console.log("\nExample 2: Opting out per action");

const quiet = createAction(async () => {
    console.log("  printed as usual, not captured");
})
    .captureConsole(false) // setConsoleCapture(false) does this for every action
    .onEvent((event) => {
        console.log(`  event has logs: ${"logs" in event}`);
    });

await quiet.invoke().event;

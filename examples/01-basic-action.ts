import { createAction } from "../src/index.js";

/**
 * Basic Action Usage
 * 
 * This example demonstrates:
 * - Creating a simple action with createAction()
 * - Type inference from handler function
 * - Invoking an action and awaiting results
 */

console.log("=== Basic Action Usage ===\n");

// Create a simple action that fetches user data
const getUserData = createAction(async (userId: string) => {
    console.log(`Fetching data for user: ${userId}`);
    
    // Simulate async operation
    await new Promise(resolve => setTimeout(resolve, 100));
    
    return {
        id: userId,
        name: "John Doe",
        email: `${userId}@example.com`
    };
});

// Invoke the action
const { actionId, data } = getUserData.invoke("user123");
console.log(`Action ID: ${actionId}`);

const result = await data;
console.log(`Result:`, result);

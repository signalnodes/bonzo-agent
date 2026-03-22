/**
 * Interactive chat interface for the Bonzo Vault Keeper Agent.
 * Run: npm run chat
 *
 * Routes natural language queries through the LangChain agent
 * which has access to Hedera Agent Kit tools, Bonzo lending tools,
 * and custom strategy analysis tools.
 */

import * as readline from "readline";
import { validateEnv } from "./config/env.js";
import { createAgent } from "./agent/setup.js";

async function main() {
  validateEnv();

  console.log("Bonzo Vault Keeper Agent — Interactive Chat");
  console.log("============================================");
  console.log("Initializing agent...\n");

  const { agent, config: agentConfig } = await createAgent();

  console.log(`Model: ${agentConfig.modelName}`);
  console.log(`Tools loaded: ${agentConfig.toolCount}`);
  console.log('Type "quit" to exit.\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const conversationHistory: Array<{ role: string; content: string }> = [];

  const prompt = () => {
    rl.question("you> ", async (input) => {
      const trimmed = input.trim();
      if (!trimmed) {
        prompt();
        return;
      }

      if (trimmed.toLowerCase() === "quit" || trimmed.toLowerCase() === "exit") {
        console.log("Goodbye.");
        rl.close();
        return;
      }

      try {
        conversationHistory.push({ role: "user", content: trimmed });

        // Show a thinking indicator while the agent calls tools
        process.stdout.write("agent> thinking...");
        const thinkingStart = Date.now();

        const result = await agent.invoke(
          { messages: conversationHistory.map(m => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          }))},
        );

        // Clear the thinking line
        process.stdout.write("\r" + " ".repeat(40) + "\r");
        const elapsed = ((Date.now() - thinkingStart) / 1000).toFixed(1);

        const lastMessage = result.messages[result.messages.length - 1];
        const responseText = typeof lastMessage.content === "string"
          ? lastMessage.content
          : JSON.stringify(lastMessage.content);

        conversationHistory.push({ role: "assistant", content: responseText });
        console.log(`agent> ${responseText}`);
        console.log(`       (${elapsed}s)\n`);
      } catch (err) {
        process.stdout.write("\r" + " ".repeat(40) + "\r");
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}\n`);
      }

      prompt();
    });
  };

  prompt();
}

main().catch(console.error);

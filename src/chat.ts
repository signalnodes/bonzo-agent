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

        const result = await agent.invoke(
          { messages: conversationHistory.map(m => ({
            role: m.role as "user" | "assistant",
            content: m.content,
          }))},
        );

        const lastMessage = result.messages[result.messages.length - 1];
        const responseText = typeof lastMessage.content === "string"
          ? lastMessage.content
          : JSON.stringify(lastMessage.content);

        conversationHistory.push({ role: "assistant", content: responseText });
        console.log(`\nagent> ${responseText}\n`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\nError: ${msg}\n`);
      }

      prompt();
    });
  };

  prompt();
}

main().catch(console.error);

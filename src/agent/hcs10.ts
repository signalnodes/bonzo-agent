/**
 * HCS-10 message handler for the Bonzo Vault Keeper Agent.
 *
 * Listens for inbound messages on the agent's HCS-10 inbound topic,
 * processes them through the LangChain agent, and sends responses
 * back via the connection topic.
 *
 * This fulfills the bounty requirement: "Must be reachable via HCS-10."
 */

import { HCS10Client } from "@hashgraphonline/standards-sdk";
import { env } from "../config/env.js";
import { HEDERA_MIRROR_NODE, HCS10_POLL_INTERVAL_MS, MAX_PROCESSED_TIMESTAMPS } from "../config/constants.js";
import { loadState } from "./state.js";
import type { AgentResult } from "./setup.js";

// ---------------------------------------------------------------------------
// Types for HCS-10 mirror node responses
// ---------------------------------------------------------------------------

interface MirrorMessage {
  consensus_timestamp: string;
  message: string; // base64
}

interface MirrorTopicResponse {
  messages?: MirrorMessage[];
}

interface HCS10Envelope {
  op?: string;
  type?: string;
  operator_id?: string;
  account_id?: string;
  from?: string;
  connection_request_id?: string | number;
  id?: string | number;
  data?: string;
  content?: string;
  text?: string;
}

export interface HCS10Handler {
  client: HCS10Client;
  stop: () => void;
}

/**
 * Create an HCS10Client from env config.
 */
function createHCS10Client(): HCS10Client {
  return new HCS10Client({
    network: env.hedera.network,
    operatorId: env.hedera.accountId,
    operatorPrivateKey: env.hedera.privateKey,
  });
}

/**
 * Bounded set of processed message timestamps.
 * Evicts oldest entries when the cap is reached to prevent unbounded memory growth.
 */
const processedTimestamps = new Set<string>();

function markProcessed(timestamp: string): void {
  processedTimestamps.add(timestamp);
  if (processedTimestamps.size > MAX_PROCESSED_TIMESTAMPS) {
    // Delete oldest entries (Set iterates in insertion order)
    const excess = processedTimestamps.size - MAX_PROCESSED_TIMESTAMPS;
    let i = 0;
    for (const ts of processedTimestamps) {
      if (i++ >= excess) break;
      processedTimestamps.delete(ts);
    }
  }
}

/**
 * Start listening for HCS-10 inbound messages and route them
 * through the LangChain agent.
 *
 * Requires the agent to be registered first (npm run register).
 */
export async function startHCS10Listener(
  agentResult: AgentResult
): Promise<HCS10Handler> {
  const state = loadState();

  if (!state.inboundTopicId || !state.outboundTopicId) {
    throw new Error(
      "Agent not registered. Run `npm run register` first to create HCS-10 topics."
    );
  }

  const client = createHCS10Client();

  console.log(`[HCS-10] Listening on inbound topic: ${state.inboundTopicId}`);
  console.log(`[HCS-10] Outbound topic: ${state.outboundTopicId}`);

  let running = true;
  let pollTimeout: ReturnType<typeof setTimeout> | null = null;

  // Track active connection topics we're monitoring
  const activeConnections = new Map<string, string>(); // connectionTopicId -> remoteAccountId

  const poll = async () => {
    if (!running) return;

    try {
      // Fetch inbound topic messages to find connection requests
      const mirrorUrl = `${HEDERA_MIRROR_NODE}/api/v1/topics/${state.inboundTopicId}/messages?order=desc&limit=25`;
      const res = await fetch(mirrorUrl);
      if (!res.ok) throw new Error(`Mirror node error: ${res.status}`);

      const data = (await res.json()) as MirrorTopicResponse;
      const messages = data.messages ?? [];

      for (const msg of messages) {
        const timestamp = msg.consensus_timestamp;
        if (processedTimestamps.has(timestamp)) continue;
        markProcessed(timestamp);

        // Decode the base64 message
        let decoded: string;
        try {
          decoded = Buffer.from(msg.message, "base64").toString("utf-8");
        } catch {
          continue;
        }

        let parsed: HCS10Envelope;
        try {
          parsed = JSON.parse(decoded) as HCS10Envelope;
        } catch {
          continue;
        }

        // Handle connection requests (HCS-10 protocol)
        if (parsed.op === "connection_request" || parsed.type === "connection_request") {
          const requestingAccount = parsed.operator_id ?? parsed.account_id ?? parsed.from;
          const rawConnectionId = parsed.connection_request_id ?? parsed.id;

          if (!requestingAccount || rawConnectionId === undefined) continue;
          const connectionId = Number(rawConnectionId);

          console.log(`[HCS-10] Connection request from ${requestingAccount} (id: ${connectionId})`);

          try {
            const response = await client.handleConnectionRequest(
              state.inboundTopicId!,
              requestingAccount,
              connectionId
            );
            console.log(
              `[HCS-10] Accepted connection → topic ${response.connectionTopicId}`
            );
            if (response.connectionTopicId) {
              activeConnections.set(response.connectionTopicId, requestingAccount);
            }
          } catch (err) {
            console.error(
              `[HCS-10] Failed to handle connection:`,
              err instanceof Error ? err.message : err
            );
          }
        }
      }

      // Poll active connection topics for messages
      for (const [topicId, remoteAccount] of activeConnections) {
        try {
          const connRes = await fetch(
            `${HEDERA_MIRROR_NODE}/api/v1/topics/${topicId}/messages?order=desc&limit=10`
          );
          if (!connRes.ok) continue;

          const connData = (await connRes.json()) as MirrorTopicResponse;
          const connMessages = connData.messages ?? [];

          for (const connMsg of connMessages) {
            if (processedTimestamps.has(connMsg.consensus_timestamp)) continue;
            processedTimestamps.add(connMsg.consensus_timestamp);

            let msgDecoded: string;
            try {
              msgDecoded = Buffer.from(connMsg.message, "base64").toString("utf-8");
            } catch {
              continue;
            }

            let msgParsed: HCS10Envelope;
            try {
              msgParsed = JSON.parse(msgDecoded) as HCS10Envelope;
            } catch {
              continue;
            }

            // Skip our own messages
            if (msgParsed.operator_id === env.hedera.accountId) continue;
            if (msgParsed.op !== "message" && msgParsed.type !== "message") continue;

            const userMessage = msgParsed.data ?? msgParsed.content ?? msgParsed.text ?? "";
            if (!userMessage) continue;

            console.log(`[HCS-10] Message from ${remoteAccount}: ${userMessage.substring(0, 80)}...`);

            // Route through LangChain agent
            const response = await processMessage(agentResult, userMessage);

            // Send response back on connection topic
            await client.sendMessage(topicId, response);
            console.log(`[HCS-10] Replied on ${topicId}`);
          }
        } catch (err) {
          // Silently continue
        }
      }
    } catch (err) {
      console.error(
        `[HCS-10] Poll error:`,
        err instanceof Error ? err.message : err
      );
    }

    if (running) {
      pollTimeout = setTimeout(poll, HCS10_POLL_INTERVAL_MS);
    }
  };

  // Start polling
  poll();

  return {
    client,
    stop: () => {
      running = false;
      if (pollTimeout) clearTimeout(pollTimeout);
      console.log("[HCS-10] Listener stopped.");
    },
  };
}

/**
 * Process a single inbound message through the LangChain agent.
 */
async function processMessage(
  agentResult: AgentResult,
  message: string
): Promise<string> {
  try {
    const result = await agentResult.agent.invoke({
      messages: [{ role: "user" as const, content: message }],
    });

    const lastMessage = result.messages[result.messages.length - 1];
    return typeof lastMessage.content === "string"
      ? lastMessage.content
      : JSON.stringify(lastMessage.content);
  } catch (err) {
    return `Error processing request: ${err instanceof Error ? err.message : err}`;
  }
}

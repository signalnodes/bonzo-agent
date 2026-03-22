/**
 * HCS-10 message handler for the Bonzo Vault Keeper Agent.
 *
 * Uses TopicMessageQuery (gRPC streaming) instead of REST polling:
 *  - Messages are pushed to the agent as they reach consensus (~sub-second)
 *  - No polling interval, no missed messages, no timestamp cursor bookkeeping
 *  - SDK handles reconnection automatically on stream drops
 *
 * This fulfills the bounty requirement: "Must be reachable via HCS-10."
 */

import {
  Client,
  AccountId,
  PrivateKey,
  TopicId,
  TopicMessageQuery,
} from "@hashgraph/sdk";
import { HCS10Client } from "@hashgraphonline/standards-sdk";
import { env } from "../config/env.js";
import { HCS10_RATE_LIMIT_MS } from "../config/constants.js";
import { loadState } from "./state.js";
import type { AgentResult } from "./setup.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// Opaque handle returned by TopicMessageQuery.subscribe()
type SubscriptionHandle = ReturnType<TopicMessageQuery["subscribe"]>;

// ---------------------------------------------------------------------------
// Client factories
// ---------------------------------------------------------------------------

function createHCS10Client(): HCS10Client {
  return new HCS10Client({
    network: env.hedera.network,
    operatorId: env.hedera.accountId,
    operatorPrivateKey: env.hedera.privateKey,
  });
}

/**
 * A Hedera SDK client configured for mirror-node gRPC streaming.
 * Does not need an operator — TopicMessageQuery is read-only.
 */
function createMirrorClient(): Client {
  const client =
    env.hedera.network === "mainnet" ? Client.forMainnet() : Client.forTestnet();

  // Set operator so the client is fully initialised (some SDK versions require it)
  const rawKey = env.hedera.privateKey;
  let pk: PrivateKey;
  if (/^[0-9a-fA-F]{64}$/.test(rawKey)) {
    try { pk = PrivateKey.fromStringECDSA(rawKey); } catch {
      pk = PrivateKey.fromStringED25519(rawKey);
    }
  } else {
    try { pk = PrivateKey.fromStringDer(rawKey); } catch {
      pk = PrivateKey.fromStringECDSA(rawKey);
    }
  }
  client.setOperator(AccountId.fromString(env.hedera.accountId), pk);

  return client;
}

// ---------------------------------------------------------------------------
// Message decoder
// ---------------------------------------------------------------------------

function decodeEnvelope(raw: Uint8Array): HCS10Envelope | null {
  try {
    const text = Buffer.from(raw).toString("utf-8");
    return JSON.parse(text) as HCS10Envelope;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// startHCS10Listener
// ---------------------------------------------------------------------------

/**
 * Subscribe to the agent's inbound HCS-10 topic via gRPC streaming.
 * When a connection request arrives, accept it and subscribe to the new
 * connection topic. Messages on connection topics are routed through the
 * LangChain agent and replied to via HCS10Client.sendMessage().
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

  const hcs10Client = createHCS10Client();
  const mirrorClient = createMirrorClient();

  // All active subscriptions — collected so stop() can cancel them all
  const subscriptions: SubscriptionHandle[] = [];

  // Rate limit: last processed time per connection topic
  const connectionLastMessageAt = new Map<string, number>();

  // Per-connection processing lock — prevents overlapping agent invocations
  const connectionProcessing = new Map<string, boolean>();

  // -------------------------------------------------------------------------
  // Subscribe to a connection topic once a connection has been accepted
  // -------------------------------------------------------------------------

  function subscribeToConnectionTopic(
    topicId: string,
    remoteAccount: string
  ): void {
    console.log(`[HCS-10] Subscribing to connection topic: ${topicId}`);

    const handle = new TopicMessageQuery()
      .setTopicId(TopicId.fromString(topicId))
      .setStartTime(new Date()) // only messages from this point forward
      .subscribe(
        mirrorClient,
        (message) => {
          if (!message) return;
          void handleConnectionMessage(topicId, remoteAccount, message.contents);
        },
        (err) => {
          console.error(
            `[HCS-10] Stream error on connection ${topicId}:`,
            err instanceof Error ? err.message : err
          );
        }
      );

    subscriptions.push(handle);
  }

  async function handleConnectionMessage(
    topicId: string,
    remoteAccount: string,
    contents: Uint8Array
  ): Promise<void> {
    // Rate limit — drop if previous reply is still too recent
    const lastAt = connectionLastMessageAt.get(topicId) ?? 0;
    if (Date.now() - lastAt < HCS10_RATE_LIMIT_MS) return;

    // Processing lock — skip if an agent call is already in flight for this topic
    if (connectionProcessing.get(topicId)) return;

    const parsed = decodeEnvelope(contents);
    if (!parsed) return;

    // Skip our own outbound messages echoed back on the shared topic
    if (parsed.operator_id === env.hedera.accountId) return;
    if (parsed.op !== "message" && parsed.type !== "message") return;

    const userMessage = parsed.data ?? parsed.content ?? parsed.text ?? "";
    if (!userMessage) return;

    connectionLastMessageAt.set(topicId, Date.now());
    connectionProcessing.set(topicId, true);

    console.log(
      `[HCS-10] Message from ${remoteAccount}: ${userMessage.substring(0, 80)}…`
    );

    try {
      const response = await processMessage(agentResult, userMessage);
      await hcs10Client.sendMessage(topicId, response);
      console.log(`[HCS-10] Replied on ${topicId}`);
    } catch (err) {
      console.error(
        `[HCS-10] Failed to reply on ${topicId}:`,
        err instanceof Error ? err.message : err
      );
    } finally {
      connectionProcessing.set(topicId, false);
    }
  }

  // -------------------------------------------------------------------------
  // Subscribe to the inbound topic for connection requests
  // -------------------------------------------------------------------------

  console.log(`[HCS-10] Subscribing to inbound topic: ${state.inboundTopicId}`);
  console.log(`[HCS-10] Outbound topic: ${state.outboundTopicId}`);

  const inboundHandle = new TopicMessageQuery()
    .setTopicId(TopicId.fromString(state.inboundTopicId))
    .setStartTime(new Date()) // ignore historical connection requests on startup
    .subscribe(
      mirrorClient,
      (message) => {
        if (!message) return;
        void handleInboundMessage(message.contents);
      },
      (err) => {
        console.error(
          `[HCS-10] Inbound stream error:`,
          err instanceof Error ? err.message : err
        );
      }
    );

  subscriptions.push(inboundHandle);

  async function handleInboundMessage(contents: Uint8Array): Promise<void> {
    const parsed = decodeEnvelope(contents);
    if (!parsed) return;

    if (
      parsed.op !== "connection_request" &&
      parsed.type !== "connection_request"
    ) return;

    const requestingAccount =
      parsed.operator_id ?? parsed.account_id ?? parsed.from;
    const rawConnectionId = parsed.connection_request_id ?? parsed.id;

    if (!requestingAccount || rawConnectionId === undefined) return;
    const connectionId = Number(rawConnectionId);

    console.log(
      `[HCS-10] Connection request from ${requestingAccount} (id: ${connectionId})`
    );

    try {
      const response = await hcs10Client.handleConnectionRequest(
        state.inboundTopicId!,
        requestingAccount,
        connectionId
      );
      console.log(
        `[HCS-10] Accepted connection → topic ${response.connectionTopicId}`
      );
      if (response.connectionTopicId) {
        subscribeToConnectionTopic(
          response.connectionTopicId,
          requestingAccount
        );
      }
    } catch (err) {
      console.error(
        `[HCS-10] Failed to handle connection request:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // -------------------------------------------------------------------------
  // Handler
  // -------------------------------------------------------------------------

  return {
    client: hcs10Client,
    stop: () => {
      for (const sub of subscriptions) {
        try { sub.unsubscribe(); } catch { /* ignore */ }
      }
      mirrorClient.close();
      console.log("[HCS-10] Listener stopped.");
    },
  };
}

// ---------------------------------------------------------------------------
// Agent invocation
// ---------------------------------------------------------------------------

async function processMessage(
  agentResult: AgentResult,
  message: string
): Promise<string> {
  try {
    const result = await agentResult.agent.invoke({
      messages: [{ role: "user" as const, content: message }],
    });
    const last = result.messages[result.messages.length - 1];
    return typeof last.content === "string"
      ? last.content
      : JSON.stringify(last.content);
  } catch (err) {
    return `Error processing request: ${err instanceof Error ? err.message : err}`;
  }
}

/**
 * Express server for the Bonzo Vault Keeper chat UI.
 *
 * GET  /           — static chat UI (served from public/)
 * POST /api/chat   — send a message to the LangChain agent
 * GET  /api/status — current market data + vault APY + alerts
 * GET  /api/alerts — SSE stream of real-time alerts from the monitor
 */

import express, { type Request, type Response } from "express";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import crypto from "node:crypto";

import { createAgent } from "./agent/setup.js";
import { resolveModelTier } from "./agent/model-router.js";
import { MonitorLoop, type Alert as MonitorAlert } from "./agent/monitor-loop.js";
import { startHCS10Listener } from "./agent/hcs10.js";
import { fetchMarketData } from "./strategy/spread.js";
import { getBestAPYEstimate } from "./strategy/vault-apy.js";
import { validateEnv } from "./config/env.js";
import { loadState } from "./agent/state.js";
import {
  MAX_ALERTS,
  MAX_SESSION_HISTORY,
  SESSION_HISTORY_TRIM_TO,
  MONITOR_INTERVAL_MS,
} from "./config/constants.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface SSEAlert {
  id: string;
  level: "info" | "warning" | "critical";
  title: string;
  message: string;
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Globals
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const SESSION_HEADER = "x-session-id";
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD ?? "gib311";

/** Valid auth tokens (in-memory; cleared on restart) */
const validTokens = new Set<string>();

function requireAuth(req: Request, res: Response, next: () => void): void {
  const token = req.headers["x-auth-token"] as string | undefined;
  if (token && validTokens.has(token)) {
    next();
    return;
  }
  res.status(401).json({ error: "unauthorized" });
}

/** Per-session conversation history */
const sessions = new Map<string, ChatMessage[]>();

/** Connected SSE clients */
const sseClients = new Set<Response>();

/** Recent SSE alerts (derived from MonitorLoop) */
const recentAlerts: SSEAlert[] = [];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSessionId(req: Request): string {
  const fromHeader = req.headers[SESSION_HEADER] as string | undefined;
  if (fromHeader) return fromHeader;
  // Fall back to a query param or generate one (client should persist it)
  return (req.query.session as string) ?? crypto.randomUUID();
}

function broadcastAlert(alert: SSEAlert): void {
  recentAlerts.push(alert);
  if (recentAlerts.length > MAX_ALERTS) recentAlerts.shift();

  const payload = `data: ${JSON.stringify(alert)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

/** The shared MonitorLoop instance — created in main() */
let monitor: MonitorLoop;

function startMonitor(): void {
  monitor = new MonitorLoop({ intervalMs: MONITOR_INTERVAL_MS });

  // Wire MonitorLoop alerts → SSE broadcast
  monitor.on("alert", (alert: MonitorAlert) => {
    broadcastAlert({
      id: alert.id,
      level: alert.level,
      title: alert.title,
      message: alert.message,
      timestamp: alert.timestamp.toISOString(),
    });
  });

  // Delay first tick so server starts quickly
  setTimeout(() => monitor.start(), 5_000);
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  validateEnv();

  // Print a startup banner with live market data so it's immediately clear
  // the agent is connected to Hedera mainnet.
  console.log("━".repeat(52));
  console.log("  Bonzo Vault Keeper  ·  Hedera Mainnet");
  console.log("━".repeat(52));
  try {
    const [market, liveApy] = await Promise.allSettled([
      fetchMarketData(),
      getBestAPYEstimate(),
    ]);
    if (market.status === "fulfilled") {
      const m = market.value;
      const vaultApy = liveApy.status === "fulfilled" && liveApy.value !== null
        ? liveApy.value
        : 70;
      const netSpread = (vaultApy - m.hbarxBorrowApy).toFixed(1);
      const viable = parseFloat(netSpread) > 5;
      const apyLabel = liveApy.status === "fulfilled" && liveApy.value !== null
        ? `${vaultApy.toFixed(1)}% (live)`
        : `${vaultApy.toFixed(1)}% (estimate)`;
      console.log(`  HBARX Borrow Rate : ${m.hbarxBorrowApy.toFixed(3)}%`);
      console.log(`  HBAR Price        : $${m.hbarPriceUsd.toFixed(4)}`);
      console.log(`  Vault APY         : ${apyLabel}`);
      console.log(`  Net Spread        : ${netSpread}%  (${viable ? "✓ viable" : "✗ not viable"})`);
      console.log(`  HBARX Utilization : ${m.hbarxUtilization.toFixed(1)}%`);
    }
  } catch {
    console.log("  Market data unavailable — check connectivity");
  }
  console.log("━".repeat(52));
  console.log("");

  console.log("Initializing LangChain agent...");
  const agentResult = await createAgent();
  const { agent, haikuAgent } = agentResult;
  console.log(`Agent ready (${agentResult.config.toolCount} tools · ${agentResult.config.modelName}).`);

  /** Pick the right agent for a given user message. */
  const pickAgent = (message: string) => {
    const tier = resolveModelTier(message);
    const selected = tier === "haiku" && haikuAgent ? haikuAgent : agent;
    const label = tier === "haiku" && haikuAgent ? "haiku" : agentResult.config.modelName;
    return { selected, tier, label };
  };

  const app = express();
  app.use(express.json());

  // Serve static files from public/
  const publicDir = join(__dirname, "..", "public");
  app.use(express.static(publicDir));

  // -----------------------------------------------------------------------
  // POST /api/auth  — password gate (public)
  // -----------------------------------------------------------------------
  app.post("/api/auth", (req: Request, res: Response): void => {
    const { password } = req.body as { password?: string };
    if (password === ACCESS_PASSWORD) {
      const token = crypto.randomUUID();
      validTokens.add(token);
      res.json({ ok: true, token });
    } else {
      res.status(403).json({ ok: false, error: "wrong password" });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/chat
  // -----------------------------------------------------------------------
  app.post("/api/chat", requireAuth, async (req: Request, res: Response): Promise<void> => {
    const { message, sessionId: clientSessionId } = req.body as {
      message?: string;
      sessionId?: string;
    };

    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }

    const sessionId = clientSessionId ?? getSessionId(req);
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, []);
    }
    const history = sessions.get(sessionId)!;
    history.push({ role: "user", content: message });

    try {
      const langchainMessages = history.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      const { selected: selectedAgent, label } = pickAgent(message);
      console.log(`[chat] tier=${label} msg="${message.slice(0, 60)}"`);

      const result = await selectedAgent.invoke({
        messages: langchainMessages,
      });

      const lastMessage = result.messages[result.messages.length - 1];
      const responseText =
        typeof lastMessage.content === "string"
          ? lastMessage.content
          : JSON.stringify(lastMessage.content);

      history.push({ role: "assistant", content: responseText });

      // Keep history bounded
      if (history.length > MAX_SESSION_HISTORY) {
        history.splice(0, history.length - SESSION_HISTORY_TRIM_TO);
      }

      res.json({ response: responseText, sessionId });
    } catch (err) {
      console.error("Agent error:", err);
      res.status(500).json({
        error: "Agent invocation failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // -----------------------------------------------------------------------
  // POST /api/chat/stream  — SSE streaming version
  // -----------------------------------------------------------------------
  app.post("/api/chat/stream", requireAuth, async (req: Request, res: Response): Promise<void> => {
    const { message, sessionId: clientSessionId } = req.body as {
      message?: string;
      sessionId?: string;
    };

    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message is required" });
      return;
    }

    const sessionId = clientSessionId ?? getSessionId(req);
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, []);
    }
    const history = sessions.get(sessionId)!;
    history.push({ role: "user", content: message });

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    const langchainMessages = history.map((m) => ({
      role: m.role,
      content: m.content,
    }));

    let fullResponse = "";

    try {
      const { selected: selectedAgent, label } = pickAgent(message);
      console.log(`[stream] tier=${label} msg="${message.slice(0, 60)}"`);
      send("model", { tier: label });

      const stream = selectedAgent.streamEvents({ messages: langchainMessages }, { version: "v2" });

      let chainFinalText = "";

      for await (const event of stream) {
        if (event.event === "on_tool_start") {
          send("tool_start", { tool: event.name });
        } else if (event.event === "on_chat_model_stream") {
          const chunk = event.data?.chunk;
          const token =
            typeof chunk?.content === "string"
              ? chunk.content
              : Array.isArray(chunk?.content)
              ? chunk.content
                  .map((c: { type?: string; text?: string }) =>
                    c.type === "text" || c.type === "text_delta" ? (c.text ?? "") : ""
                  )
                  .join("")
              : "";
          if (token) {
            fullResponse += token;
            send("token", { token });
          }
        } else if (event.event === "on_chain_end") {
          // Capture final AI message text as fallback when no stream tokens arrived.
          // With some LangGraph/Anthropic version combos the model's final response
          // lands here instead of via on_chat_model_stream chunks.
          if (fullResponse === "") {
            const msgs: unknown[] = event.data?.output?.messages ?? [];
            const last = msgs[msgs.length - 1] as { content?: unknown } | undefined;
            if (last?.content) {
              chainFinalText =
                typeof last.content === "string"
                  ? last.content
                  : Array.isArray(last.content)
                  ? (last.content as { type?: string; text?: string }[])
                      .map((c) => (c.type === "text" ? (c.text ?? "") : ""))
                      .join("")
                  : "";
            }
          }
        } else {
          // Debug: log unexpected event types so container logs reveal the issue
          if (!["on_chain_start", "on_chain_stream", "on_tool_end", "on_chat_model_start", "on_chat_model_end"].includes(event.event)) {
            console.debug(`[stream] unhandled event: ${event.event} name=${event.name}`);
          }
        }
      }

      // If on_chat_model_stream produced nothing, use the chain-end fallback text
      if (fullResponse === "" && chainFinalText) {
        fullResponse = chainFinalText;
        send("token", { token: chainFinalText });
      }

      history.push({ role: "assistant", content: fullResponse });
      if (history.length > MAX_SESSION_HISTORY) {
        history.splice(0, history.length - SESSION_HISTORY_TRIM_TO);
      }

      send("done", { sessionId });
    } catch (err) {
      console.error("Stream error:", err);
      send("error", { message: err instanceof Error ? err.message : String(err) });
    } finally {
      res.end();
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/status
  // -----------------------------------------------------------------------
  app.get("/api/status", requireAuth, async (_req: Request, res: Response): Promise<void> => {
    const s = monitor?.getStatus();
    // Fall back to the shared cache (warm from startup banner) if the monitor
    // hasn't completed its first tick yet — avoids all-dashes on first page load.
    const market = s?.latestMarket ?? await fetchMarketData().catch(() => null);

    res.json({
      monitor: {
        running: s?.running ?? false,
        lastCheck: s?.lastCheck?.toISOString() ?? null,
        checkCount: s?.checkCount ?? 0,
      },
      market: market
        ? {
            hbarxBorrowApy: market.hbarxBorrowApy,
            hbarxSupplyApy: market.hbarxSupplyApy,
            hbarxUtilization: market.hbarxUtilization,
            hbarxAvailableLiquidity: market.hbarxAvailableLiquidity,
            whbarBorrowApy: market.whbarBorrowApy,
            usdcBorrowApy: market.usdcBorrowApy,
            hbarPriceUsd: market.hbarPriceUsd,
            hbarxPriceUsd: market.hbarxPriceUsd,
            hbarxHbarRate: market.hbarxPriceUsd > 0 && market.hbarPriceUsd > 0
              ? market.hbarxPriceUsd / market.hbarPriceUsd
              : null,
          }
        : null,
      vault: {
        apy: s?.latestVaultApy ?? null,
      },
      spread: s?.latestSpread != null
        ? {
            netSpread: s.latestSpread,
            hbarxBorrowRate: market?.hbarxBorrowApy ?? null,
            vaultApy: s.latestVaultApy ?? null,
          }
        : null,
      position: {
        healthFactor: s?.latestHealthFactor ?? null,
      },
      hcs10: (() => {
        const st = loadState();
        return st.inboundTopicId
          ? { inboundTopicId: st.inboundTopicId, outboundTopicId: st.outboundTopicId ?? null, registered: true }
          : { registered: false };
      })(),
      alerts: recentAlerts.slice(-10),
      updatedAt: new Date().toISOString(),
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/health  — connectivity + liveness probe
  // -----------------------------------------------------------------------
  app.get("/api/health", async (_req: Request, res: Response): Promise<void> => {
    try {
      const market = await fetchMarketData();
      res.json({
        status: "ok",
        bonzoApi: true,
        monitorRunning: monitor?.getStatus().running ?? false,
        hbarxBorrowApy: market.hbarxBorrowApy,
        hbarxUtilization: market.hbarxUtilization,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      res.status(503).json({
        status: "degraded",
        bonzoApi: false,
        error: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      });
    }
  });

  // -----------------------------------------------------------------------
  // GET /api/alerts  (SSE)
  // -----------------------------------------------------------------------
  app.get("/api/alerts", requireAuth, (req: Request, res: Response): void => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    // Send recent alerts as initial burst
    for (const alert of recentAlerts.slice(-10)) {
      res.write(`data: ${JSON.stringify(alert)}\n\n`);
    }

    sseClients.add(res);

    req.on("close", () => {
      sseClients.delete(res);
    });
  });

  // -----------------------------------------------------------------------
  // Start
  // -----------------------------------------------------------------------
  app.listen(PORT, () => {
    console.log(`Bonzo Vault Keeper UI running at http://localhost:${PORT}`);
  });

  startMonitor();

  // Start HCS-10 listener (requires prior `npm run register`)
  try {
    await startHCS10Listener(agentResult);
    console.log("[HCS-10] Listener started.");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("not registered")) {
      console.warn("[HCS-10] Agent not registered — run `npm run register` to enable HCS-10. Skipping listener.");
    } else {
      console.warn("[HCS-10] Listener failed to start:", msg);
    }
  }
}

main().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

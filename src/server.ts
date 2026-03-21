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
import { MonitorLoop, type Alert as MonitorAlert } from "./agent/monitor-loop.js";
import { startHCS10Listener } from "./agent/hcs10.js";
import { validateEnv } from "./config/env.js";
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

  console.log("Initializing LangChain agent...");
  const agentResult = await createAgent();
  const { agent } = agentResult;
  console.log("Agent ready.");

  const app = express();
  app.use(express.json());

  // Serve static files from public/
  const publicDir = join(__dirname, "..", "public");
  app.use(express.static(publicDir));

  // -----------------------------------------------------------------------
  // POST /api/chat
  // -----------------------------------------------------------------------
  app.post("/api/chat", async (req: Request, res: Response): Promise<void> => {
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

      const result = await agent.invoke({
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
  // GET /api/status
  // -----------------------------------------------------------------------
  app.get("/api/status", (_req: Request, res: Response): void => {
    const s = monitor?.getStatus();
    const market = s?.latestMarket;

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
          }
        : null,
      vault: {
        apy: s?.latestVaultApy ?? null,
      },
      spread: s?.latestSpread != null
        ? { netSpread: s.latestSpread }
        : null,
      alerts: recentAlerts.slice(-10),
      updatedAt: new Date().toISOString(),
    });
  });

  // -----------------------------------------------------------------------
  // GET /api/alerts  (SSE)
  // -----------------------------------------------------------------------
  app.get("/api/alerts", (req: Request, res: Response): void => {
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

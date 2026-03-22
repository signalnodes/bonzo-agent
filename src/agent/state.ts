/**
 * Agent state persistence.
 *
 * Reads/writes .agent-state.json for:
 * - HCS-10 registration info (topic IDs from `npm run register`)
 * - Strategy state across restarts
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { StrategyState } from "../strategy/orchestrator.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = process.env.AGENT_STATE_PATH
  ? resolve(process.env.AGENT_STATE_PATH)
  : resolve(__dirname, "..", "..", ".agent-state.json");

export interface AgentState {
  // HCS-10 registration
  accountId?: string;
  inboundTopicId?: string;
  outboundTopicId?: string;
  registeredAt?: string;
  network?: string;

  // Strategy
  strategy?: StrategyState;
}

export function loadState(): AgentState {
  if (!existsSync(STATE_FILE)) {
    return {};
  }
  try {
    const raw = readFileSync(STATE_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function saveState(state: AgentState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

export function updateState(partial: Partial<AgentState>): AgentState {
  const current = loadState();
  const updated = { ...current, ...partial };
  saveState(updated);
  return updated;
}

export function isRegistered(): boolean {
  const state = loadState();
  return !!(state.inboundTopicId && state.outboundTopicId);
}

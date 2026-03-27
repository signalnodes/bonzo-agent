/**
 * Deterministic model-tier classifier for hybrid routing.
 *
 * Pure keyword/pattern matching — no LLM call.
 * Default: haiku. Escalate to sonnet when the message touches
 * execution, risk, strategy, or complex reasoning.
 */

export type ModelTier = "haiku" | "sonnet";

/** Patterns that warrant the stronger model. */
const SONNET_PATTERNS: RegExp[] = [
  // Transaction / execution verbs
  /\b(deposit|withdraw|borrow|repay|swap|execute|unstake|stake|approve|unwrap|wrap)\b/i,
  // Strategy / planning
  /\b(enter|exit|unwind|leverage|strateg|plan|position|rebalance)\b/i,
  // Risk analysis
  /\b(liquidat|health.?factor|risk|slippage|impermanent.?loss|collateral)\b/i,
  // Comparison / evaluation
  /\b(compare|which.{0,6}(better|best)|tradeoff|trade.?off|versus|\bvs\b|evaluate|should\s+i)\b/i,
  // Scenario / complex reasoning
  /\b(what.?if|how.?would|why.?should|walk.?me.?through|analyz|assessment|scenario)\b/i,
  // Sizing / amounts for execution
  /\b(how\s+much\s+(can|should|to)\b)/i,
];

/** Short affirmative replies that likely confirm a proposed action. */
const CONFIRM_RE =
  /^(yes|yeah|yep|yup|ok|okay|sure|proceed|confirm|do\s+it|go(\s+ahead|\s+for\s+it)?|let'?s\s*(do\s+it|go)?|sounds?\s+good|approved?|execute)\b/i;

export function resolveModelTier(message: string): ModelTier {
  const trimmed = message.trim();

  // Short confirmations are almost always action-adjacent.
  if (trimmed.length < 30 && CONFIRM_RE.test(trimmed)) {
    return "sonnet";
  }

  for (const pattern of SONNET_PATTERNS) {
    if (pattern.test(trimmed)) {
      return "sonnet";
    }
  }

  return "haiku";
}

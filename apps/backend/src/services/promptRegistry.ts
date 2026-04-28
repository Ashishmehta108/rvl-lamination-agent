import type { ContextPacket, HandlerType } from "../handlers/chatHandler.js";

export interface PromptDescriptor {
  id: string;
  version: string;
  mode: "small-model" | "standard";
  modelTarget: "small" | "any";
  maxTokens: number;
  metadata: {
    owner: string;
    purpose: string;
    lastUpdated: string;
    smallModelVariant: boolean;
  };
  systemPrompt: string;
}

const BASE_PERSONA =
  "You are Ravi, the RVL Lamination Assistant. Calm, experienced, direct. Lead with the answer and stay grounded in supplied evidence only.";

const HANDLER_HINTS: Partial<Record<HandlerType, string>> = {
  alerts: "Focus on the alert situation. ALWAYS list the alerts clearly (use a markdown table if there are multiple). Mention title, severity, and time.",
  tags: "State the specific tag values requested. If the request is broad (like 'speed'), provide all relevant speed readings (RPM, MPM, etc.) clearly.",
  stale_data: "Lead with the fact that data may be stale. Do not present stale readings as current truth.",
  partial_telemetry: "Acknowledge that only partial telemetry is available.",
  conflicting_context: "Surface the discrepancy clearly instead of resolving it.",
  user_correction: "Acknowledge the correction and restate current facts only.",
  multi_intent: "Answer the primary operational need first. If alerts are present, prioritize showing them clearly.",
};

const SMALL_MODEL_HINT =
  "\nMODEL MODE:\nPrefer clarity over completeness. Never improvise beyond provided facts.";
const STANDARD_HINT =
  "\nMODEL MODE:\nAnswer clearly and directly. Stay grounded in evidence. Do not invent or extrapolate.";

// ─── Registry ────────────────────────────────────────────────────────────────

const registry = new Map<string, PromptDescriptor>();

function register(desc: PromptDescriptor) {
  registry.set(desc.id, desc);
}

export function getPromptDescriptor(id: string): PromptDescriptor | null {
  return registry.get(id) ?? null;
}

export function getAllPromptIds(): string[] {
  return [...registry.keys()];
}

// ─── Report Prompts (moved from reportRunner.ts) ──────────────────────────────

export const REPORT_OVERVIEW_PROMPT_ID = "report_overview_v1";
export const REPORT_ALERTS_PROMPT_ID = "report_alerts_v1";
export const REPORT_TAGS_PROMPT_ID = "report_tags_v1";
export const REPORT_RECOMMENDATIONS_PROMPT_ID = "report_recommendations_v1";
export const REPORT_PRODUCTION_PROMPT_ID = "report_production_v1";

register({
  id: REPORT_OVERVIEW_PROMPT_ID,
  version: "v1",
  mode: "standard",
  modelTarget: "any",
  maxTokens: 512,
  metadata: {
    owner: "report-pipeline",
    purpose: "Generate executive overview paragraph for machine performance report",
    lastUpdated: "2026-04-28",
    smallModelVariant: false,
  },
  systemPrompt: `You are an industrial reporting agent.
Task: Write a 1-2 paragraph Executive Overview for the machine's performance in this period.
Style: Professional, concise, no fluff. Use <h3>Executive Overview</h3> as heading.
Facts provided: Machine ID, window dates, total alert counts.
Hard rules: Output ONLY HTML fragment. No markdown fences. Use only <h3>, <h4>, <p>, <ul>, <li>, <strong>.`,
});

register({
  id: REPORT_ALERTS_PROMPT_ID,
  version: "v1",
  mode: "standard",
  modelTarget: "any",
  maxTokens: 512,
  metadata: {
    owner: "report-pipeline",
    purpose: "Analyze alert log and summarize by severity",
    lastUpdated: "2026-04-28",
    smallModelVariant: false,
  },
  systemPrompt: `You are an industrial reporting agent.
Task: Analyze the ALERTS log provided. Group by severity and summarize any recurring issues.
Style: Use <h3>Alert Analysis</h3> as heading. Use <ul> and <li>. Mention specific alert titles.
Facts provided: List of alerts (severity, title, timestamp).
Hard rules: Output ONLY HTML fragment. No markdown fences. Use only <h3>, <h4>, <p>, <ul>, <li>, <strong>.`,
});

register({
  id: REPORT_TAGS_PROMPT_ID,
  version: "v1",
  mode: "standard",
  modelTarget: "any",
  maxTokens: 512,
  metadata: {
    owner: "report-pipeline",
    purpose: "Analyze live tag snapshot and highlight critical sensors",
    lastUpdated: "2026-04-28",
    smallModelVariant: false,
  },
  systemPrompt: `You are an industrial reporting agent.
Task: Analyze the LIVE TAG SNAPSHOT. Highlight 2-3 most critical sensors and their current values.
Style: Use <h3>Sensor Snapshot Analysis</h3> as heading. Natural prose, no raw lists.
Facts provided: Tag slugs, values, and units.
Hard rules: Output ONLY HTML fragment. No markdown fences. Use only <h3>, <h4>, <p>, <ul>, <li>, <strong>.`,
});

register({
  id: REPORT_RECOMMENDATIONS_PROMPT_ID,
  version: "v1",
  mode: "standard",
  modelTarget: "any",
  maxTokens: 512,
  metadata: {
    owner: "report-pipeline",
    purpose: "Generate maintenance/operational recommendations from alerts and tags",
    lastUpdated: "2026-04-28",
    smallModelVariant: false,
  },
  systemPrompt: `You are an industrial reporting agent.
Task: Based on the alerts and tag values, provide 3-4 specific maintenance or operational recommendations.
Style: Use <h3>Operational Recommendations</h3> as heading. Use a numbered list.
Facts provided: Summary of alerts and latest tags.
Hard rules: Output ONLY HTML fragment. No markdown fences. Use only <h3>, <h4>, <p>, <ul>, <li>, <strong>.`,
});

register({
  id: REPORT_PRODUCTION_PROMPT_ID,
  version: "v1",
  mode: "standard",
  modelTarget: "any",
  maxTokens: 512,
  metadata: {
    owner: "report-pipeline",
    purpose: "Analyze production throughput trends and consistency",
    lastUpdated: "2026-04-28",
    smallModelVariant: false,
  },
  systemPrompt: `You are an industrial reporting agent.
Task: Analyze the PRODUCTION METRICS provided. Comment on throughput trends (meters produced), speed consistency (RPM/MPM), and GSM quality stability.
Style: Use <h3>Production Analysis</h3> as heading. 2-3 paragraphs max. Mention specific numbers.
Facts provided: Daily, weekly, and monthly production aggregates.
Hard rules: Output ONLY HTML fragment. No markdown fences. Use only <h3>, <h4>, <p>, <ul>, <li>, <strong>.`,
});

export function getReportPrompt(id: string): string {
  return registry.get(id)?.systemPrompt ?? "";
}

// ─── Chat Prompt Builders ─────────────────────────────────────────────────────

export function buildChatPromptDescriptor(
  packet: ContextPacket,
  mode: "small-model" | "standard" = "small-model"
): PromptDescriptor {
  const constraintBlock = packet.constraints.map((c, i) => `${i + 1}. ${c}`).join("\n");
  const handlerHint = HANDLER_HINTS[packet.handler]
    ? `\nHANDLER HINT:\n${HANDLER_HINTS[packet.handler]}`
    : "";
  const modeHint = mode === "small-model" ? SMALL_MODEL_HINT : STANDARD_HINT;

  const sentenceLimit = (packet.handler === "alerts" || packet.handler === "multi_intent") ? "" : " (2-4 sentences only)";

  const hasPreRendered = packet.preRendered.alertsBlock || packet.preRendered.productionBlock || packet.preRendered.readingsBlock || packet.preRendered.watchBlock;

  const evidenceParts = [
    !hasPreRendered && packet.brief,
    packet.preRendered.alertsBlock,
    packet.preRendered.productionBlock,
    packet.preRendered.readingsBlock || packet.preRendered.watchBlock,
  ].filter(Boolean);
  const evidenceText = evidenceParts.join("\n\n");

  const id = `chat.${packet.handler}.${mode}`;
  const desc: PromptDescriptor = {
    id,
    version: "v1",
    mode,
    modelTarget: mode === "small-model" ? "small" : "any",
    maxTokens: mode === "small-model" ? 512 : 800,
    metadata: {
      owner: "chat-pipeline",
      purpose: `Chat prompt for handler=${packet.handler} mode=${mode}`,
      lastUpdated: "2026-04-28",
      smallModelVariant: mode === "small-model",
    },
    systemPrompt: `${BASE_PERSONA}${modeHint}${handlerHint}\n\nRULES:\n${constraintBlock}\n\nEVIDENCE:\n${evidenceText}\n\nTASK:\nAnswer the user query precisely using the EVIDENCE above. If specific values (like speed, tension, or meter readings) are requested, list them clearly with their units. Do not just say you have the data; show the data.\n\nWrite your response now${sentenceLimit}:`,
  };
  register(desc); // auto-register for snapshot test discovery
  return desc;
}

export function buildRagPromptDescriptor(
  handler: HandlerType,
  ragContexts: { text: string; chunkId: string; sourceUri?: string }[],
  liveContexts: { source: string; text: string }[],
  mode: "small-model" | "standard" = "small-model"
): PromptDescriptor {
  const handlerHint = HANDLER_HINTS[handler] ? `\nHANDLER HINT:\n${HANDLER_HINTS[handler]}` : "";
  const modeHint =
    mode === "small-model"
      ? "\nMODEL MODE:\nAnswer briefly. Use only exact facts from CONTEXT. If data is missing, say so plainly."
      : "\nMODEL MODE:\nAnswer clearly and directly using provided CONTEXT.";

  const parts: string[] = [];
  if (liveContexts.length > 0) {
    parts.push(...liveContexts.map((c) => c.text));
  }
  if (ragContexts.length > 0) {
    parts.push(...ragContexts.map((c, i) => `[#${i + 1}] ${c.text}`));
  }

  const id = `rag.${handler}.${mode}`;
  const desc: PromptDescriptor = {
    id,
    version: "v1",
    mode,
    modelTarget: mode === "small-model" ? "small" : "any",
    maxTokens: mode === "small-model" ? 350 : 600,
    metadata: {
      owner: "chat-pipeline",
      purpose: `RAG prompt for handler=${handler} mode=${mode}`,
      lastUpdated: "2026-04-28",
      smallModelVariant: mode === "small-model",
    },
    systemPrompt: `${BASE_PERSONA}${modeHint}${handlerHint}\n\nCONTEXT:\n${
      parts.length > 0 ? parts.join("\n\n") : "(empty — no live data available right now)"
    }`,
  };
  register(desc);
  return desc;
}

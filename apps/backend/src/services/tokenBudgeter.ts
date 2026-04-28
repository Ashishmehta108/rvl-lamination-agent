import { config } from "../config.js";

export type BudgetMessage = { role: "system" | "user" | "assistant"; content: string };

export interface BudgetSources {
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  ragContexts: { text: string; chunkId: string; sourceUri?: string }[];
  liveContexts: { source: string; text: string }[];
}

export interface BudgetedSources {
  systemPrompt: string;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  ragContexts: { text: string; chunkId: string; sourceUri?: string }[];
  liveContexts: { source: string; text: string }[];
  estimatedTokens: number;
  budgetReport: BudgetReport;
}

/** Breakdown of how the token budget was allocated. Used by the trace store. */
export interface BudgetReport {
  totalBudget: number;
  systemPromptTokens: number;
  historyTokens: number;
  liveContextTokens: number;
  ragTokens: number;
  totalEstimated: number;
  trimmedSources: string[];
}

const AVG_CHARS_PER_TOKEN = 4;
const HISTORY_CHAR_LIMIT = 900;
const LIVE_CONTEXT_CHAR_LIMIT = 2600;
const RAG_CHAR_LIMIT = 1200;

/** Per-chunk cap for RAG — tight for small models. */
const RAG_CHUNK_MAX_CHARS = 300;
/** Max RAG chunks passed to the model in small-model mode. */
const RAG_MAX_CHUNKS = 2;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / AVG_CHARS_PER_TOKEN);
}

function compactText(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(0, maxChars - 1))}…`;
}

/**
 * Trims a single text block to fit within the remaining token budget.
 * Returns the trimmed text and whether it was cut.
 */
export function trimToFit(content: string, remainingBudgetChars: number): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (compact.length <= remainingBudgetChars) return compact;
  return `${compact.slice(0, Math.max(0, remainingBudgetChars - 1))}…`;
}

function trimHistory(history: Array<{ role: "user" | "assistant"; content: string }>) {
  let total = 0;
  const kept: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const item = history[i]!;
    const compact = compactText(item.content, 280);
    if (total + compact.length > HISTORY_CHAR_LIMIT && kept.length > 0) break;
    kept.push({ role: item.role, content: compact });
    total += compact.length;
  }
  return kept.reverse();
}

function trimLiveContexts(liveContexts: { source: string; text: string }[]) {
  let total = 0;
  const kept: { source: string; text: string }[] = [];
  for (const item of liveContexts) {
    const maxChars = item.source === "tags_db" || item.source === "tags_selected" ? 1200 : 700;
    const compact = compactText(item.text, maxChars);
    if (total + compact.length > LIVE_CONTEXT_CHAR_LIMIT && kept.length > 0) break;
    kept.push({ source: item.source, text: compact });
    total += compact.length;
  }
  return kept;
}

function trimRagContexts(ragContexts: { text: string; chunkId: string; sourceUri?: string }[]) {
  let total = 0;
  const kept: { text: string; chunkId: string; sourceUri?: string }[] = [];
  for (const item of ragContexts) {
    // 300-char cap per chunk (reduced from 320)
    const compact = compactText(item.text, RAG_CHUNK_MAX_CHARS);
    if (total + compact.length > RAG_CHAR_LIMIT && kept.length > 0) break;
    kept.push({ ...item, text: compact });
    total += compact.length;
  }
  // Top 2 chunks only in small-model mode — prevents RAG from crowding out live facts
  return kept.slice(0, config.llmSmallModelMode ? RAG_MAX_CHUNKS : 3);
}

export function applySmallModelBudget(sources: BudgetSources): BudgetedSources {
  const trimmedSources: string[] = [];
  const totalBudget = config.ollamaNumCtx * AVG_CHARS_PER_TOKEN; // approximate char budget

  const systemPrompt = compactText(sources.systemPrompt, 2200);
  if (sources.systemPrompt.length > 2200) trimmedSources.push("systemPrompt");

  const history = trimHistory(sources.history);
  if (history.length < sources.history.length) trimmedSources.push("history");

  const liveContexts = trimLiveContexts(sources.liveContexts);
  if (liveContexts.length < sources.liveContexts.length) trimmedSources.push("liveContexts");

  const ragContexts = trimRagContexts(sources.ragContexts);
  if (ragContexts.length < sources.ragContexts.length) trimmedSources.push("ragContexts");

  const systemPromptTokens = estimateTokens(systemPrompt);
  const historyTokens = history.reduce((sum, item) => sum + estimateTokens(item.content), 0);
  const liveContextTokens = liveContexts.reduce((sum, item) => sum + estimateTokens(item.text), 0);
  const ragTokens = ragContexts.reduce((sum, item) => sum + estimateTokens(item.text), 0);
  const estimatedTokens = systemPromptTokens + historyTokens + liveContextTokens + ragTokens;

  const budgetReport: BudgetReport = {
    totalBudget: Math.ceil(totalBudget / AVG_CHARS_PER_TOKEN),
    systemPromptTokens,
    historyTokens,
    liveContextTokens,
    ragTokens,
    totalEstimated: estimatedTokens,
    trimmedSources,
  };

  return { systemPrompt, history, liveContexts, ragContexts, estimatedTokens, budgetReport };
}

export function buildChatMessages(
  systemPrompt: string,
  history: Array<{ role: "user" | "assistant"; content: string }>
): BudgetMessage[] {
  return [{ role: "system", content: systemPrompt }, ...history];
}

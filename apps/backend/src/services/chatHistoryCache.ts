export type ChatHistoryRole = "user" | "assistant";

export interface ChatHistoryMessage {
  role: ChatHistoryRole;
  content: string;
  timestamp: number;
}

export interface ChatHistorySnapshot {
  sessionKey: string;
  machineId: string;
  updatedAt: number;
  messages: ChatHistoryMessage[];
}

export interface BuildSessionKeyInput {
  machineId: string;
  explicitSessionId?: string | null;
  authHeader?: string | null;
  ip?: string | null;
}

/**
 * Structured session state for intent continuity.
 * Continuity comes from these structured fields, NOT from replaying assistant text.
 * This is the primary defense against multi-turn context drift.
 */
export interface SessionState {
  currentMachineId: string | null;
  lastIntent: string | null;
  pendingClarification: string | null;
  lastUserTurnAt: number;
}

const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_STORED_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 600;        // Reduced from 1200 — prevents prompt bloat
const MAX_ASSISTANT_CHARS = 200;      // Assistant compressed to first sentence only
const MAX_ASSISTANT_MESSAGES_IN_WINDOW = 2;

const store = new Map<string, ChatHistorySnapshot>();
const sessionStateStore = new Map<string, SessionState>();

export function getSessionState(sessionKey: string): SessionState {
  return sessionStateStore.get(sessionKey) ?? {
    currentMachineId: null,
    lastIntent: null,
    pendingClarification: null,
    lastUserTurnAt: 0,
  };
}

export function setSessionState(sessionKey: string, state: Partial<SessionState>): void {
  const current = getSessionState(sessionKey);
  sessionStateStore.set(sessionKey, { ...current, ...state });
}

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_CHARS);
}

/**
 * Compresses an assistant message to its opening sentence only (~200 chars max).
 * Strips lists, tables, markdown formatting, and multi-paragraph content.
 *
 * WHY: Prior assistant answers must not become "evidence" in future turns.
 * A long answer from turn 2 replayed in turn 5 causes context drift and hallucination.
 * Only the first sentence (the direct answer) is kept for continuity.
 */
export function compressAssistantMessage(text: string): string {
  const stripped = text
    .replace(/\|.*\|/g, "")                        // remove table rows
    .replace(/\*\*([^*]+)\*\*/g, "$1")             // strip bold, keep text
    .replace(/_([^_]+)_/g, "$1")                   // strip italic, keep text
    .replace(/^[#*\-•>\d.]+\s*/gm, "")            // strip list/heading prefixes
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")       // strip markdown links, keep label
    .replace(/\n+/g, " ")                          // collapse newlines
    .replace(/\s+/g, " ")
    .trim();

  // Take only the first sentence (up to first . ! ?)
  const firstSentenceMatch = stripped.match(/^[^.!?]+[.!?]/);
  const firstSentence = firstSentenceMatch ? firstSentenceMatch[0] : stripped;
  return firstSentence.trim().slice(0, MAX_ASSISTANT_CHARS);
}

function hashSeed(seed: string): string {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h >>> 0).toString(36);
}

export function buildChatSessionKey(input: BuildSessionKeyInput): string {
  const machineId = (input.machineId || "lamination-01").trim().toLowerCase();
  const explicit = (input.explicitSessionId ?? "").trim();
  if (explicit) return `chat:${machineId}:session:${explicit.slice(0, 80)}`;
  const auth = (input.authHeader ?? "").trim();
  const ip = (input.ip ?? "").trim();
  const seed = auth ? auth.slice(0, 96) : `ip:${ip || "unknown"}`;
  return `chat:${machineId}:anon:${hashSeed(seed)}`;
}

export function getChatHistoryCached(sessionKey: string, now = Date.now()): ChatHistorySnapshot | null {
  const row = store.get(sessionKey);
  if (!row) return null;
  if (now - row.updatedAt > CACHE_TTL_MS) {
    store.delete(sessionKey);
    return null;
  }
  const validMessages = row.messages
    .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
    .map((m) => ({ role: m.role, content: normalizeText(m.content), timestamp: m.timestamp }))
    .filter((m) => m.content.length > 0);
  return { ...row, messages: validMessages };
}

export function putChatHistoryCached(
  sessionKey: string,
  machineId: string,
  messages: ChatHistoryMessage[],
  now = Date.now()
): ChatHistorySnapshot {
  const compact = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role,
      // Assistant messages are compressed to first sentence only.
      // This is the primary defense against multi-turn context drift.
      content: m.role === "assistant"
        ? compressAssistantMessage(m.content)
        : normalizeText(m.content),
      timestamp: Number.isFinite(m.timestamp) ? m.timestamp : now,
    }))
    .filter((m) => m.content.length > 0)
    .slice(-MAX_STORED_MESSAGES);

  const payload: ChatHistorySnapshot = {
    sessionKey,
    machineId,
    updatedAt: now,
    messages: compact,
  };
  store.set(sessionKey, payload);
  return payload;
}

export function mergeHistoryWithRequest(
  requestMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  cachedMessages: ChatHistoryMessage[],
  maxWindow = 12
): Array<{ role: "user" | "assistant"; content: string }> {
  const req = requestMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content: normalizeText(m.content),
    }))
    .filter((m) => m.content.length > 0);

  const prev = cachedMessages
    .map((m) => ({ role: m.role, content: normalizeText(m.content) }))
    .filter((m) => m.content.length > 0);

  const merged = [...prev, ...req];
  const deduped: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const m of merged) {
    const last = deduped[deduped.length - 1];
    if (last && last.role === m.role && last.content === m.content) continue;
    deduped.push(m);
  }

  const trimmed = deduped.slice(-Math.max(4, Math.min(24, maxWindow)));
  let assistantSeen = 0;
  const compact: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (let i = trimmed.length - 1; i >= 0; i -= 1) {
    const item = trimmed[i]!;
    if (item.role === "assistant") {
      assistantSeen += 1;
      if (assistantSeen > MAX_ASSISTANT_MESSAGES_IN_WINDOW) continue;
    }
    compact.push(item);
  }
  return compact.reverse();
}

export const CHAT_HISTORY_POLICY = {
  ttlMs: CACHE_TTL_MS,
  maxStoredMessages: MAX_STORED_MESSAGES,
  maxMessageChars: MAX_MESSAGE_CHARS,
  maxAssistantChars: MAX_ASSISTANT_CHARS,
  maxAssistantMessagesInWindow: MAX_ASSISTANT_MESSAGES_IN_WINDOW,
};

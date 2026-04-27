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

const CACHE_TTL_MS = 30 * 60 * 1000;
const MAX_STORED_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 1200;
const store = new Map<string, ChatHistorySnapshot>();

function normalizeText(input: string): string {
  return input.replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_CHARS);
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
      content: normalizeText(m.content),
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
  return deduped.slice(-Math.max(4, Math.min(24, maxWindow)));
}

export const CHAT_HISTORY_POLICY = {
  ttlMs: CACHE_TTL_MS,
  maxStoredMessages: MAX_STORED_MESSAGES,
  maxMessageChars: MAX_MESSAGE_CHARS,
};

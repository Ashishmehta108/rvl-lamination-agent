import type { ChatHistoryMessage } from "./chatHistoryCache.js";
import { compressAssistantMessage } from "./chatHistoryCache.js";

export interface MemoryPolicyInput {
  requestMessages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  cachedMessages: ChatHistoryMessage[];
}

export interface MemoryPolicyResult {
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  sessionState: {
    lastUserMessage: string | null;
    priorUserTurns: number;
    priorAssistantTurns: number;
  };
}

const MAX_USER_TURNS = 4;
const MAX_ASSISTANT_TURNS = 2;
const MAX_USER_MESSAGE_CHARS = 500;

function compactUserText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_USER_MESSAGE_CHARS);
}

export function buildMemoryWindow(input: MemoryPolicyInput): MemoryPolicyResult {
  const merged = [...input.cachedMessages, ...input.requestMessages]
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      // IMPORTANT: All assistant messages pass through compressAssistantMessage here
      // even if the cache already compressed them — belt-and-suspenders guard.
      // This ensures no long assistant answer ever reaches the model as context.
      content:
        m.role === "assistant"
          ? compressAssistantMessage(m.content)
          : compactUserText(m.content),
    }))
    .filter((m) => m.content.length > 0);

  const deduped: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (const item of merged) {
    const last = deduped[deduped.length - 1];
    if (last && last.role === item.role && last.content === item.content) continue;
    deduped.push(item);
  }

  let keptUsers = 0;
  let keptAssistants = 0;
  const selected: Array<{ role: "user" | "assistant"; content: string }> = [];
  for (let i = deduped.length - 1; i >= 0; i -= 1) {
    const item = deduped[i]!;
    if (item.role === "user") {
      if (keptUsers >= MAX_USER_TURNS) continue;
      keptUsers += 1;
      selected.push(item);
      continue;
    }
    if (keptAssistants >= MAX_ASSISTANT_TURNS) continue;
    keptAssistants += 1;
    selected.push(item);
  }

  const messages = selected.reverse();
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? null;

  return {
    messages,
    sessionState: {
      lastUserMessage: lastUser,
      priorUserTurns: keptUsers,
      priorAssistantTurns: keptAssistants,
    },
  };
}

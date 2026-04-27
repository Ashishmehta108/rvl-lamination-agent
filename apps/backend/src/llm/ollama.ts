import { Ollama } from "ollama";
import { config } from "../config.js";

export type LlmMessage = { role: "system" | "user" | "assistant"; content: string };

function withTimeout<T>(p: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${name}_timeout_after_${timeoutMs}ms`)), timeoutMs);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      }
    );
  });
}

export function getOllamaClient() {
  return new Ollama({ host: config.ollamaBaseUrl });
}

export async function ollamaPing(): Promise<boolean> {
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), Math.min(1500, config.llmTimeoutMs));
    const res = await fetch(`${config.ollamaBaseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(t);
    return res.ok;
  } catch {
    return false;
  }
}

export async function embedText(text: string): Promise<number[]> {
  const client = getOllamaClient();
  const res = await withTimeout(
    client.embeddings({
      model: config.embedModel,
      prompt: text
    }),
    config.llmTimeoutMs,
    "ollama_embed"
  );
  return res.embedding;
}

export async function chatOnce(messages: LlmMessage[]): Promise<string> {
  return chatOnceWithModel(messages, config.ollamaModel, {
    numCtx: config.ollamaNumCtx,
    temperature: config.ollamaTemperature,
    topP: config.ollamaTopP,
    repeatPenalty: config.ollamaRepeatPenalty
  });
}

export async function chatOnceWithModel(
  messages: LlmMessage[],
  model: string,
  options?: Partial<{
    numCtx: number;
    temperature: number;
    topP: number;
    repeatPenalty: number;
    timeoutMs: number;
  }>
): Promise<string> {
  const client = getOllamaClient();
  const numCtx = options?.numCtx ?? config.ollamaNumCtx;
  const temperature = options?.temperature ?? config.ollamaTemperature;
  const topP = options?.topP ?? config.ollamaTopP;
  const repeatPenalty = options?.repeatPenalty ?? config.ollamaRepeatPenalty;

  const out = await withTimeout(
    client.chat({
      model,
      messages,
      stream: false,
      options: {
        temperature,
        top_p: topP,
        repeat_penalty: repeatPenalty,
        num_ctx: numCtx
      },
      keep_alive: config.ollamaKeepAlive
    }),
    options?.timeoutMs ?? config.llmTimeoutMs,
    "ollama_chat"
  );
  return out.message.content;
}

let ollamaTagsCache: { at: number; names: string[] } | null = null;
const OLLAMA_TAGS_TTL_MS = 60_000;

/** Cached model names from Ollama /api/tags (for assistant "which models" questions only). */
export async function getCachedOllamaModelNames(): Promise<string[]> {
  const now = Date.now();
  if (ollamaTagsCache && now - ollamaTagsCache.at < OLLAMA_TAGS_TTL_MS) {
    return ollamaTagsCache.names;
  }
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${config.ollamaBaseUrl}/api/tags`, { signal: controller.signal });
    clearTimeout(t);
    if (!res.ok) {
      ollamaTagsCache = { at: now, names: [] };
      return [];
    }
    const body = (await res.json()) as { models?: { name?: string }[] };
    const names = (body.models ?? []).map((m) => m.name).filter((n): n is string => Boolean(n));
    ollamaTagsCache = { at: now, names };
    return names;
  } catch {
    ollamaTagsCache = { at: now, names: [] };
    return [];
  }
}


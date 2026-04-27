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
  const client = getOllamaClient();
  const out = await withTimeout(
    client.chat({
      model: config.ollamaModel,
      messages,
      stream: false,
      options: {
        temperature: config.ollamaTemperature,
        top_p: config.ollamaTopP,
        repeat_penalty: config.ollamaRepeatPenalty,
        num_ctx: config.ollamaNumCtx
      },
      keep_alive: config.ollamaKeepAlive
    }),
    config.llmTimeoutMs,
    "ollama_chat"
  );
  return out.message.content;
}


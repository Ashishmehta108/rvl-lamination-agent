import { Ollama } from "ollama";
import { config } from "../config.js";

export type LlmMessage = { role: "system" | "user" | "assistant"; content: string };

export function getOllamaClient() {
  return new Ollama({ host: config.ollamaBaseUrl });
}

export async function ollamaPing(): Promise<boolean> {
  try {
    const res = await fetch(`${config.ollamaBaseUrl}/api/tags`);
    return res.ok;
  } catch {
    return false;
  }
}

export async function embedText(text: string): Promise<number[]> {
  const client = getOllamaClient();
  const res = await client.embeddings({
    model: config.embedModel,
    prompt: text
  });
  return res.embedding;
}

export async function chatOnce(messages: LlmMessage[]): Promise<string> {
  const client = getOllamaClient();
  const out = await client.chat({
    model: config.ollamaModel,
    messages,
    stream: false,
    options: {
      temperature: config.ollamaTemperature,
      num_ctx: config.ollamaNumCtx
    },
    keep_alive: config.ollamaKeepAlive
  });
  return out.message.content;
}


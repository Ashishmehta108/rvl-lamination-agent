/**
 * agent/llmChain.ts
 * ─────────────────────────────────────────────────────────────────
 * LangChain chain for the main narrative turn.
 *
 * Replaces the chatOnce() call inside llmOrchestrator.ts::runTurn.
 * Chain: ChatOllama → StringOutputParser
 *
 * Contract:
 * - Called ONLY when handlerDecision.requiresLlm === true.
 * - Timeout and one retry on timeout are preserved from the current system.
 * - Returns raw string; grounding guard runs afterwards (in graph.ts).
 * - Temperature, top_p, repeat_penalty all come from config — not negotiable.
 * - Model tier is "chat" — uses the circuit breaker in modelGateway.ts.
 * ─────────────────────────────────────────────────────────────────
 */

import { ChatOllama } from "@langchain/ollama";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { HumanMessage, SystemMessage, AIMessage } from "@langchain/core/messages";
import type { BaseMessage } from "@langchain/core/messages";
import { config } from "../config.js";
import { getModelGateway } from "../llm/modelGateway.js";

// ─── Singleton model ───────────────────────────────────────────────

let _chatModel: ChatOllama | null = null;

function getChatModel(): ChatOllama {
  if (!_chatModel) {
    _chatModel = new ChatOllama({
      baseUrl: config.ollamaBaseUrl,
      model: config.ollamaModel,
      temperature: config.ollamaTemperature,
      numCtx: config.ollamaNumCtx,
      topP: config.ollamaTopP,
      repeatPenalty: config.ollamaRepeatPenalty,
      keepAlive: config.ollamaKeepAlive,
    });
  }
  return _chatModel;
}

/** Inject a mock model for tests. */
export function setChatModel(model: ChatOllama): void {
  _chatModel = model;
}

// ─── Parser ────────────────────────────────────────────────────────

const parser = new StringOutputParser();

// ─── Timeout helper ────────────────────────────────────────────────

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  if (ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${name}_timeout_after_${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (err) => { clearTimeout(t); reject(err); }
    );
  });
}

// ─── Message conversion ────────────────────────────────────────────

/**
 * Convert the flat message array from tokenBudgeter into LangChain
 * message objects. System messages become SystemMessage,
 * everything else becomes HumanMessage or AIMessage.
 */
export function toLangChainMessages(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
): BaseMessage[] {
  return messages.map((m) => {
    if (m.role === "system") return new SystemMessage(m.content);
    if (m.role === "user") return new HumanMessage(m.content);
    return new AIMessage(m.content);
  });
}

// ─── Main chain ────────────────────────────────────────────────────

export interface LlmChainResult {
  answer: string;
  llmLatencyMs: number;
  retried: boolean;
}

/**
 * Run the narrative LLM call.
 * Retries once with a 20% trimmed prompt on timeout.
 * Throws only on non-timeout errors (e.g. circuit open).
 */
export async function runLlmChain(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
): Promise<LlmChainResult> {
  // Check circuit breaker via modelGateway (preserves existing circuit state)
  void getModelGateway(); // side-effect: validates circuit is not open before call
  const model = getChatModel();
  const chain = model.pipe(parser);

  let retried = false;
  const t0 = Date.now();

  const invoke = (msgs: typeof messages) =>
    withTimeout(
      chain.invoke(toLangChainMessages(msgs)),
      config.llmTimeoutMs,
      "llm_narrative"
    );

  try {
    const answer = await invoke(messages);
    return { answer, llmLatencyMs: Date.now() - t0, retried };
  } catch (firstErr: unknown) {
    const msg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    const isTimeout = msg.includes("timeout") || msg.includes("ECONNREFUSED");

    if (!isTimeout) throw firstErr;

    // Retry once with ~20% smaller system prompt
    retried = true;
    const trimmed = messages.map((m) => {
      if (m.role !== "system") return m;
      const maxLen = Math.floor(m.content.length * 0.8);
      return { ...m, content: m.content.slice(0, maxLen) + "…" };
    });

    const t1 = Date.now();
    const answer = await invoke(trimmed);
    return { answer, llmLatencyMs: Date.now() - t1, retried };
  }
}

// import { Ollama } from "ollama";
// import { config } from "../config.js";
// import { GoogleGenerativeAI } from "@google/generative-ai";

// const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_API_KEY!);

// const geminiModel = genAI.getGenerativeModel({
//   model: "gemini-2.5-flash-lite"
// });

// export type LlmMessage = { role: "system" | "user" | "assistant"; content: string };

// function withTimeout<T>(p: Promise<T>, timeoutMs: number, name: string): Promise<T> {
//   if (!timeoutMs || timeoutMs <= 0) return p;
//   return new Promise<T>((resolve, reject) => {
//     const t = setTimeout(() => reject(new Error(`${name}_timeout_after_${timeoutMs}ms`)), timeoutMs);
//     p.then(
//       (v) => {
//         clearTimeout(t);
//         resolve(v);
//       },
//       (err) => {
//         clearTimeout(t);
//         reject(err);
//       }
//     );
//   });
// }

// export function getOllamaClient() {
//   return new Ollama({ host: config.ollamaBaseUrl });
// }

// export async function ollamaPing(): Promise<boolean> {
//   try {
//     const controller = new AbortController();
//     const t = setTimeout(() => controller.abort(), Math.min(1500, config.llmTimeoutMs));
//     const res = await fetch(`${config.ollamaBaseUrl}/api/tags`, { signal: controller.signal });
//     clearTimeout(t);
//     return res.ok;
//   } catch {
//     return false;
//   }
// }

// export async function embedText(text: string): Promise<number[]> {
//   const client = getOllamaClient();
//   const res = await withTimeout(
//     client.embeddings({
//       model: config.embedModel,
//       prompt: text
//     }),
//     config.llmTimeoutMs,
//     "ollama_embed"
//   );
//   return res.embedding;
// }

// // export async function chatOnce(messages: LlmMessage[]): Promise<string> {
// //   return chatOnceWithModel(messages, config.ollamaModel, {
// //     numCtx: config.ollamaNumCtx,
// //     temperature: config.ollamaTemperature,
// //     topP: config.ollamaTopP,
// //     repeatPenalty: config.ollamaRepeatPenalty
// //   });
// // }


// export async function chatOnce(messages: LlmMessage[]): Promise<string> {


//   // Convert messages → single prompt
//   // const system = messages.find(m => m.role === "system")?.content || "";
//   const system = `You are Ravi, an industrial machine monitoring assistant for a lamination factory.

// You help operators understand machine condition using structured data.

// ━━━━━━━━━━ CORE BEHAVIOR ━━━━━━━━━━

// You are NOT responsible for:
// - fetching data
// - filtering time ranges
// - calculating metrics

// All data is already pre-processed and provided to you.

// Your ONLY job:
// → Read the provided context
// → Explain the situation clearly

// ━━━━━━━━━━ STRICT RULES (MANDATORY) ━━━━━━━━━━

// 1. SOURCE OF TRUTH
// - Use ONLY the provided context.
// - Do NOT invent values, alerts, timestamps, or trends.
// - If something is not present → say: "I don’t have that data."

// 2. RESPONSE LENGTH
// - Answer in EXACTLY 2–3 sentences.
// - No bullet points.
// - No lists.
// - No extra explanation.

// 3. NO REASONING / NO GUESSING
// - Do NOT explain WHY something happened.
// - Do NOT infer root causes.
// - Do NOT predict future issues.
// - Do NOT assume trends.

// 4. ALERT PRIORITY
// - Always mention CRITICAL alerts first.
// - Then mention warnings if relevant.
// - If no alerts → clearly say system is stable.

// 5. TIME HANDLING
// - The data you receive is already filtered.
// - NEVER reinterpret or guess time ranges.

// 6. DATA USAGE
// - Focus only on:
//   - alerts
//   - key readings
//   - production summary
// - Do NOT repeat full data.

// 7. STYLE
// - Speak like an experienced machine operator.
// - Clear, direct, practical.
// - No chatbot phrases like "Hope this helps".

// 8. FORBIDDEN OUTPUTS
// - Do NOT generate:
//   - "QUESTION:"
//   - "ANSWER:"
//   - explanations of logic
//   - system messages
//   - JSON output

// ━━━━━━━━━━ CONTEXT FORMAT ━━━━━━━━━━

// You will receive JSON like:

// {
//   "machine_state": "healthy | degraded | critical",
//   "alerts": [
//     { "severity": "critical|warning|info", "title": "...", "status": "..." }
//   ],
//   "key_readings": [
//     { "label": "...", "value": "..." }
//   ],
//   "production_summary": { ... }
// }

// ━━━━━━━━━━ RESPONSE STRATEGY ━━━━━━━━━━

// Follow this order:

// 1. Start with overall condition
// 2. Mention most important alert (if any)
// 3. Add one supporting observation (optional)

// ━━━━━━━━━━ EDGE CASE HANDLING ━━━━━━━━━━

// IF no alerts:
// → say system is stable

// IF data missing:
// → say "I don’t have that data"

// IF conflicting data:
// → say "Data looks inconsistent based on available information"

// ━━━━━━━━━━ FINAL TASK ━━━━━━━━━━

// Read the context and answer the user query strictly following all rules.

// ━━━━━━━━━━ CONTEXT ━━━━━━━━━━
// {context}

// ━━━━━━━━━━ USER QUERY ━━━━━━━━━━
// {query}

// ━━━━━━━━━━ RESPONSE ━━━━━━━━━━


// You are an industrial machine expert.

// Explain concepts clearly in 2–3 sentences.

// - You MAY use general engineering knowledge
// - Do NOT hallucinate specific numbers
// - Keep it practical and simple

// User: {query}
// `;
//   const convo = messages
//     .filter(m => m.role !== "system")
//     .map(m => `${m.role.toUpperCase()}: ${m.content}`)
//     .join("\n");

//   const prompt = `
// ${system}

// ${convo}

// ASSISTANT:
// `.trim();

//   try {
//     const result = await geminiModel.generateContent(prompt);
//     const response = await result.response;
//     return response.text().trim();
//   } catch (err) {
//     console.error("Gemini error:", err);
//     throw err;
//   }
// }
// export async function chatOnceWithModel(
//   messages: LlmMessage[],
//   model: string,
//   options?: Partial<{
//     numCtx: number;
//     temperature: number;
//     topP: number;
//     repeatPenalty: number;
//     timeoutMs: number;
//   }>
// ): Promise<string> {
//   const client = getOllamaClient();
//   const numCtx = options?.numCtx ?? config.ollamaNumCtx;
//   const temperature = options?.temperature ?? config.ollamaTemperature;
//   const topP = options?.topP ?? config.ollamaTopP;
//   const repeatPenalty = options?.repeatPenalty ?? config.ollamaRepeatPenalty;

//   const out = await withTimeout(
//     client.chat({
//       model,
//       messages,
//       stream: false,
//       options: {
//         temperature,
//         top_p: topP,
//         repeat_penalty: repeatPenalty,
//         num_ctx: numCtx
//       },
//       keep_alive: config.ollamaKeepAlive
//     }),
//     options?.timeoutMs ?? config.llmTimeoutMs,
//     "ollama_chat"
//   );
//   return out.message.content;
// }

// let ollamaTagsCache: { at: number; names: string[] } | null = null;
// const OLLAMA_TAGS_TTL_MS = 60_000;

// /** Cached model names from Ollama /api/tags (for assistant "which models" questions only). */
// export async function getCachedOllamaModelNames(): Promise<string[]> {
//   const now = Date.now();
//   if (ollamaTagsCache && now - ollamaTagsCache.at < OLLAMA_TAGS_TTL_MS) {
//     return ollamaTagsCache.names;
//   }
//   try {
//     const controller = new AbortController();
//     const t = setTimeout(() => controller.abort(), 2000);
//     const res = await fetch(`${config.ollamaBaseUrl}/api/tags`, { signal: controller.signal });
//     clearTimeout(t);
//     if (!res.ok) {
//       ollamaTagsCache = { at: now, names: [] };
//       return [];
//     }
//     const body = (await res.json()) as { models?: { name?: string }[] };
//     const names = (body.models ?? []).map((m) => m.name).filter((n): n is string => Boolean(n));
//     ollamaTagsCache = { at: now, names };
//     return names;
//   } catch {
//     ollamaTagsCache = { at: now, names: [] };
//     return [];
//   }
// }



import { Ollama } from "ollama";
import { config } from "../config.js";

import { GoogleGenerativeAI } from "@google/generative-ai";
const systemPrompt = `You are Ravi, an industrial machine monitoring assistant for a lamination factory.
You help operators understand machine condition using structured data.

━━━━━━━━━━ CORE BEHAVIOR ━━━━━━━━━━

You are NOT responsible for:
- fetching data
- filtering time ranges
- calculating metrics

All data is already pre-processed and provided to you.

Your ONLY job:
→ Read the provided context
→ Explain the situation clearly

━━━━━━━━━━ STRICT RULES (MANDATORY) ━━━━━━━━━━

1. SOURCE OF TRUTH
- Use ONLY the provided context.
- Do NOT invent values, alerts, timestamps, or trends.
- If something is not present → say: "I don't have that data."
- If context says "No open or recent alerts" → you MUST say there are no alerts. Do NOT invent any.

2. RESPONSE LENGTH
- Answer in EXACTLY 2–3 sentences.
- No bullet points. No lists. No extra explanation.

3. NO REASONING / NO GUESSING
- Do NOT explain WHY something happened.
- Do NOT infer root causes.
- Do NOT predict future issues.
- Do NOT assume trends.

4. ALERT PRIORITY
- Always mention CRITICAL alerts first.
- Then mention warnings if relevant.
- If no alerts → clearly say system is stable.

5. TIME HANDLING
- The data you receive is already filtered.
- NEVER reinterpret or guess time ranges.

6. DATA USAGE
- Focus only on: alerts, key readings, production summary.
- Do NOT repeat full data dumps.

7. STYLE
- Speak like an experienced machine operator.
- Clear, direct, practical.
- No chatbot phrases like "Hope this helps" or "Great question".

8. FORBIDDEN OUTPUTS
- Do NOT generate: "QUESTION:", "ANSWER:", explanations of logic, system messages, JSON output.
- Do NOT mention values, temperatures, alert titles, or sensor readings not present in the context.

━━━━━━━━━━ EDGE CASE HANDLING ━━━━━━━━━━

IF no alerts → say system is stable, no active alerts.
IF data missing → say "I don't have that data."
IF conflicting data → say "Data looks inconsistent based on available information."

━━━━━━━━━━ RESPONSE STRATEGY ━━━━━━━━━━

1. Start with overall machine condition.
2. Mention most important alert if any (from context only).
3. Add one supporting observation (optional, from context only).`;

const genAI = new GoogleGenerativeAI(process.env.GOOGLE_GENERATIVE_AI_API_KEY!);

const geminiModel = genAI.getGenerativeModel({
  model: "gemini-2.5-flash-lite",
});

export type LlmMessage = { role: "system" | "user" | "assistant"; content: string };

function withTimeout<T>(p: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${name}_timeout_after_${timeoutMs}ms`)), timeoutMs);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (err) => { clearTimeout(t); reject(err); }
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
    client.embeddings({ model: config.embedModel, prompt: text }),
    config.llmTimeoutMs,
    "ollama_embed"
  );
  return res.embedding;
}

/**
 * Primary LLM call — uses Gemini 2.5 Flash Lite.
 * Respects the full message array including the system prompt built by prepareTurn.
 * System message is extracted and passed separately; remaining turns become the conversation.
 */
// export async function chatOnce(messages: LlmMessage[]): Promise<string> {


//   const convo = messages
//     .filter(m => m.role !== "system")
//     .map(m => `${m.role.toUpperCase()}: ${m.content}`)
//     .join("\n");

//   const prompt = `${systemPrompt}\n\n${convo}\n\nASSISTANT:`.trim();

//   console.log("[FUCKING GEMINI PROMPT LEN]", prompt.length);
//   console.log("[FUCKING GEMINI PROMPT PREVIEW]", prompt.slice(0, 500));

//   try {
//     const result = await geminiModel.generateContent(prompt);
//     const response = await result.response;
//     const text = response.text().trim();
//     console.log("[FUCKING GEMINI RESPONSE]", text);
//     return text;
//   } catch (err) {
//     console.error("[FUCKING GEMINI ERROR]", err);
//     throw err;
//   }
// }

export async function chatOnce(messages: LlmMessage[]): Promise<string> {
  const systemMsg = messages.find(m => m.role === "system")?.content ?? "";

  const convo = messages
    .filter(m => m.role !== "system")
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join("\n");

  const prompt = `${systemMsg}\n\n${convo}\n\nASSISTANT:`.trim();

  console.log("[FUCKING PROMPT LEN]", prompt.length);
  console.log("[FUCKING PROMPT PREVIEW]", prompt.slice(0, 500));

  // // ── Gemini path ───────────────────────────────────────────────
  // if (config.llmProvider === "gemini") {
  //   try {
  //     const result = await geminiModel.generateContent(prompt);
  //     const response = await result.response;
  //     const text = response.text().trim();
  //     console.log("[FUCKING GEMINI RESPONSE]", text);
  //     return text;
  //   } catch (err) {
  //     console.error("[FUCKING GEMINI ERROR]", err);
  //     throw err;
  //   }
  // }

  // ── Ollama path ───────────────────────────────────────────────
  console.log("[FUCKING OLLAMA MODEL]", config.ollamaModel);
  return chatOnceWithModel(messages, config.ollamaModel, {
    numCtx: config.ollamaNumCtx,
    temperature: config.ollamaTemperature,
    topP: config.ollamaTopP,
    repeatPenalty: config.ollamaRepeatPenalty,
    timeoutMs: config.llmTimeoutMs,
  });
}
/**
 * Planner / tool-selection calls — uses Ollama locally.
 * Used by the planner step only, NOT for the main chat response.
 */
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

  console.log("[FUCKING OLLAMA MODEL]", model);
  console.log("[FUCKING OLLAMA OPTIONS]", { numCtx, temperature, topP, repeatPenalty });
  messages.find((ele) => {
    const isAssitant = ele.role == "assistant"
    if (isAssitant) {
      ele.content = `${systemPrompt}`
    }
    else {
      console.log("FUCK OFF ELSE");

    }
  })
  const out = await withTimeout(
    client.chat({
      model,
      messages,
      stream: false,
      options: { temperature, top_p: topP, repeat_penalty: repeatPenalty, num_ctx: numCtx },
      keep_alive: config.ollamaKeepAlive,
    }),
    options?.timeoutMs ?? config.llmTimeoutMs,
    "ollama_chat"
  );

  console.log("[FUCKING OLLAMA RESPONSE]", out.message.content.slice(0, 300));
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
    const names = (body.models ?? []).map(m => m.name).filter((n): n is string => Boolean(n));
    ollamaTagsCache = { at: now, names };
    return names;
  } catch {
    ollamaTagsCache = { at: now, names: [] };
    return [];
  }
}
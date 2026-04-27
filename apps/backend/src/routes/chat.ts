import type { FastifyInstance } from "fastify";
import { ChatRequestSchema } from "@rvl/shared";
import { requireApiAuth, validateMachineAccess } from "../auth.js";
import { ragQuery } from "../rag/store.js";
import { chatOnce } from "../llm/ollama.js";
import { config } from "../config.js";
import { fetchLiveContext } from "./chatContext.js";

/* ────────────────────────────────────────────────────────────────
   Anti-hallucination system prompt for small LLMs (1-4B params).
   Key techniques:
     1. Strict grounding — answer ONLY from provided context
     2. Mandatory "I don't know" fallback when context is absent
     3. Citation requirement — reference [#N] for every claim
     4. Chain-of-thought suppression — keep answers short & factual
     5. No speculation / no extrapolation rule
   ──────────────────────────────────────────────────────────────── */

const GROUNDED_SYSTEM_PREAMBLE = `You are a helpful assistant for an industrial lamination machine. Follow these rules:

RULE 0 — CONVERSATION: For greetings (e.g. "hello", "hi", "thanks"), general conversation, or clarifying questions, respond naturally and helpfully. Introduce yourself as the RVL Lamination Assistant. The grounding rules below apply ONLY when the user asks about machine data, tags, alerts, or operational information.

RULE 1 — GROUNDING: When answering questions about the machine, tags, alerts, or operational data, you may ONLY use information found in the "CONTEXT" section below. Do NOT use your training knowledge for machine-specific data.

RULE 2 — CITATIONS: For every machine-related fact you state, cite the source using [#N] notation matching the context snippet number.

RULE 3 — REFUSAL: If the user asks a machine/data question but the CONTEXT does not contain the answer, say: "I don't have that information in the available data. Could you try a different query or check the machine ID?"
Do NOT guess. Do NOT make up data.

RULE 4 — BREVITY: Keep answers concise and factual.

RULE 5 — FORMAT: Use short paragraphs or bullet points for data answers.`;

const NO_CONTEXT_INSTRUCTION = `\n\nCONTEXT:\nNo relevant documents were found. If the user is asking about machine data, tell them you don't have data for their question. If they are just greeting you or asking a general question, respond naturally.`;

function buildSystemPrompt(
  ragContexts: { text: string; chunkId: string; sourceUri?: string }[],
  liveContexts: { source: string; text: string }[]
): string {
  const hasAny = ragContexts.length > 0 || liveContexts.length > 0;
  if (!hasAny) {
    return GROUNDED_SYSTEM_PREAMBLE + NO_CONTEXT_INSTRUCTION;
  }

  const parts: string[] = [];

  // Live data first (most relevant for real-time questions)
  if (liveContexts.length > 0) {
    parts.push("--- LIVE DATA (from database) ---");
    parts.push(...liveContexts.map(c => c.text));
  }

  // RAG documents second
  if (ragContexts.length > 0) {
    parts.push("--- DOCUMENTS ---");
    parts.push(...ragContexts.map((c, i) => `[#${i + 1}] ${c.text}`));
  }

  return `${GROUNDED_SYSTEM_PREAMBLE}

CONTEXT:
${parts.join("\n\n")}

Remember: ONLY use the information above. If the answer is not in the CONTEXT, say you don't have that information.`;
}

export async function registerChatRoutes(app: FastifyInstance) {
  app.post("/chat", async (req, reply) => {
    const t0 = Date.now();
    requireApiAuth(req);
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      app.log.warn({ issues: parsed.error.issues }, "chat_validation_failed");
      return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    }

    const reqBody = parsed.data;
    app.log.info({
      machineId: reqBody.machineId ?? "(none)",
      messageCount: reqBody.messages.length,
      tagIds: reqBody.tagIds ?? []
    }, "chat_request_received");

    if (reqBody.machineId) {
      validateMachineAccess(reqBody.machineId);
    }
    const lastUser = [...reqBody.messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return reply.code(400).send({ error: "no_user_message" });

    app.log.info({ query: lastUser.content.slice(0, 120) }, "chat_user_query");

    // Fetch RAG + live data in parallel
    const tFetch = Date.now();
    const machineId = reqBody.machineId || "lamination-01";

    const [ragContexts, liveContexts] = await Promise.all([
      ragQuery({
        query: lastUser.content,
        machineId: reqBody.machineId,
        tagIds: reqBody.tagIds,
        topK: config.ragTopK
      }).catch((err) => {
        app.log.warn({ err: String(err) }, "rag_query_failed");
        return [];
      }),
      fetchLiveContext(lastUser.content, machineId).catch((err) => {
        app.log.warn({ err: String(err) }, "live_context_failed");
        return [];
      })
    ]);
    const fetchMs = Date.now() - tFetch;

    app.log.info({
      fetchMs,
      ragChunks: ragContexts.length,
      liveSources: liveContexts.map(c => c.source),
      livePreview: liveContexts.map(c => c.text.slice(0, 100))
    }, "context_retrieval_done");

    const hasContext = ragContexts.length > 0 || liveContexts.length > 0;
    const system = buildSystemPrompt(ragContexts, liveContexts);

    // Trim chat history: keep last 8 messages (smaller window for small models)
    const messages = reqBody.messages
      .filter((m) => m.role !== "system")
      .slice(-8);

    app.log.info({
      model: config.ollamaModel,
      historyMsgs: messages.length,
      systemPromptLen: system.length,
      hasContext
    }, "llm_request_starting");

    let answer: string;
    const tLlm = Date.now();
    try {
      answer = await chatOnce([{ role: "system", content: system }, ...messages]);
    } catch (err) {
      app.log.error({ err: String(err), llmMs: Date.now() - tLlm }, "llm_chat_failed");
      return reply.code(503).send({ error: "llm_unavailable" });
    }
    const llmMs = Date.now() - tLlm;

    const grounded = hasContext;

    app.log.info({
      llmMs,
      totalMs: Date.now() - t0,
      answerLen: answer.length,
      answerPreview: answer.slice(0, 150),
      grounded,
      ragCitations: ragContexts.length,
      liveSources: liveContexts.map(c => c.source)
    }, "chat_response_ready");

    // Build steps metadata for the UI
    const steps: { tool: string; label: string; durationMs: number }[] = [];
    if (ragContexts.length > 0) {
      steps.push({ tool: "rag_search", label: `Searched ${ragContexts.length} documents`, durationMs: fetchMs });
    }
    for (const lc of liveContexts) {
      const label = lc.source === "alerts_db" ? "Queried alerts database"
        : lc.source === "tags_db" ? "Fetched live tag values"
        : lc.source === "reports_db" ? "Loaded report history"
        : `Queried ${lc.source}`;
      steps.push({ tool: lc.source, label, durationMs: fetchMs });
    }
    steps.push({ tool: "llm", label: `Generated response (${config.ollamaModel})`, durationMs: llmMs });

    return reply.send({
      answer,
      grounded,
      steps,
      citations: ragContexts.map((c, i) => ({ index: i + 1, chunkId: c.chunkId, sourceUri: c.sourceUri ?? null }))
    });
  });
}

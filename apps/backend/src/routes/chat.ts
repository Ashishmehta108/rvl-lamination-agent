import type { FastifyInstance } from "fastify";
import { ChatRequestSchema } from "@rvl/shared";
import { requireApiAuth } from "../auth.js";
import { ragQuery } from "../rag/store.js";
import { chatOnce } from "../llm/ollama.js";
import { config } from "../config.js";

export async function registerChatRoutes(app: FastifyInstance) {
  app.post("/chat", async (req, reply) => {
    requireApiAuth(req);
    const parsed = ChatRequestSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });

    const reqBody = parsed.data;
    const lastUser = [...reqBody.messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return reply.code(400).send({ error: "no_user_message" });

    // RAG: keep context small for low RAM usage
    const contexts = await ragQuery({
      query: lastUser.content,
      machineId: reqBody.machineId,
      tagIds: reqBody.tagIds,
      topK: config.ragTopK
    }).catch((err) => {
      app.log.warn({ err: String(err) }, "rag_query_failed");
      return [];
    });

    const contextText =
      contexts.length === 0
        ? "No local documents matched."
        : contexts.map((c, i) => `[#${i + 1}] ${c.text}`).join("\n\n");

    const system = [
      "You are a production industrial assistant for a lamination machine.",
      "Be concise, accurate, and use the provided context snippets when relevant.",
      "If you are unsure, say you are unsure and ask for the missing information.",
      "",
      "Context snippets:",
      contextText
    ].join("\n");

    // Trim chat history: keep last 12 messages max to stay within ctx
    const messages = reqBody.messages.slice(-12);
    let answer: string;
    try {
      answer = await chatOnce([{ role: "system", content: system }, ...messages]);
    } catch (err) {
      app.log.error({ err: String(err) }, "llm_chat_failed");
      return reply.code(503).send({ error: "llm_unavailable" });
    }

    return reply.send({
      answer,
      citations: contexts.map((c, i) => ({ index: i + 1, chunkId: c.chunkId, sourceUri: c.sourceUri ?? null }))
    });
  });
}


import { z } from "zod";

const messageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1)
});

export const postChatBodySchema = z
  .object({
    sessionId: z.string().min(1).optional(),
    machineId: z.string().min(1).default("lamination-01"),
    message: z.string().min(1).optional(),
    messages: z.array(messageSchema).min(1).optional()
  })
  .refine((body) => Boolean(body.message?.trim()) || Boolean(body.messages?.length), {
    message: "message_or_messages_required"
  });

export const chatSessionsQuerySchema = z.object({
  machineId: z.string().min(1).default("lamination-01"),
  limit: z.coerce.number().int().min(1).max(50).default(10)
});

export const chatMessagesParamsSchema = z.object({
  sessionId: z.string().min(1)
});

export const chatMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  before: z.string().min(1).optional()
});

export const deleteChatSessionParamsSchema = z.object({
  sessionId: z.string().min(1)
});

export type PostChatBody = z.infer<typeof postChatBodySchema>;
export type ChatSessionsQuery = z.infer<typeof chatSessionsQuerySchema>;
export type ChatMessagesParams = z.infer<typeof chatMessagesParamsSchema>;
export type ChatMessagesQuery = z.infer<typeof chatMessagesQuerySchema>;
export type DeleteChatSessionParams = z.infer<typeof deleteChatSessionParamsSchema>;

const errorResponse = {
  type: "object",
  properties: {
    error: { type: "string" },
    detail: {},
    retryAfter: { type: "number" }
  },
  additionalProperties: true
} as const;

export const postChatFastifySchema = {
  body: {
    type: "object",
    properties: {
      sessionId: { type: "string" },
      machineId: { type: "string", default: "lamination-01" },
      message: { type: "string" },
      messages: {
        type: "array",
        items: {
          type: "object",
          required: ["role", "content"],
          properties: {
            role: { type: "string", enum: ["system", "user", "assistant"] },
            content: { type: "string" }
          }
        }
      }
    },
    additionalProperties: true
  },
  response: {
    200: {
      type: "object",
      required: ["sessionId", "messageId", "reply", "toolsUsed"],
      properties: {
        sessionId: { type: "string" },
        messageId: { type: "string" },
        reply: { type: "string" },
        answer: { type: "string" },
        toolsUsed: { type: "array", items: { type: "string" } },
        tokenCount: { type: "number" },
        citations: { type: "array" },
        grounded: { type: "boolean" },
        steps: { type: "array" },
        plan: { type: "object", additionalProperties: true },
        trace: { type: "object", additionalProperties: true },
        queryClass: { type: "string" },
        reflectionNote: { type: "string", nullable: true },
        reflectionSeverity: { type: "string" },
        charts: { type: "array" },
        contextBlocks: { type: "array" },
        liveTagCount: { type: "number" },
        findCandidates: { type: "array" }
      },
      additionalProperties: true
    },
    400: errorResponse,
    404: errorResponse,
    500: errorResponse,
    503: errorResponse
  }
} as const;

export const getChatSessionsFastifySchema = {
  querystring: {
    type: "object",
    properties: {
      machineId: { type: "string", default: "lamination-01" },
      limit: { type: "number", default: 10 }
    }
  }
} as const;

export const getChatMessagesFastifySchema = {
  params: {
    type: "object",
    required: ["sessionId"],
    properties: { sessionId: { type: "string" } }
  },
  querystring: {
    type: "object",
    properties: {
      limit: { type: "number", default: 50 },
      before: { type: "string" }
    }
  }
} as const;

export const deleteChatSessionFastifySchema = {
  params: {
    type: "object",
    required: ["sessionId"],
    properties: { sessionId: { type: "string" } }
  }
} as const;

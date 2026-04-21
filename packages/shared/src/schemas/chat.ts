import { z } from "zod";

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string()
});

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export const ChatRequestSchema = z.object({
  machineId: z.string().optional(),
  tagIds: z.array(z.string()).optional(),
  messages: z.array(ChatMessageSchema).min(1)
});

export type ChatRequest = z.infer<typeof ChatRequestSchema>;


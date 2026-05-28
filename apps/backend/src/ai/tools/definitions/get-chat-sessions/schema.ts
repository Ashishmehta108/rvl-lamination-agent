import { z } from "zod";

export const getChatSessionsSchema = z.object({
  limit: z.number().optional(),
  machineId: z.string().optional(),
});

export type GetChatSessionsArgs = z.infer<typeof getChatSessionsSchema>;

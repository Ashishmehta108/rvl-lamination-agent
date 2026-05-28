import { z } from "zod";

export const getTagHistorySchema = z.object({
  tag: z.string({ required_error: "tag name or slug is required" }),
  machineId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().optional()
});

export type GetTagHistoryArgs = z.infer<typeof getTagHistorySchema>;

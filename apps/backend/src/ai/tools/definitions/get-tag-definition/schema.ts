import { z } from "zod";

export const getTagDefinitionSchema = z.object({
  tag: z.string({ required_error: "tag name or slug is required" }),
  machineId: z.string().optional()
});

export type GetTagDefinitionArgs = z.infer<typeof getTagDefinitionSchema>;

import { z } from "zod";

export const searchTagsSchema = z.object({
  query: z.string().min(1),
  machineId: z.string().optional()
});

export type SearchTagsArgs = z.infer<typeof searchTagsSchema>;

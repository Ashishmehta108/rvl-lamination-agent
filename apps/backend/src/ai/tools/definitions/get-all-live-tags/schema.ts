import { z } from "zod";

export const getAllLiveTagsSchema = z.object({
  machineId: z.string().optional()
});

export type GetAllLiveTagsArgs = z.infer<typeof getAllLiveTagsSchema>;

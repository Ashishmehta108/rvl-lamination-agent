import { z } from "zod";

export const getLiveTagValuesSchema = z.object({
  tags: z.array(z.string()).min(1, "At least one tag is required"),
  machineId: z.string().optional()
});

export type GetLiveTagValuesArgs = z.infer<typeof getLiveTagValuesSchema>;

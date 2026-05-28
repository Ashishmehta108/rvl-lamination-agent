import { z } from "zod";

export const getTagComparisonSchema = z.object({
  tags: z.array(z.string()).min(2, "At least 2 tags required"),
  from: z.string().optional(),
  to: z.string().optional(),
  limit: z.number().optional(),
  machineId: z.string().optional(),
});

export type GetTagComparisonArgs = z.infer<typeof getTagComparisonSchema>;

import { z } from "zod";

export const getProductionSummarySchema = z.object({
  machineId: z.string().optional()
});

export type GetProductionSummaryArgs = z.infer<typeof getProductionSummarySchema>;

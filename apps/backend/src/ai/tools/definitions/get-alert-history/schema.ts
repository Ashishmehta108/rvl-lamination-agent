import { z } from "zod";

export const getAlertHistorySchema = z.object({
  machineId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  severity: z.enum(["info", "warning", "critical", "all"]).optional(),
  tagSlug: z.string().optional(),
  limit: z.number().optional(),
  includeSampleDerivedThresholds: z.boolean().optional()
});

export type GetAlertHistoryArgs = z.infer<typeof getAlertHistorySchema>;

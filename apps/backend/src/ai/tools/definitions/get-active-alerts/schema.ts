import { z } from "zod";

export const getActiveAlertsSchema = z.object({
  machineId: z.string().optional(),
  status: z.enum(["open", "acknowledged", "resolved", "all"]).optional(),
  severity: z.enum(["info", "warning", "critical", "all"]).optional(),
  limit: z.number().optional()
});

export type GetActiveAlertsArgs = z.infer<typeof getActiveAlertsSchema>;

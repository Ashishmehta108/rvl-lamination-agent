import { z } from "zod";

export const acknowledgeAlertSchema = z.object({
  alertEventId: z.string().min(1),
  actor: z.string().optional(),
  note: z.string().optional(),
});

export type AcknowledgeAlertArgs = z.infer<typeof acknowledgeAlertSchema>;

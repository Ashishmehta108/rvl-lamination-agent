import { z } from "zod";
import type { AlertStatus, Severity } from "../types.js";

export const SeveritySchema = z.custom<Severity>((v) =>
  v === "info" || v === "warning" || v === "critical"
);

export const AlertStatusSchema = z.custom<AlertStatus>((v) =>
  v === "open" || v === "acknowledged" || v === "resolved"
);

export const AlertEventSchema = z.object({
  id: z.string(),
  machineId: z.string(),
  ruleId: z.string().nullable().optional(),
  severity: SeveritySchema,
  status: AlertStatusSchema,
  title: z.string(),
  description: z.string().nullable().optional(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().nullable().optional(),
  payload: z.record(z.any()).optional()
});

export type AlertEvent = z.infer<typeof AlertEventSchema>;


import { z } from "zod";
import type { ReportFormat } from "../types.js";

export const ReportFormatSchema = z.custom<ReportFormat>((v) => v === "html" || v === "json");

export const ReportTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable().optional(),
  format: ReportFormatSchema,
  definition: z.record(z.any())
});

export type ReportTemplate = z.infer<typeof ReportTemplateSchema>;


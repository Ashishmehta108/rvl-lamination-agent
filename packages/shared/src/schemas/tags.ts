import { z } from "zod";

export const TagDefinitionSchema = z.object({
  tagId: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  unit: z.string().optional(),
  dataType: z.enum(["number", "boolean", "string"]).default("number"),
  deadband: z.number().nonnegative().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  maxRatePerSec: z.number().nonnegative().optional(),
  sampleEveryMs: z.number().int().positive().optional(),
  staleAfterMs: z.number().int().positive().optional(),
  warnHigh: z.number().optional(),
  warnLow: z.number().optional(),
  alarmHigh: z.number().optional(),
  alarmLow: z.number().optional(),
  department: z.string().optional(),
  engineerEmail: z.string().email().optional()
});

export type TagDefinition = z.infer<typeof TagDefinitionSchema>;

export const TagLatestSchema = z.object({
  machineId: z.string(),
  tagId: z.string(),
  ts: z.coerce.date(),
  valueNumber: z.number().nullable().optional(),
  valueBool: z.boolean().nullable().optional(),
  valueString: z.string().nullable().optional(),
  quality: z.enum(["good", "bad", "stale"]).default("good"),
  lastSampleAt: z.coerce.date().nullable().optional()
});

export type TagLatest = z.infer<typeof TagLatestSchema>;


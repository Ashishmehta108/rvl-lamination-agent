import { z } from "zod";

export const TagValueSchema = z.union([
  z.number(),
  z.boolean(),
  z.string(),
  z.null()
]);

export const IngestTagSchema = z.object({
  tagId: z.string().min(1).optional(),
  tagSlug: z.string().min(1).optional(),
  value: TagValueSchema,
  ts: z.coerce.date().optional()
}).refine((v) => !!(v.tagId || v.tagSlug), {
  message: "tagId or tagSlug is required"
});

export const IngestBatchSchema = z.object({
  machineId: z.string().min(1),
  machineRevision: z.string().min(1),
  sentAt: z.coerce.date(),
  seq: z.number().int().nonnegative(),
  tags: z.array(IngestTagSchema).min(1)
});

export type IngestBatch = z.infer<typeof IngestBatchSchema>;
export type IngestTag = z.infer<typeof IngestTagSchema>;

export const IngestResponseSchema = z.object({
  accepted: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  perTag: z.array(
    z.object({
      tagId: z.string().optional(),
      tagSlug: z.string().optional(),
      status: z.enum(["accepted", "rejected"]),
      reason: z.string().optional()
    })
  )
});

export type IngestResponse = z.infer<typeof IngestResponseSchema>;


import { z } from "zod";
import { newId } from "@rvl/shared";

export const RagChunkSchema = z.object({
  chunkId: z.string(),
  documentId: z.string(),
  text: z.string(),
  embedding: z.array(z.number()),
  machineId: z.string().optional(),
  tagIds: z.array(z.string()).optional(),
  sourceType: z.string().optional(),
  sourceUri: z.string().optional(),
  createdAt: z.coerce.date()
});

export type RagChunk = z.infer<typeof RagChunkSchema>;

export function chunkText(text: string, maxChars = 1200, overlapChars = 200): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    const end = Math.min(text.length, i + maxChars);
    const slice = text.slice(i, end).trim();
    if (slice.length > 0) chunks.push(slice);
    if (end >= text.length) break;
    i = Math.max(0, end - overlapChars);
  }
  return chunks;
}

export function newDocumentId(): string {
  return newId("doc");
}

export function newChunkId(): string {
  return newId("chunk");
}


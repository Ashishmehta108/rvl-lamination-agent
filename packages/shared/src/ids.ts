import { ulid } from "ulidx";

export type IdPrefix =
  | "tag"
  | "machine"
  | "alert"
  | "rule"
  | "delivery"
  | "template"
  | "schedule"
  | "run"
  | "artifact"
  | "doc"
  | "chunk"
  | "chat";

export function newId(prefix: IdPrefix): string {
  // Prefix keeps IDs recognizable across Mongo/Postgres and logs.
  return `${prefix}_${ulid()}`;
}


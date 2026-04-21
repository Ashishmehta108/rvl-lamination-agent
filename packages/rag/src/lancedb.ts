import path from "node:path";
import { connect } from "@lancedb/lancedb";

export type LanceDbHandles = {
  dbDir: string;
};

export async function openLanceDb(dbDir: string) {
  const resolved = path.resolve(dbDir);
  return connect(resolved);
}


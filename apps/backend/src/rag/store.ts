import { openLanceDb } from "@rvl/rag";
import { config } from "../config.js";
import { embedText } from "../llm/ollama.js";

type ChunkRow = {
  chunkId: string;
  documentId: string;
  text: string;
  embedding: number[];
  machineId?: string;
  tagIds?: string[];
  sourceType?: string;
  sourceUri?: string;
  createdAt: string;
};

let tablePromise: Promise<any> | null = null;

async function getTable() {
  if (tablePromise) return tablePromise;
  tablePromise = (async () => {
    const db = await openLanceDb(config.ragDbDir);
    const names = await db.tableNames();
    if (!names.includes("chunks")) {
      return db.createTable("chunks", [
        {
          chunkId: "seed",
          documentId: "seed",
          text: "seed",
          embedding: new Array(768).fill(0), // must match nomic-embed-text output dim
          machineId: "__seed__",
          tagIds: ["__seed__"],
          sourceType: "seed",
          sourceUri: "seed",
          createdAt: new Date().toISOString()
        }
      ]);
    }
    return db.openTable("chunks");
  })();
  return tablePromise;
}

export async function ragQuery(args: { query: string; machineId?: string; tagIds?: string[]; topK: number }) {
  const table = await getTable();
  const qEmb = await embedText(args.query);

  // LanceDB query API returns an async builder; keep minimal and tolerant across versions.
  let builder: any = table.search(qEmb).limit(args.topK);
  if (args.machineId) builder = builder.where(`"machineId" = '${args.machineId.replaceAll("'", "''")}'`);
  const out = await builder.toArray();
  return (out as ChunkRow[]).map((r) => ({ chunkId: r.chunkId, text: r.text, sourceUri: r.sourceUri }));
}


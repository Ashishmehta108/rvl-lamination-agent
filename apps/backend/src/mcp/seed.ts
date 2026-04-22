import { config } from "dotenv";
config({ path: "../../.env" });

import { MongoClient } from "mongodb";
import { getPgDb, schema } from "@rvl/db-postgres";

import { configDotenv } from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

configDotenv({
  path: path.resolve(__dirname, "../../../../.env")
});

async function main() {
  console.log("Seeding data for MCP tests...");

  const machineId = "test-machine-1";
  const machineRevision = "v1";

  // ── MongoDB ──────────────────────────────────────────────────────────────
  console.log("Connecting to MongoDB...");
  const mongoClient = new MongoClient(process.env.MONGODB_URL!);
  await mongoClient.connect();
  const db = mongoClient.db();

  console.log("Seeding TagDefinitions...");
  const tagDefs = db.collection("TagDefinition");

  for (const [tagId, slug, name] of [
    ["tag-temperature", "temperature", "Main Temperature"],
    ["tag-pressure", "pressure", "Main Pressure"],
  ]) {
    const id = `${machineId}:${machineRevision}:${tagId}`;
    await tagDefs.updateOne(
      { id },
      {
        $setOnInsert: {
          id,
          machineId,
          machineRevision,
          tagId,
          slug,
          name,
          dataType: "number",
        },
      },
      { upsert: true }
    );
  }

  console.log("Seeding TagLatest...");
  const tagLatest = db.collection("TagLatest");

  for (const [tagId, valueNumber] of [
    ["tag-temperature", 65.4],
    ["tag-pressure", 120.5],
  ] as [string, number][]) {
    const id = `${machineId}:${tagId}`;
    await tagLatest.updateOne(
      { id },
      {
        $set: { ts: new Date(), valueNumber, quality: "good" },
        $setOnInsert: { id, machineId, tagId },
      },
      { upsert: true }
    );
  }

  await mongoClient.close();
  console.log("MongoDB seeding complete.");

  // ── PostgreSQL ────────────────────────────────────────────────────────────
  console.log("Seeding PostgreSQL alertEvents...");
  const pgDb = getPgDb();

  await pgDb
    .insert(schema.alertEvents)
    .values([
      {
        id: "alert-1",
        machineId,
        severity: "critical",
        status: "open",
        title: "High Temperature Warning",
        description: "Temperature exceeded 65 degrees.",
        startsAt: new Date(),
      },
      {
        id: "alert-2",
        machineId,
        severity: "warning",
        status: "acknowledged",
        title: "Pressure Fluctuations",
        description: "Pressure variance detected over the last hour.",
        startsAt: new Date(Date.now() - 3600000),
      },
    ])
    .onConflictDoNothing();

  console.log("Seeding complete!");
  process.exit(0);
}

main().catch(console.error);
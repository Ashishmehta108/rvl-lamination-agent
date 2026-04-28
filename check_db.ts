import { getMongoClient } from "./apps/backend/src/services/chatTools.js"; // This is wrong, it's not a service export
import { config } from "dotenv";
config();
import { getMongoClient as getMongo } from "./packages/db-mongo/src/index.js";

async function check() {
  const prisma = getMongo();
  const count = await prisma.tagLatest.count();
  console.log("TagLatest count:", count);
  const machines = await prisma.tagLatest.groupBy({ by: ["machineId"] });
  console.log("Machines in TagLatest:", machines);
}
check();

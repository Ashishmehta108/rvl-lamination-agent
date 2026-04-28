
import { config } from "dotenv";
config();
import { getMongoClient } from "./packages/db-mongo/src/index.js";

async function main() {
  const prisma = getMongoClient();
  const machineId = "lamination-01";
  
  const tags = await prisma.tagLatest.findMany({
    where: { machineId },
    select: { tagId: true, valueNumber: true, updatedAt: true }
  });
  
  const defs = await prisma.tagDefinition.findMany({
    where: { machineId, tagId: { in: tags.map(t => t.tagId) } },
    select: { tagId: true, slug: true, name: true, unit: true }
  });
  
  const defMap = new Map(defs.map(d => [d.tagId, d]));
  
  console.log("Current Tags for lamination-01:");
  tags.forEach(t => {
    const d = defMap.get(t.tagId);
    console.log(`- ${d?.slug || t.tagId}: ${t.valueNumber} ${d?.unit || ""} [${t.updatedAt}]`);
  });
}

main().catch(console.error);

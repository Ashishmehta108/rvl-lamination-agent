
import { getMongoClient } from "@rvl/db-mongo";
import { config } from "dotenv";
config({ path: "../../.env" });

async function main() {
  const machineId = "lamination-01";
  
  // We need to use the tool logic or direct access
  const prisma = getMongoClient();
  
  const tags = await prisma.tagLatest.findMany({
    where: { machineId },
    select: { tagId: true, valueNumber: true, valueString: true, updatedAt: true }
  });
  
  const defs = await prisma.tagDefinition.findMany({
    where: { machineId },
    select: { tagId: true, slug: true, name: true, unit: true }
  });
  
  const defMap = new Map(defs.map(d => [d.tagId, d]));
  
  console.log("Latest Tags for lamination-01:");
  // Sort by updatedAt desc to get latest first
  tags.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  
  const seen = new Set();
  tags.forEach(t => {
    const d = defMap.get(t.tagId);
    if (!d) return;
    if (seen.has(d.slug)) return;
    seen.add(d.slug);
    const val = t.valueNumber ?? t.valueString ?? "N/A";
    console.log(`- ${d.slug}: ${val} ${d.unit || ""} [${t.updatedAt}]`);
  });
}

main().catch(console.error);

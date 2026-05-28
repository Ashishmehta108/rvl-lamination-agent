import type { ToolContext } from "../../execute-tool.js";
import type { SearchTagsArgs } from "./schema.js";
import { getPrismaClient } from "src/db/mongo.js";

export async function execute(args: SearchTagsArgs, context: ToolContext) {
  const machineId = args.machineId || context.machineId;
  const query = args.query;
  const prisma = getPrismaClient();
  const rows = await prisma.tagDefinition.findMany({
    where: {
      machineId,
      OR: [
        { name: { contains: query, mode: "insensitive" } },
        { slug: { contains: query.toUpperCase() } },
        { unit: { contains: query, mode: "insensitive" } },
        { department: { contains: query, mode: "insensitive" } },
      ],
    },
    select: {
      slug: true,
      name: true,
      unit: true,
      dataType: true,
      warnHigh: true,
      alarmHigh: true,
    },
    take: 10,
  });
  return rows;
}

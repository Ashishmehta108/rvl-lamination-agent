import { getMongoClient, getNativeDb } from "@rvl/db-mongo";

export function getPrismaClient() {
  return getMongoClient();
}

export { getNativeDb };

export async function closeMongo(): Promise<void> {
  await getMongoClient().$disconnect();
}

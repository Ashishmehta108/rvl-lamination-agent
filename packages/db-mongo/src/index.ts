import { config } from "dotenv";
config({ path: "../../.env" });

import { PrismaClient } from "@prisma/client";

let prismaSingleton: PrismaClient | null = null;

export function getMongoClient(): PrismaClient {
  if (!prismaSingleton) {
    prismaSingleton = new PrismaClient();
  }
  return prismaSingleton;
}

export type { PrismaClient };
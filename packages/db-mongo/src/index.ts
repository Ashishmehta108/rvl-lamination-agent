import { PrismaClient } from "@prisma/client";
import { MongoClient, Db } from "mongodb";

let prismaSingleton: PrismaClient | null = null;
let nativeClientSingleton: MongoClient | null = null;
let nativeDbSingleton: Db | null = null;

export function getMongoClient(): PrismaClient {
  if (!prismaSingleton) {
    prismaSingleton = new PrismaClient();
  }
  return prismaSingleton;
}

export async function getNativeDb(): Promise<Db> {
  if (nativeDbSingleton) return nativeDbSingleton;
  
  const url = process.env.MONGODB_URL;
  if (!url) throw new Error("MONGODB_URL is required");
  const client = new MongoClient(url);
  await client.connect();
  
  nativeClientSingleton = client;
  // Extract DB name from URL or use default
  const dbName = url.split("/").pop()?.split("?")[0] || "rvl";
  nativeDbSingleton = client.db(dbName);
  
  return nativeDbSingleton;
}

export type { PrismaClient };
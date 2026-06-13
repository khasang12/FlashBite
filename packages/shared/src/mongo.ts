import { MongoClient, Db } from "mongodb";
import { loadConfig } from "./config";

export interface MongoHandle {
  client: MongoClient;
  db: Db;
}

export async function connectMongo(uri: string = loadConfig().mongoUri): Promise<MongoHandle> {
  const client = new MongoClient(uri);
  await client.connect();
  return { client, db: client.db() };
}

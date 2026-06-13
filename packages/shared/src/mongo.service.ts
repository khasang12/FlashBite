import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { MongoClient, Db } from "mongodb";
import { connectMongo } from "./mongo";

@Injectable()
export class MongoService implements OnModuleInit, OnModuleDestroy {
  private client!: MongoClient;
  db!: Db;

  async onModuleInit(): Promise<void> {
    const handle = await connectMongo();
    this.client = handle.client;
    this.db = handle.db;
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.close();
  }
}

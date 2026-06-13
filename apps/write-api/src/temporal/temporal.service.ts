import { Injectable, OnModuleInit, OnModuleDestroy } from "@nestjs/common";
import { Client, Connection } from "@temporalio/client";
import { loadConfig } from "@flashbite/shared";

@Injectable()
export class TemporalService implements OnModuleInit, OnModuleDestroy {
  private connection!: Connection;
  client!: Client;

  async onModuleInit(): Promise<void> {
    this.connection = await Connection.connect({ address: loadConfig().temporalAddress });
    this.client = new Client({ connection: this.connection, namespace: "default" });
  }

  async onModuleDestroy(): Promise<void> {
    await this.connection?.close();
  }
}

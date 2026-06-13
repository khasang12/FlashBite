import { Client, Connection } from "@temporalio/client";
import { loadConfig } from "./config";

export interface TemporalHandle {
  connection: Connection;
  client: Client;
}

export async function connectTemporal(address: string = loadConfig().temporalAddress): Promise<TemporalHandle> {
  const connection = await Connection.connect({ address });
  const client = new Client({ connection, namespace: "default" });
  return { connection, client };
}

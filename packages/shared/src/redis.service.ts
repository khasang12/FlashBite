import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { Cluster } from "ioredis";
import { createRedisCluster } from "./redis";

@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly cluster: Cluster = createRedisCluster();

  async onModuleDestroy(): Promise<void> {
    await this.cluster.quit();
  }
}

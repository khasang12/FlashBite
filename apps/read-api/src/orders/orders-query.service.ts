import { Injectable } from "@nestjs/common";
import { MongoService, RedisService } from "@flashbite/shared";
import { getTenantId } from "@flashbite/tenant-context";
import { READ_COLLECTIONS, type OrderView } from "@flashbite/contracts";

const CACHE_TTL_SECONDS = 10;

@Injectable()
export class OrdersQueryService {
  constructor(
    private readonly mongo: MongoService,
    private readonly redis: RedisService,
  ) {}

  async getOrder(orderId: string): Promise<OrderView | null> {
    const tenantId = getTenantId();
    const cacheKey = `{tenant:${tenantId}}:order:${orderId}:view`;

    const cached = await this.redis.cluster.get(cacheKey);
    if (cached) return JSON.parse(cached) as OrderView;

    const doc = await this.mongo.db
      .collection(READ_COLLECTIONS.ORDERS)
      .findOne({ _id: `${tenantId}:${orderId}` as never });
    if (!doc) return null;

    const view: OrderView = {
      tenantId: doc.tenantId,
      orderId: doc.orderId,
      customerId: doc.customerId,
      items: doc.items,
      totalAmount: doc.totalAmount,
      status: doc.status,
      version: doc.version,
      updatedAt: doc.updatedAt,
    };
    await this.redis.cluster.set(cacheKey, JSON.stringify(view), "EX", CACHE_TTL_SECONDS);
    return view;
  }
}

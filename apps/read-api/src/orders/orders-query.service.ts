import { Injectable } from "@nestjs/common";
import { MongoService } from "@flashbite/shared";
import { getTenantId } from "@flashbite/tenant-context";
import { READ_COLLECTIONS, type OrderView } from "@flashbite/contracts";

@Injectable()
export class OrdersQueryService {
  constructor(private readonly mongo: MongoService) {}

  async getOrder(orderId: string): Promise<OrderView | null> {
    const tenantId = getTenantId();
    const doc = await this.mongo.db
      .collection(READ_COLLECTIONS.ORDERS)
      .findOne({ _id: `${tenantId}:${orderId}` as never });
    if (!doc) return null;
    return {
      tenantId: doc.tenantId,
      orderId: doc.orderId,
      customerId: doc.customerId,
      items: doc.items,
      totalAmount: doc.totalAmount,
      status: doc.status,
      version: doc.version,
      updatedAt: doc.updatedAt,
    };
  }
}

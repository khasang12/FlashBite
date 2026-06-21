import { Injectable } from "@nestjs/common";
import { MongoService } from "@flashbite/shared";
import { READ_COLLECTIONS, type DispatchView } from "@flashbite/contracts";

@Injectable()
export class DispatchQueryService {
  constructor(private readonly mongo: MongoService) {}

  async byOrder(tenantId: string, orderId: string): Promise<DispatchView | null> {
    const doc = await this.mongo.db.collection(READ_COLLECTIONS.DISPATCHES).findOne({ _id: `${tenantId}:${orderId}` as never });
    return (doc as unknown as DispatchView) ?? null;
  }

  async forDriver(tenantId: string, driverId: string): Promise<DispatchView | null> {
    const doc = await this.mongo.db.collection(READ_COLLECTIONS.DISPATCHES).findOne({
      tenantId,
      $or: [
        { status: "OFFERED", offeredDriverId: driverId },
        { status: { $in: ["DISPATCHED", "PICKED_UP"] }, driverId },
      ],
    });
    return (doc as unknown as DispatchView) ?? null;
  }
}

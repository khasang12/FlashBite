import { Injectable } from "@nestjs/common";
import {
  PrismaService, loadAggregate, appendWithExpectedVersion, ConcurrencyError,
  foldOrder, place, INITIAL_ORDER_STATE,
} from "@flashbite/shared";
import { getTenantId } from "@flashbite/tenant-context";
import { AGGREGATE_TYPES, EVENT_TYPES } from "@flashbite/contracts";
import { CreateOrderDto } from "./create-order.dto";

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async placeOrder(dto: CreateOrderDto): Promise<{ orderId: string }> {
    const tenantId = getTenantId();
    const { state, version } = await loadAggregate(
      this.prisma,
      { tenantId, aggregateId: dto.orderId },
      foldOrder,
      INITIAL_ORDER_STATE,
    );
    const payload = place(state, {
      orderId: dto.orderId,
      customerId: dto.customerId,
      items: dto.items,
      totalAmount: dto.totalAmount,
    });
    if (payload === null) return { orderId: dto.orderId }; // already exists — idempotent

    try {
      await appendWithExpectedVersion(this.prisma, {
        tenantId,
        aggregateType: AGGREGATE_TYPES.ORDER,
        aggregateId: dto.orderId,
        expectedVersion: version,
        eventType: EVENT_TYPES.ORDER_PLACED,
        payload,
      });
    } catch (err) {
      if (err instanceof ConcurrencyError) return { orderId: dto.orderId }; // concurrent first-write, same order
      throw err;
    }
    return { orderId: dto.orderId };
  }
}

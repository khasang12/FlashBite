import { Injectable } from "@nestjs/common";
import { PrismaService, Prisma } from "@flashbite/shared";
import { getTenantId } from "@flashbite/tenant-context";
import {
  EVENT_TYPES,
  TOPICS,
  buildEnvelope,
  type OrderPlacedPayload,
} from "@flashbite/contracts";
import { CreateOrderDto } from "./create-order.dto";

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

  async placeOrder(dto: CreateOrderDto): Promise<{ orderId: string }> {
    const tenantId = getTenantId();
    const payload: OrderPlacedPayload = {
      orderId: dto.orderId,
      customerId: dto.customerId,
      items: dto.items,
      totalAmount: dto.totalAmount,
    };
    const envelope = buildEnvelope({
      tenantId,
      eventType: EVENT_TYPES.ORDER_PLACED,
      version: 1,
      payload,
    });

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.eventStore.create({
          data: {
            id: envelope.eventId,
            tenantId,
            aggregateType: "ORDER",
            aggregateId: dto.orderId,
            version: 1,
            eventType: EVENT_TYPES.ORDER_PLACED,
            payload: payload as unknown as Prisma.InputJsonValue,
          },
        });
        await tx.outbox.create({
          data: {
            id: envelope.eventId,
            tenantId,
            topic: TOPICS.ORDER_EVENTS,
            partitionKey: `${tenantId}:${dto.orderId}`,
            eventType: EVENT_TYPES.ORDER_PLACED,
            payload: envelope as unknown as Prisma.InputJsonValue,
          },
        });
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === "P2002"
      ) {
        return { orderId: dto.orderId };
      }
      throw err;
    }

    return { orderId: dto.orderId };
  }
}

import { Controller, Sse } from "@nestjs/common";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";
import { getTenantId } from "@flashbite/tenant-context";
import { OrderStreamService } from "./order-stream.service";

interface MessageEvent {
  data: unknown;
}

@Controller("merchant/orders")
export class MerchantSseController {
  constructor(private readonly stream: OrderStreamService) {}

  @Sse("stream")
  ordersStream(): Observable<MessageEvent> {
    const tenantId = getTenantId();
    return this.stream.stream(tenantId).pipe(map((event) => ({ data: event })));
  }
}

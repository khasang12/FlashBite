import { Injectable } from "@nestjs/common";
import { Observable, Subject } from "rxjs";

export interface OrderStreamEvent {
  orderId: string;
  eventType: string;
  status?: string;
  [key: string]: unknown;
}

@Injectable()
export class OrderStreamService {
  private readonly subjects = new Map<string, Subject<OrderStreamEvent>>();

  private subjectFor(tenantId: string): Subject<OrderStreamEvent> {
    let s = this.subjects.get(tenantId);
    if (!s) {
      s = new Subject<OrderStreamEvent>();
      this.subjects.set(tenantId, s);
    }
    return s;
  }

  publish(tenantId: string, event: OrderStreamEvent): void {
    this.subjectFor(tenantId).next(event);
  }

  stream(tenantId: string): Observable<OrderStreamEvent> {
    return this.subjectFor(tenantId).asObservable();
  }
}

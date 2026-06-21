import { Injectable } from "@nestjs/common";
import { Observable, Subject } from "rxjs";
import type { DispatchView } from "@flashbite/contracts";

@Injectable()
export class DispatchStreamService {
  private readonly subjects = new Map<string, Subject<DispatchView>>();

  private subjectFor(tenantId: string): Subject<DispatchView> {
    let s = this.subjects.get(tenantId);
    if (!s) {
      s = new Subject<DispatchView>();
      this.subjects.set(tenantId, s);
    }
    return s;
  }

  publish(tenantId: string, view: DispatchView): void {
    this.subjectFor(tenantId).next(view);
  }

  stream(tenantId: string): Observable<DispatchView> {
    return this.subjectFor(tenantId).asObservable();
  }
}

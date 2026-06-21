// Task 4 replaces this stub with the real createDispatchActivities factory.
// The real Task-4 type must match this interface shape exactly.
export interface DispatchActivities {
  selectNearestAvailableDriverActivity(tenantId: string, exclude: string[]): Promise<string | null>;
  markBusyActivity(tenantId: string, driverId: string): Promise<void>;
  clearBusyActivity(tenantId: string, driverId: string): Promise<void>;
  recordDriverOfferedActivity(tenantId: string, orderId: string, driverId: string): Promise<void>;
  recordDispatchAcceptedActivity(tenantId: string, orderId: string, driverId: string): Promise<void>;
  recordOrderPickedUpActivity(tenantId: string, orderId: string): Promise<void>;
  recordOrderDeliveredActivity(tenantId: string, orderId: string): Promise<void>;
  recordDispatchFailedActivity(tenantId: string, orderId: string, reason: string): Promise<void>;
}

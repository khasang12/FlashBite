import { Injectable } from "@nestjs/common";
import { MongoService, RedisService, TenantCatalogService } from "@flashbite/shared";
import { READ_COLLECTIONS, type OrderView, type NearbyDriver, driverGeoKey } from "@flashbite/contracts";

const ADMIN_NEARBY_RADIUS_KM = 50;

export interface TenantNearbyDriver extends NearbyDriver {
  tenantId: string;
}

@Injectable()
export class AdminService {
  constructor(
    private readonly mongo: MongoService,
    private readonly redis: RedisService,
    private readonly catalog: TenantCatalogService,
  ) {}

  async listAllOrders(limit = 200): Promise<OrderView[]> {
    const docs = await this.mongo.db
      .collection(READ_COLLECTIONS.ORDERS)
      .find({})
      .sort({ updatedAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map((doc) => ({
      tenantId: doc.tenantId,
      orderId: doc.orderId,
      customerId: doc.customerId,
      items: doc.items,
      totalAmount: doc.totalAmount,
      status: doc.status,
      version: doc.version,
      updatedAt: doc.updatedAt,
      cancelReason: doc.cancelReason,
    }));
  }

  async listAllDrivers(): Promise<TenantNearbyDriver[]> {
    const tenants = await this.catalog.list();
    const perTenant = await Promise.all(
      tenants.map(async ({ slug: tenantId, lng, lat }) => {
        const raw = (await this.redis.cluster.geosearch(
          driverGeoKey(tenantId), "FROMLONLAT", String(lng), String(lat),
          "BYRADIUS", String(ADMIN_NEARBY_RADIUS_KM), "km", "ASC", "WITHDIST", "WITHCOORD",
        )) as Array<[string, string, [string, string]]>;
        return raw.map(([driverId, dist, [dlng, dlat]]) => ({
          tenantId, driverId, distanceKm: Number(dist), lng: Number(dlng), lat: Number(dlat),
        }));
      }),
    );
    return perTenant.flat();
  }
}

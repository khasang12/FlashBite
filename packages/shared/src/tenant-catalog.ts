import { Injectable, Optional } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";
import type { TenantView } from "@flashbite/contracts";
import { loadConfig } from "./config";

/**
 * Cached, DB-backed tenant catalog (the TCS-lite). Read-heavy / write-rare, so each process keeps
 * an in-memory copy with a short TTL plus a manual refresh(). Resilient: a DB blip serves the last
 * good cache; a cold cache with an unreachable DB throws (fail-closed) so callers can deny.
 */
@Injectable()
export class TenantCatalogService {
  private cache: TenantView[] | null = null;
  private loadedAt = 0;
  private readonly ttlMs: number;

  constructor(private readonly prisma: PrismaClient, @Optional() ttlMs?: number) {
    this.ttlMs = ttlMs ?? loadConfig().tenantCatalogTtlMs;
  }

  private async ensureFresh(): Promise<TenantView[]> {
    if (this.cache !== null && Date.now() - this.loadedAt < this.ttlMs) return this.cache;
    try {
      const rows = await this.prisma.tenant.findMany();
      this.cache = rows.map((r) => ({ slug: r.slug, displayName: r.displayName, lng: r.lng, lat: r.lat, status: r.status, brandColor: r.brandColor ?? undefined }));
      this.loadedAt = Date.now();
      return this.cache;
    } catch (err) {
      if (this.cache !== null) return this.cache; // resilient: serve stale
      throw err; // fail-closed cold start
    }
  }

  async list(activeOnly = true): Promise<TenantView[]> {
    const all = await this.ensureFresh();
    return activeOnly ? all.filter((t) => t.status === "active") : all;
  }

  async get(slug: string): Promise<TenantView | null> {
    return (await this.ensureFresh()).find((t) => t.slug === slug) ?? null;
  }

  async isActive(slug: string): Promise<boolean> {
    const t = await this.get(slug);
    return t !== null && t.status === "active";
  }

  async refresh(): Promise<void> {
    this.cache = null;
    await this.ensureFresh();
  }
}

"use client";
import { Map, Marker } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { type GeoPoint, type NearbyDriver } from "@flashbite/web-shared";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

export function TenantMap({
  tenant, center, drivers,
}: {
  tenant: string;
  center: GeoPoint;
  drivers: NearbyDriver[];
}) {
  return (
    <div className="rounded-xl border p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {tenant} · {drivers.length} drivers
      </div>
      {!TOKEN ? (
        <div
          data-testid={`map-fallback-${tenant}`}
          className="flex h-[220px] items-center justify-center rounded-lg border bg-muted/30 px-6 text-center text-sm text-muted-foreground"
        >
          Set <code className="mx-1 font-mono">NEXT_PUBLIC_MAPBOX_TOKEN</code> to see the map.
        </div>
      ) : (
        <div className="h-[220px] overflow-hidden rounded-lg border">
          <Map
            mapboxAccessToken={TOKEN}
            initialViewState={{ longitude: center.lng, latitude: center.lat, zoom: 11 }}
            mapStyle="mapbox://styles/mapbox/streets-v12"
            style={{ width: "100%", height: "100%" }}
          >
            {drivers.map((d) => (
              <Marker key={d.driverId} longitude={d.lng} latitude={d.lat} color="#0f172a" />
            ))}
          </Map>
        </div>
      )}
    </div>
  );
}

"use client";
import { useEffect, useRef } from "react";
import { Map, Marker, type MapRef } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import type { GeoPoint, NearbyDriver } from "@flashbite/web-shared";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

export function NearbyMap({
  center,
  self,
  nearby,
}: {
  center: GeoPoint;
  self: GeoPoint | null;
  nearby: NearbyDriver[];
}) {
  const mapRef = useRef<MapRef>(null);

  // Recenter the (uncontrolled) map as the anchor moves — the selected driver's
  // live position when it is streaming, otherwise the tenant city center.
  useEffect(() => {
    mapRef.current?.easeTo({ center: [center.lng, center.lat], duration: 800 });
  }, [center.lng, center.lat]);

  if (!TOKEN) {
    return (
      <div
        data-testid="map-fallback"
        className="flex h-[360px] items-center justify-center rounded-xl border bg-muted/30 px-6 text-center text-sm text-muted-foreground"
      >
        Set <code className="mx-1 font-mono">NEXT_PUBLIC_MAPBOX_TOKEN</code> to see the live map.
      </div>
    );
  }

  return (
    <div className="h-[360px] overflow-hidden rounded-xl border">
      <Map
        ref={mapRef}
        mapboxAccessToken={TOKEN}
        initialViewState={{ longitude: center.lng, latitude: center.lat, zoom: 13 }}
        mapStyle="mapbox://styles/mapbox/streets-v12"
        style={{ width: "100%", height: "100%" }}
      >
        {self && <Marker longitude={self.lng} latitude={self.lat} color="#06C167" />}
        {nearby.map((d) => (
          <Marker key={d.driverId} longitude={d.lng} latitude={d.lat} color="#0f172a" />
        ))}
      </Map>
    </div>
  );
}

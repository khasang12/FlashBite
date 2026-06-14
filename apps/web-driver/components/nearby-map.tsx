"use client";
import { useEffect, useRef } from "react";
import { Map, Marker, type MapRef } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import type { GeoPoint, NearbyDriver } from "@flashbite/web-shared";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

export function NearbyMap({
  position,
  nearby,
}: {
  position: GeoPoint | null;
  nearby: NearbyDriver[];
}) {
  const mapRef = useRef<MapRef>(null);

  // Auto-follow: recenter the (uncontrolled) map as the driver moves, without
  // forcing controlled view state (which would warn + block panning between pings).
  useEffect(() => {
    if (position) {
      mapRef.current?.easeTo({ center: [position.lng, position.lat], duration: 800 });
    }
  }, [position]);

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
  if (!position) return null;

  return (
    <div className="h-[360px] overflow-hidden rounded-xl border">
      <Map
        ref={mapRef}
        mapboxAccessToken={TOKEN}
        initialViewState={{ longitude: position.lng, latitude: position.lat, zoom: 13 }}
        mapStyle="mapbox://styles/mapbox/streets-v12"
        style={{ width: "100%", height: "100%" }}
      >
        <Marker longitude={position.lng} latitude={position.lat} color="#06C167" />
        {nearby.map((d) => (
          <Marker key={d.driverId} longitude={d.lng} latitude={d.lat} color="#0f172a" />
        ))}
      </Map>
    </div>
  );
}

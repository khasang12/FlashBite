"use client";
import { useEffect, useRef, useState } from "react";
import { Map, Marker, Popup, type MapRef } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import { formatKm, type GeoPoint, type NearbyDriver } from "@flashbite/web-shared";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

type MapPoint = NearbyDriver & { isSelf: boolean };

export function NearbyMap({
  center,
  self,
  nearby,
}: {
  center: GeoPoint;
  self: NearbyDriver | null;
  nearby: NearbyDriver[];
}) {
  const mapRef = useRef<MapRef>(null);
  const [hovered, setHovered] = useState<MapPoint | null>(null);

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

  const points: MapPoint[] = [
    ...(self ? [{ ...self, isSelf: true }] : []),
    ...nearby.map((d) => ({ ...d, isSelf: false })),
  ];

  return (
    <div className="h-[360px] overflow-hidden rounded-xl border">
      <Map
        ref={mapRef}
        mapboxAccessToken={TOKEN}
        initialViewState={{ longitude: center.lng, latitude: center.lat, zoom: 13 }}
        mapStyle="mapbox://styles/mapbox/streets-v12"
        style={{ width: "100%", height: "100%" }}
      >
        {points.map((p) => (
          <Marker key={p.driverId} longitude={p.lng} latitude={p.lat} anchor="center">
            <button
              type="button"
              aria-label={
                p.isSelf
                  ? `you (${p.driverId})`
                  : `driver ${p.driverId}, ${formatKm(p.distanceKm)} away`
              }
              onMouseEnter={() => setHovered(p)}
              onMouseLeave={() => setHovered((h) => (h?.driverId === p.driverId ? null : h))}
              onFocus={() => setHovered(p)}
              onBlur={() => setHovered(null)}
              className="block h-3.5 w-3.5 cursor-pointer rounded-full border-2 border-white shadow"
              style={{ backgroundColor: p.isSelf ? "#06C167" : "#0f172a" }}
            />
          </Marker>
        ))}

        {hovered && (
          <Popup
            longitude={hovered.lng}
            latitude={hovered.lat}
            anchor="bottom"
            offset={14}
            closeButton={false}
            closeOnClick={false}
          >
            <div className="text-xs">
              <div className="font-semibold">
                {hovered.isSelf ? `you (${hovered.driverId})` : hovered.driverId}
              </div>
              <div className="text-muted-foreground">
                {hovered.isSelf ? "" : `${formatKm(hovered.distanceKm)} away · `}
                {hovered.lng.toFixed(4)}, {hovered.lat.toFixed(4)}
              </div>
            </div>
          </Popup>
        )}
      </Map>
    </div>
  );
}

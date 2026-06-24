"use client";
import { useEffect, useRef } from "react";
import { Map, Marker, type MapRef } from "react-map-gl/mapbox";
import "mapbox-gl/dist/mapbox-gl.css";
import type { GeoPoint } from "@flashbite/web-shared";

const TOKEN = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;

/** The assigned driver's live position on a map. `driver` is null until the first ping (or when
 *  not en route) — we then center on the city reference and show a "locating" note, no marker. */
export function DriverMap({ center, driver }: { center: GeoPoint; driver: { lng: number; lat: number } | null }) {
  const mapRef = useRef<MapRef>(null);
  const anchor = driver ?? center;

  // Recenter the (uncontrolled) map as the driver moves; fall back to the city center.
  useEffect(() => {
    mapRef.current?.easeTo({ center: [anchor.lng, anchor.lat], duration: 800 });
  }, [anchor.lng, anchor.lat]);

  if (!TOKEN) {
    return (
      <div
        data-testid="map-fallback"
        className="flex h-[300px] items-center justify-center rounded-xl border bg-muted/30 px-6 text-center text-sm text-muted-foreground"
      >
        Set <code className="mx-1 font-mono">NEXT_PUBLIC_MAPBOX_TOKEN</code> to see the live map.
      </div>
    );
  }

  return (
    <div className="relative h-[300px] overflow-hidden rounded-xl border">
      <Map
        ref={mapRef}
        mapboxAccessToken={TOKEN}
        initialViewState={{ longitude: anchor.lng, latitude: anchor.lat, zoom: 13 }}
        mapStyle="mapbox://styles/mapbox/streets-v12"
        style={{ width: "100%", height: "100%" }}
      >
        {driver && (
          <Marker longitude={driver.lng} latitude={driver.lat} anchor="center">
            <span
              aria-label="driver location"
              className="block h-3.5 w-3.5 rounded-full border-2 border-white shadow"
              style={{ backgroundColor: "#06C167" }}
            />
          </Marker>
        )}
      </Map>
      {!driver && (
        <div className="pointer-events-none absolute inset-x-0 top-2 mx-auto w-fit rounded-full bg-background/90 px-3 py-1 text-xs text-muted-foreground shadow">
          Locating driver…
        </div>
      )}
    </div>
  );
}

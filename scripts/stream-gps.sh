#!/usr/bin/env bash
#
# Continuously stream simulated driver GPS pings into the telemetry plane.
# Each tick random-walks the driver a few metres and POSTs to read-api's
# ingest endpoint, which publishes a DriverTelemetryStreamed event onto the
# telemetry-streams topic; the telemetry-worker GEOADDs it into Redis geo.
#
# Runs forever — press Ctrl+C to stop.
#
# Usage:
#   ./scripts/stream-gps.sh                 # drv-1 @ berlin, 1s interval
#   DRIVER=drv-7 TENANT=tokyo ./scripts/stream-gps.sh
#   INTERVAL=0.5 STEP=0.002 ./scripts/stream-gps.sh
#
# Env vars (all optional):
#   BASE_URL      read-api base URL            (default http://localhost:3002)
#   TENANT        X-Tenant-ID header           (default berlin)
#   DRIVER        driver id in the path        (default drv-1)
#   INTERVAL      seconds between pings         (default 1)
#   LNG / LAT     starting coordinates         (default Berlin centre 13.405 / 52.52)
#   STEP          max coord delta per tick      (default 0.0008 ~= up to ~60-90m)
#   NEARBY_EVERY  print a /drivers/nearby count every N pings; 0 disables (default 10)
#
# Prereq: infra up (pnpm infra:up) + read-api (pnpm dev:read-api) + worker (pnpm dev:telemetry).

set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:3002}"
TENANT="${TENANT:-berlin}"
DRIVER="${DRIVER:-drv-1}"
INTERVAL="${INTERVAL:-1}"
LNG="${LNG:-13.405}"
LAT="${LAT:-52.52}"
STEP="${STEP:-0.0008}"
NEARBY_EVERY="${NEARBY_EVERY:-10}"

RESP_FILE="$(mktemp -t gps-resp.XXXXXX)"
count=0

cleanup() {
  rm -f "$RESP_FILE"
}
on_stop() {
  echo
  echo "stopped after ${count} ping(s) — driver=${DRIVER} tenant=${TENANT}"
  cleanup
  exit 0
}
trap on_stop INT TERM
trap cleanup EXIT

echo "streaming GPS: driver=${DRIVER} tenant=${TENANT} -> ${BASE_URL} every ${INTERVAL}s (Ctrl+C to stop)"

while true; do
  # Random walk: nudge lng/lat by a delta in [-STEP, STEP] so the driver "moves".
  read -r LNG LAT < <(awk -v lng="$LNG" -v lat="$LAT" -v step="$STEP" \
    'BEGIN { srand(); printf "%.6f %.6f", lng + (rand() * 2 - 1) * step, lat + (rand() * 2 - 1) * step }')

  if ! http=$(curl -s -o "$RESP_FILE" -w '%{http_code}' \
      -X POST "${BASE_URL}/drivers/${DRIVER}/location" \
      -H 'Content-Type: application/json' \
      -H "X-Tenant-ID: ${TENANT}" \
      -d "{\"lng\":${LNG},\"lat\":${LAT}}"); then
    echo "POST failed — is read-api up on ${BASE_URL}? retrying in ${INTERVAL}s..."
    sleep "$INTERVAL"
    continue
  fi

  count=$((count + 1))
  printf '[%s] #%d POST %s lng=%s lat=%s -> %s %s\n' \
    "$(date +%H:%M:%S)" "$count" "$DRIVER" "$LNG" "$LAT" "$http" "$(cat "$RESP_FILE")"

  if [ "$NEARBY_EVERY" -gt 0 ] && [ $((count % NEARBY_EVERY)) -eq 0 ]; then
    n=$(curl -s "${BASE_URL}/drivers/nearby?lng=${LNG}&lat=${LAT}&radiusKm=5" \
        -H "X-Tenant-ID: ${TENANT}" | grep -o '"driverId"' | wc -l | tr -d ' ')
    echo "    -> nearby within 5km (${TENANT}): ${n} driver(s)"
  fi

  sleep "$INTERVAL"
done

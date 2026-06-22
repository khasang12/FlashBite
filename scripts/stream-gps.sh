#!/usr/bin/env bash
#
# Continuously stream simulated driver GPS pings into the telemetry plane.
# Each tick random-walks the driver a few metres and POSTs to read-api's
# ingest endpoint, which publishes a DriverTelemetryStreamed event onto the
# telemetry-streams topic; the telemetry-worker GEOADDs it into Redis geo.
#
# Logs in to the identity service first to obtain a driver JWT, then sends
# Bearer auth on every request (no X-Tenant-ID header — tenant is embedded
# in the token via the driver's email address).
#
# Runs forever — press Ctrl+C to stop.
#
# Usage:
#   ./scripts/stream-gps.sh                 # drv-1 @ berlin, 1s interval
#   DRIVER=drv-2 TENANT=tokyo ./scripts/stream-gps.sh   # drivers are seeded drv-1..drv-4
#   INTERVAL=0.5 STEP=0.002 ./scripts/stream-gps.sh
#
# Env vars (all optional):
#   BASE_URL      read-api base URL            (default http://localhost:3002)
#   IDENTITY_URL  identity service base URL    (default http://localhost:3003)
#   TENANT        tenant slug (used to build DRIVER_EMAIL)  (default berlin)
#   DRIVER        driver id in the path        (default drv-1)
#   DRIVER_EMAIL  login email for the driver   (default ${DRIVER}@${TENANT}.test — sub == driverId)
#   SEED_PASSWORD password for the driver user (default devpassword)
#   INTERVAL      seconds between pings         (default 1)
#   LNG / LAT     starting coordinates         (default Berlin centre 13.405 / 52.52)
#   STEP          max coord delta per tick      (default 0.0008 ~= up to ~60-90m)
#   NEARBY_EVERY  print a /drivers/nearby count every N pings; 0 disables (default 10)
#
# Prereq: infra up (pnpm infra:up) + dev:identity (pnpm dev:identity) + users seeded
#         (pnpm seed:users) + read-api (pnpm dev:read-api) + worker (pnpm dev:telemetry).

# No `set -e`: this is a long-running loop that must survive transient errors
# (e.g. read-api momentarily down) and keep streaming until the user stops it.
set -u

BASE_URL="${BASE_URL:-http://localhost:3002}"
TENANT="${TENANT:-berlin}"
IDENTITY_URL="${IDENTITY_URL:-http://localhost:3003}"
DRIVER="${DRIVER:-drv-1}"
# Drivers are seeded drv-1..drv-4 with User.id == sub == driverId, so log in *as* the
# streamed driver (berlin keeps clean ids; other tenants are suffixed, e.g. drv-1-tokyo).
DRIVER_EMAIL="${DRIVER_EMAIL:-${DRIVER}@${TENANT}.test}"
SEED_PASSWORD="${SEED_PASSWORD:-devpassword}"
INTERVAL="${INTERVAL:-1}"
LNG="${LNG:-13.405}"
LAT="${LAT:-52.52}"
STEP="${STEP:-0.0008}"
NEARBY_EVERY="${NEARBY_EVERY:-10}"

TOKEN="$(curl -s -X POST "${IDENTITY_URL}/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"${DRIVER_EMAIL}\",\"password\":\"${SEED_PASSWORD}\"}" \
  | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')"
if [ -z "$TOKEN" ]; then
  echo "login failed for ${DRIVER_EMAIL} at ${IDENTITY_URL} — is dev:identity running + users seeded (pnpm seed:users)?" >&2
  exit 1
fi

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
  # Note the trailing \n in printf: without it `read` returns non-zero at EOF.
  read -r LNG LAT < <(awk -v lng="$LNG" -v lat="$LAT" -v step="$STEP" \
    'BEGIN { srand(); printf "%.6f %.6f\n", lng + (rand() * 2 - 1) * step, lat + (rand() * 2 - 1) * step }')

  if ! http=$(curl -s -o "$RESP_FILE" -w '%{http_code}' \
      -X POST "${BASE_URL}/drivers/${DRIVER}/location" \
      -H 'Content-Type: application/json' \
      -H "Authorization: Bearer ${TOKEN}" \
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
        -H "Authorization: Bearer ${TOKEN}" | grep -o '"driverId"' | wc -l | tr -d ' ')
    echo "    -> nearby within 5km (${TENANT}): ${n} driver(s)"
  fi

  sleep "$INTERVAL"
done

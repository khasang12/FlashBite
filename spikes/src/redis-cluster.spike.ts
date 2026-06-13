import { Cluster } from "ioredis";

const NODES = (process.env.REDIS_CLUSTER_NODES ??
  "127.0.0.1:7100,127.0.0.1:7101,127.0.0.1:7102,127.0.0.1:7103,127.0.0.1:7104,127.0.0.1:7105")
  .split(",")
  .map((hp) => {
    const [host, port] = hp.split(":");
    return { host, port: Number(port) };
  });

// grokzen announces nodes as 0.0.0.0:<port> (IP=0.0.0.0). Map those to 127.0.0.1 so a
// host client can follow MOVED redirects.
// Actual cluster nodes announce 127.0.0.1, so this natMap is harmless but kept for robustness.
const PORTS = [7100, 7101, 7102, 7103, 7104, 7105];
const natMap = Object.fromEntries(
  PORTS.map((p) => [`0.0.0.0:${p}`, { host: "127.0.0.1", port: p }]),
);

async function main() {
  const cluster = new Cluster(NODES, { natMap });

  // 1. Cluster is healthy.
  const info = await cluster.cluster("INFO");
  if (!String(info).includes("cluster_state:ok")) {
    throw new Error(`cluster not ok:\n${info}`);
  }
  console.log("cluster_state:ok");

  // 2. Two keys for the SAME tenant (same hash tag) must share a slot.
  const berlinDash = "{tenant:berlin}:order:o1:dashboard";
  const berlinGeo = "{tenant:berlin}:driver:geo";
  const slotA = await cluster.cluster("KEYSLOT", berlinDash);
  const slotB = await cluster.cluster("KEYSLOT", berlinGeo);
  if (slotA !== slotB) {
    throw new Error(`same-tenant keys landed on different slots: ${slotA} vs ${slotB}`);
  }
  console.log(`berlin keys co-located on slot ${slotA}`);

  // 3. A different tenant should (normally) map to a different slot.
  const tokyoDash = "{tenant:tokyo}:order:o1:dashboard";
  const slotC = await cluster.cluster("KEYSLOT", tokyoDash);
  console.log(`tokyo dashboard on slot ${slotC}`);

  // 4. Round-trip a value through the cluster.
  await cluster.set(berlinDash, JSON.stringify({ status: "COOKING" }), "EX", 10);
  const back = await cluster.get(berlinDash);
  if (!back || JSON.parse(back).status !== "COOKING") {
    throw new Error("value did not round-trip through cluster");
  }
  console.log("value round-trip OK");

  await cluster.quit();
  console.log("SPIKE OK: redis cluster healthy + tenant hash-tag co-location works");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

// Prisma's generated runtime files carry `//# sourceMappingURL=*.map` comments for
// source maps it does not emit. @swc-node/register (used by `pnpm dev:payments`)
// tries to read those maps when it transforms the client and logs a noisy
// "failed to read input source map" error. Strip the comments after `prisma generate`.
// The generated dir is gitignored, so this re-runs on every regenerate.
const fs = require("node:fs");
const path = require("node:path");

const dir = path.join(__dirname, "..", "prisma", "generated");
let stripped = 0;

function walk(d) {
  for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = path.join(d, entry.name);
    if (entry.isDirectory()) walk(fp);
    else if (entry.name.endsWith(".js")) {
      const src = fs.readFileSync(fp, "utf8");
      const out = src.replace(/\n?\/\/# sourceMappingURL=.*$/gm, "");
      if (out !== src) {
        fs.writeFileSync(fp, out);
        stripped++;
      }
    }
  }
}

if (fs.existsSync(dir)) walk(dir);
// eslint-disable-next-line no-console
console.log(`stripped sourceMappingURL from ${stripped} generated file(s)`);

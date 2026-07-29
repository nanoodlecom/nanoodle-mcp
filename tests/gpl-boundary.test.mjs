/**
 * Licence-boundary guard — fully offline, no spend.
 *
 * Everything this repo ships is MIT, and so is its `nanoodle` dependency. The
 * one exception is `nanocurrency` (GPL-3.0), which signs Nano blocks. It is
 * needed only on the x402 paths: wallet mode (pay NanoGPT invoices with no API
 * key) and charge mode (take callers' payments, send refunds and payouts).
 *
 * A plain BYOK run must therefore never execute it. That is enforced by
 * loading src/wallet.mjs and src/gate.mjs on demand from bin/nanoodle-mcp.mjs,
 * which is easy to undo by accident: one convenience `import` at the top of the
 * bin puts GPL code back on every startup path. These tests walk the STATIC
 * import graph from the bin and fail if it can reach `nanocurrency`.
 *
 * The runtime behaviour was checked by hand with a module resolve hook:
 * BYOK startup resolves `nanocurrency` zero times, wallet startup resolves it once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Static `import ... from "X"` / `export ... from "X"` specifiers. Dynamic import() is ignored on purpose. */
function staticSpecifiers(source) {
  const specs = [];
  // Strip block and line comments so a specifier inside a comment is not counted.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/[^\n]*$/gm, (m) => m.split("//")[0]);
  const re = /(?:^|[\n;])\s*(?:import|export)\b[^;'"]*?from\s*["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(code))) specs.push(m[1]);
  // Bare side-effect import: `import "x";`
  const bare = /(?:^|[\n;])\s*import\s*["']([^"']+)["']/g;
  while ((m = bare.exec(code))) specs.push(m[1]);
  return specs;
}

/** Files reachable from `entry` through static imports only, plus every bare package specifier seen. */
function staticGraph(entry) {
  const seen = new Set();
  const packages = new Set();
  const queue = [resolvePath(root, entry)];
  while (queue.length) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const spec of staticSpecifiers(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) queue.push(resolvePath(dirname(file), spec));
      else if (!spec.startsWith("node:")) packages.add(spec);
    }
  }
  return { files: seen, packages };
}

test("the BYOK startup path never statically imports the GPL dependency", () => {
  const { packages } = staticGraph("bin/nanoodle-mcp.mjs");
  assert.ok(
    !packages.has("nanocurrency"),
    "bin/nanoodle-mcp.mjs can reach nanocurrency (GPL-3.0) through static imports. " +
      "Load src/wallet.mjs and src/gate.mjs with await import() instead, so a BYOK run never executes GPL code.",
  );
});

test("only the two x402 modules import nanocurrency", () => {
  const gpl = [];
  for (const f of ["gate.mjs", "http.mjs", "redact.mjs", "server.mjs", "sweep.mjs", "tools.mjs", "wallet.mjs", "ffmpeg-check.mjs"]) {
    const specs = staticSpecifiers(readFileSync(join(root, "src", f), "utf8"));
    if (specs.includes("nanocurrency")) gpl.push(f);
  }
  assert.deepEqual(gpl.sort(), ["gate.mjs", "wallet.mjs"]);
});

test("README states the licence split instead of claiming MIT end to end", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.doesNotMatch(readme, /MIT end to end/i, "the stack is not MIT end to end — nanocurrency is GPL-3.0");
  assert.match(readme, /## Licensing/);
  assert.match(readme, /nanocurrency[^\n]*GPL-3\.0|GPL-3\.0[^\n]*nanocurrency/);
});

test("the served landing page and llms.txt do not overclaim MIT", () => {
  // These strings are published on every hosted server and read by paying callers.
  const http = readFileSync(join(root, "src", "http.mjs"), "utf8");
  assert.doesNotMatch(http, /MIT-licensed end to end/i);
  assert.doesNotMatch(http, /whole stack is MIT/i);
  assert.match(http, /nanocurrency/);
  assert.match(http, /GPL-3\.0/);
});

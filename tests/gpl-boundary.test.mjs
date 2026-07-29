/**
 * Licence-boundary guard — fully offline, no spend.
 *
 * Two separate things are guarded here.
 *
 * 1. WHERE THE GPL CODE RUNS. `nanocurrency` (GPL-3.0) signs Nano blocks. Every
 *    installer receives it — npm installs it unconditionally — but it is needed
 *    only on the x402 paths: wallet mode (pay NanoGPT invoices with no API key)
 *    and charge mode (take callers' payments, send refunds and payouts). A plain
 *    BYOK run must never execute it. That is enforced by loading src/wallet.mjs
 *    and src/gate.mjs on demand from bin/nanoodle-mcp.mjs, which is easy to undo
 *    by accident: one convenience `import` at the top of the bin puts GPL code
 *    back on every startup path. These tests walk the STATIC import graph from
 *    the bin and fail if it can reach `nanocurrency`.
 *
 * 2. WHAT WE TELL PEOPLE. Three places disclose the licence split: the README,
 *    the landing-page card, and /llms.txt. Each is asserted on its own. A test
 *    that only looks for "GPL-3.0" somewhere in src/http.mjs is satisfied by
 *    either one of the two pages, so the other can be deleted in silence.
 *
 * The runtime behaviour was checked by hand with a module resolve hook:
 * BYOK startup resolves `nanocurrency` zero times, wallet startup resolves it once.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
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
  const queue = [{ file: resolvePath(root, entry), from: "(entry point)" }];
  while (queue.length) {
    const { file, from } = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    let source;
    try {
      source = readFileSync(file, "utf8");
    } catch {
      // A dangling relative import. Say so, instead of letting a bare ENOENT escape.
      assert.fail(`${relative(root, from)} imports ${relative(root, file)}, which does not exist — fix the import or the filename`);
    }
    for (const spec of staticSpecifiers(source)) {
      if (spec.startsWith(".")) queue.push({ file: resolvePath(dirname(file), spec), from: file });
      else if (!spec.startsWith("node:")) packages.add(spec);
    }
  }
  return { files: seen, packages };
}

/** Every JS module under src/, read off disk. A hardcoded list misses new modules and dies on renames. */
function srcModules(dir = join(root, "src")) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...srcModules(full));
    else if (/\.(mjs|cjs|js)$/.test(entry.name)) out.push(full);
  }
  return out.sort();
}

/**
 * The slice of `source` between two anchors, so a disclosure can be asserted
 * where it actually lives instead of anywhere in the file.
 * A null `endMark` runs to the end of the file.
 */
function section(source, startMark, endMark, label) {
  const start = source.indexOf(startMark);
  assert.notEqual(
    start,
    -1,
    `${label}: could not find the anchor ${JSON.stringify(startMark)} — did that section get renamed or deleted?`,
  );
  if (endMark === null) return source.slice(start);
  const end = source.indexOf(endMark, start + startMark.length);
  assert.notEqual(end, -1, `${label}: could not find the closing anchor ${JSON.stringify(endMark)}`);
  return source.slice(start, end);
}

/** The README's Licensing section — it is the last heading, so it runs to the end of the file. */
const readmeLicensing = () =>
  section(readFileSync(join(root, "README.md"), "utf8"), "## Licensing", null, "README Licensing");

test("the BYOK startup path never statically imports the GPL dependency", () => {
  const { packages } = staticGraph("bin/nanoodle-mcp.mjs");
  assert.ok(
    !packages.has("nanocurrency"),
    "bin/nanoodle-mcp.mjs can reach nanocurrency (GPL-3.0) through static imports. " +
      "Load src/wallet.mjs and src/gate.mjs with await import() instead, so a BYOK run never executes GPL code.",
  );
});

test("only the two x402 modules import nanocurrency", () => {
  // src/ is enumerated from disk: a new module that imports nanocurrency is caught
  // even when nothing else references it, and a rename gives this assertion, not ENOENT.
  const files = srcModules();
  assert.ok(files.length >= 5, "the src/ walk found almost nothing — it is broken, not clean");
  const gpl = files
    .filter((f) => staticSpecifiers(readFileSync(f, "utf8")).includes("nanocurrency"))
    .map((f) => relative(join(root, "src"), f));
  assert.deepEqual(
    gpl.sort(),
    ["gate.mjs", "wallet.mjs"],
    "nanocurrency (GPL-3.0) may only be imported by the two x402 modules. A new module that needs it " +
      "must stay off every static path from bin/nanoodle-mcp.mjs — reach it with await import() only.",
  );
});

test("README states the licence split instead of claiming MIT end to end", () => {
  const readme = readFileSync(join(root, "README.md"), "utf8");
  assert.doesNotMatch(readme, /MIT end to end/i, "the stack is not MIT end to end — nanocurrency is GPL-3.0");
  assert.match(readme, /## Licensing/);
  assert.match(readme, /nanocurrency[^\n]*GPL-3\.0|GPL-3\.0[^\n]*nanocurrency/);
});

test("README says the GPL code is installed for everyone, and only LOADED on x402", () => {
  // The on-demand import changes which runs EXECUTE the GPL code. It does not change
  // who RECEIVES it. Wording that implies a BYOK user never gets GPL-3.0 code is false.
  const licensing = readmeLicensing();
  assert.match(
    licensing,
    /[Ee]very installer receives it/,
    "README must say plainly that every installer receives the GPL-3.0 dependency",
  );
  assert.match(licensing, /dependency tree contains GPL-3\.0 code/i);
  assert.match(
    licensing,
    /never loads or runs GPL-3\.0 code/,
    "README must scope the benefit to loading, not to delivery",
  );
});

test("README does not claim other people's graphs are MIT", () => {
  const licensing = readmeLicensing();
  assert.doesNotMatch(licensing, /the graphs you save from it/i, "a saved graph is its author's work, not MIT by being saved");
  assert.match(licensing, /[Gg]raphs are not covered/, "README must say graphs fall outside this repo's licence");
});

test("the landing-page licence card discloses the GPL dependency on its own", () => {
  // Asserted on the card alone. /llms.txt carries the same 2 words, so a file-wide
  // search keeps passing after this card is deleted.
  const http = readFileSync(join(root, "src", "http.mjs"), "utf8");
  const card = section(http, "Open source — host your own", "</div>", "landing-page licence card");
  assert.match(card, /nanocurrency/, "the landing card must name the GPL-3.0 dependency");
  assert.match(card, /GPL-3\.0/, "the landing card must name the GPL-3.0 licence");
  assert.doesNotMatch(card, /whole stack is MIT/i);
  assert.doesNotMatch(
    card,
    /every workflow above/i,
    "the served workflows belong to their authors — they are not MIT by being served",
  );
});

test("/llms.txt discloses the GPL dependency on its own", () => {
  const http = readFileSync(join(root, "src", "http.mjs"), "utf8");
  const source = section(http, "`## Source`", "`Self-host:", "/llms.txt Source section");
  assert.match(source, /nanocurrency/, "/llms.txt must name the GPL-3.0 dependency");
  assert.match(source, /GPL-3\.0/, "/llms.txt must name the GPL-3.0 licence");
  assert.doesNotMatch(source, /MIT-licensed end to end/i);
  assert.doesNotMatch(
    source,
    /workflow library https:\/\/github\.com\/nanoodlecom\/awesome-noodles/,
    "a self-hosted server serves the operator's graphs, not awesome-noodles",
  );
});

test("neither served page claims the whole stack is MIT", () => {
  const http = readFileSync(join(root, "src", "http.mjs"), "utf8");
  assert.doesNotMatch(http, /MIT-licensed end to end/i);
  assert.doesNotMatch(http, /whole stack is MIT/i);
});

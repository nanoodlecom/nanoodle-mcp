// An unpriceable humanize-comment quote never falls back to a stale x402.usd
// pin. It uses the computed worst-case ceiling, or the call is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChargeGate } from "../src/gate.mjs";
import { loadTools, humanizeColdPin, humanizeQuoteOrCeiling } from "../src/tools.mjs";
import { humanizeCeilingDepositUsd } from "../src/humanize-deposit.mjs";

const GATE_ADDR = "nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet";
const FIXTURE = new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url);
const STALE = 0.01963166; // the awesome-noodles pin before the ceiling was raised
const ARGS = { Draft: "Thanks, this helped a lot.", Context: "We cut CI." };

async function mount(edit) {
  const graph = JSON.parse(await readFile(FIXTURE, "utf8"));
  graph.x402 = { ...graph.x402, usd: STALE };
  if (edit) edit(graph);
  const dir = await mkdtemp(join(tmpdir(), "noodle-humanize-pin-"));
  await writeFile(join(dir, "humanize-comment.noodle-graph.json"), JSON.stringify(graph));
  const registry = await loadTools({ dirs: [dir], apiKey: "test-key", hosted: true, outDir: join(dir, "out"), log: () => {} });
  const gate = createChargeGate({
    address: GATE_ADDR,
    ops: { rpc: async () => ({ blocks: {}, history: [] }), transfer: async () => "F".repeat(64), pocket: async () => {} },
    usd: 0.05, xnoUsd: 1, publicBase: "http://pay.test", pollMs: 10, waitMs: 300,
    validate: (p) => registry.prepareCall(p), log: () => {},
  });
  return { graph, dir, registry, gate };
}

test("a stale pin below the computed ceiling is raised to the ceiling at load", async () => {
  const { graph, dir, registry } = await mount();
  try {
    const ceiling = humanizeCeilingDepositUsd(graph);
    assert.equal(ceiling.toFixed(8), "0.05428204");
    const tool = registry.tools.find((t) => t.name === "humanize-comment");
    assert.equal(tool.x402.usd, ceiling);
    const served = JSON.parse(tool.rawText);
    assert.equal(served.x402.usd.toFixed(8), "0.05428204");
    assert.ok(served.x402.usd + 1e-12 >= ceiling);
    const onDisk = JSON.parse(await readFile(join(dir, "humanize-comment.noodle-graph.json"), "utf8"));
    assert.equal(onDisk.x402.usd, STALE, "the file on disk stays the stale pin");
    onDisk.x402.usd = served.x402.usd;
    assert.deepEqual(served, onDisk, "only the served pin changes");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an unpriceable request quotes the worst-case ceiling, not the stale pin", async () => {
  const { graph, dir, registry } = await mount();
  try {
    const tool = registry.tools.find((t) => t.name === "humanize-comment");
    // No model has a price in this table, so the request itself cannot be priced.
    const usd = humanizeQuoteOrCeiling(tool, ARGS, {});
    assert.equal(usd, humanizeCeilingDepositUsd(graph));
    assert.ok(usd > STALE);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("with no computable ceiling the quote is refused, and the gate never uses the pin", async () => {
  const { dir, registry, gate } = await mount();
  try {
    const tool = registry.tools.find((t) => t.name === "humanize-comment");
    // What humanizeColdPin leaves when the ceiling cannot be computed, with a
    // price table in which nothing is priced, so neither figure exists.
    tool.x402 = { usd: null, unpriceable: true };
    registry.quoteDeposit = (name, args) => humanizeQuoteOrCeiling(tool, args, {});
    assert.throws(() => registry.quoteDeposit("humanize-comment", ARGS), /refusing/);
    const { callTool } = gate.wrapRegistry(registry);
    await assert.rejects(callTool({ name: "humanize-comment", arguments: ARGS }), /refusing/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a pretty-printed stale pin is served as 0.05428204 and the rest of the file is unchanged", async () => {
  const original = await readFile(FIXTURE, "utf8");
  assert.match(original, /"usd": 0\.05428204/);
  const stale = original.replace('"usd": 0.05428204', '"usd": 0.01963166');
  const dir = await mkdtemp(join(tmpdir(), "noodle-humanize-pin-pretty-"));
  await writeFile(join(dir, "humanize-comment.noodle-graph.json"), stale);
  try {
    const registry = await loadTools({ dirs: [dir], apiKey: "test-key", hosted: true, outDir: join(dir, "out"), log: () => {} });
    const tool = registry.tools.find((t) => t.name === "humanize-comment");
    assert.equal(tool.rawText, original);
    assert.equal(JSON.parse(tool.rawText).x402.usd.toFixed(8), "0.05428204");
    assert.equal(tool.x402.usd.toFixed(8), "0.05428204");
    const ceiling = humanizeCeilingDepositUsd(JSON.parse(original));
    assert.ok(tool.x402.usd + 1e-12 >= ceiling);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a pin at or above the ceiling is served byte for byte", async () => {
  const graph = JSON.parse(await readFile(FIXTURE, "utf8"));
  graph.x402.usd = 0.06;
  const body = JSON.stringify(graph);
  const dir = await mkdtemp(join(tmpdir(), "noodle-humanize-pin-high-"));
  await writeFile(join(dir, "humanize-comment.noodle-graph.json"), body);
  try {
    const registry = await loadTools({ dirs: [dir], apiKey: "test-key", hosted: true, outDir: join(dir, "out"), log: () => {} });
    const tool = registry.tools.find((t) => t.name === "humanize-comment");
    assert.equal(tool.rawText, body);
    assert.equal(tool.x402.usd, 0.06);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("humanizeColdPin drops a pin it cannot check and keeps one at or above the ceiling", async () => {
  // a graph with no humanize nodes has no ceiling: the pin is dropped, not trusted
  assert.equal(humanizeColdPin({ nodes: [] }, { usd: 1 }).unpriceable, true);
  const graph = JSON.parse(await readFile(FIXTURE, "utf8"));
  assert.equal(humanizeColdPin(graph, { usd: 0.06 }).usd, 0.06);
  assert.equal(humanizeColdPin(graph, null).usd, humanizeCeilingDepositUsd(graph));
});

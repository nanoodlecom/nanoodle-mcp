import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, mkdir, readFile, writeFile, symlink, link, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writePrivateStateSync } from "../src/private-state.mjs";
import { openNearLedger } from "../src/near/ledger.mjs";
import { openMarketState } from "../src/market/state.mjs";
import { openBidState } from "../src/market/bidder.mjs";

for (const kind of ["near", "market", "bid"]) test(`${kind} writer exposes a failed commit until a full synchronized write succeeds`, async t => {
  const dir = await mkdtemp(join(tmpdir(), "financial-writer-health-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, kind === "market" ? "market-state.json" : "state.json");
  const state = kind === "near" ? openNearLedger({ file, network: "testnet", merchant: "merchant.testnet" })
    : kind === "market" ? openMarketState({ dir }) : openBidState(file);
  if (kind === "market") t.after(state.close);
  const update = value => kind === "near" ? state.setMeta("checkpoint", value)
    : kind === "market" ? state.update("assignment", { phase: value }) : state.set("job", { phase: value });
  if (kind === "market") state.create("assignment", { phase: "new" }); else update("new");
  const previous = await readFile(file, "utf8");
  const temporary = kind === "near" ? `${file}.tmp-${process.pid}` : kind === "market" ? `${file}.${process.pid}.tmp` : `${file}.tmp`;
  await mkdir(temporary);
  assert.throws(() => update("running"));
  assert.deepEqual(state.persistenceStatus(), { ok: false, pendingWrites: 0 });
  assert.equal(await readFile(file, "utf8"), previous);
  await rm(temporary, { recursive: true }); update("recovered");
  assert.deepEqual(state.persistenceStatus(), { ok: true, pendingWrites: 0 });
  assert.match(await readFile(file, "utf8"), /recovered/);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

for (const [kind, makeLink] of [["symlink", symlink], ["hardlink", link]]) test(`private state staging refuses ${kind}s before truncation or chmod`, async t => {
  const dir = await mkdtemp(join(tmpdir(), "financial-staging-link-")); t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, "state.json"), target = join(dir, "private-target"), temporary = join(dir, "staging");
  await writeFile(target, "KEEP", { mode: 0o640 }); await makeLink(target, temporary);
  assert.throws(() => writePrivateStateSync(file, "new state", { temporary }));
  assert.equal(await readFile(target, "utf8"), "KEEP");
  assert.equal((await stat(target)).mode & 0o777, 0o640);
});

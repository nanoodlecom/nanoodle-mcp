import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTools } from "../src/tools.mjs";
import {
  BYTES_PER_TOKEN, TOKEN_MARGIN, SETTLE_MARKUP, SFW_IMAGE_TOKENS,
  SFW_QUOTE_IS_ESTIMATE, DECISION_RATES, SFW_MODEL, depositFromCharge,
  estimateTokensFromBytes, textBytes, openBudget, settledCharge,
  meteredWithinQuote, sfwChargeUsd,
} from "../src/subnano.mjs";

async function loadFixture() {
  const dir = await mkdtemp(join(tmpdir(), "sfw-bound-"));
  await copyFile(new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url), join(dir, "humanize-comment.noodle-graph.json"));
  const registry = await loadTools({ dirs: [dir], apiKey: "test-key", outDir: join(dir, "out"), log: () => {} });
  return { dir, registry };
}

test("decision pricing estimates text tokens from UTF-8 bytes", () => {
  const bytes = 3500;
  const tokens = estimateTokensFromBytes(bytes);
  assert.equal(tokens, Math.ceil(bytes / BYTES_PER_TOKEN * TOKEN_MARGIN));
  assert.ok(tokens > Math.ceil(bytes / BYTES_PER_TOKEN));
  assert.ok(tokens < bytes);
  assert.equal(textBytes("€"), 3);
  assert.equal(textBytes("🙂"), 4);
});

test("settlement is min(metered × 1.2, the quote), and a stage that does not fit stops the budget", () => {
  assert.equal(settledCharge(1, 0.01), 0.01);
  assert.equal(settledCharge(0.005, 1), 0.005 * SETTLE_MARKUP);
  assert.equal(meteredWithinQuote(1, 0.01), 0.01 / SETTLE_MARKUP);
  assert.ok(settledCharge(meteredWithinQuote(1, 0.01), 0.01) <= 0.01);

  const budget = openBudget(0.01);
  assert.equal(budget.fits(0.004), true);
  assert.equal(budget.fits(0.01), true);
  assert.equal(budget.fits(0.0100001), false);
  budget.add(0.006);
  assert.equal(budget.fits(0.0028), true);
  assert.equal(budget.fits(0.004), false);
  assert.ok(budget.remaining() < 0.004);
});

test("sfw_check's quote is a cap and still grows with each picture", async () => {
  assert.equal(SFW_QUOTE_IS_ESTIMATE, false);
  assert.equal(SFW_IMAGE_TOKENS, 1000);
  const { dir, registry } = await loadFixture();
  try {
    const sfw = registry.tools.find((t) => t.name === "sfw_check");
    assert.match(sfw.depositNote, /is a cap on the charge/);
    assert.doesNotMatch(sfw.depositNote, /estimate/);
    assert.match(sfw.description, /safe for work/);
    let prev = 0;
    for (let frames = 1; frames <= 8; frames++) {
      const charge = sfwChargeUsd({ images: 0, frames });
      assert.ok(charge > prev);
      const deposit = depositFromCharge(charge);
      assert.ok(settledCharge(charge / SETTLE_MARKUP, deposit) <= deposit);
      assert.ok(deposit <= charge * 1.12 + 1e-8);
      prev = charge;
    }
    const one = sfwChargeUsd({ images: 1, frames: 0 });
    const eight = sfwChargeUsd({ images: 1, frames: 8 });
    assert.ok(Math.abs(eight / one - 9) < 1e-6);
    const pin = DECISION_RATES[SFW_MODEL][0];
    assert.ok(one > SFW_IMAGE_TOKENS * pin / 1e6 * SETTLE_MARKUP);
    const budget = openBudget(depositFromCharge(one));
    budget.add(one / SETTLE_MARKUP);
    assert.equal(budget.fits(one), false, "a second picture does not fit a one-picture quote once the first one spent its reserve");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

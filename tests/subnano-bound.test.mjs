/**
 * The deposit is a cap by construction. Tokens are about bytes/3.5 plus a
 * margin, each stage's max_tokens is about 1.5× the draft, and settlement is
 * min(metered × 1.2, the quote). The run stops before a stage the remaining
 * budget cannot cover. sfw_check uses the same cap, one picture at a time.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTools } from "../src/tools.mjs";
import {
  BYTES_PER_TOKEN, TOKEN_MARGIN, OUTPUT_FACTOR, OUTPUT_SLACK, SETTLE_MARKUP,
  SFW_IMAGE_TOKENS, SFW_QUOTE_IS_ESTIMATE, TEXT_RATES, DECISION_RATES, REFINE_MODEL, SFW_MODEL,
  chatCallUsd, depositFromCharge, estimateTokensFromBytes, textBytes,
  outputTokenCap, outputByteCap, judgeTokenCap, openBudget, settledCharge, meteredWithinQuote,
  humanizeTextBytes, refineProviderUsd, subnanoChargeUsd, sfwChargeUsd,
} from "../src/subnano.mjs";
import { HUMANIZE_INPUT_CAPS, HUMANIZE_JUDGE_JSON_TOKENS, HUMANIZE_JUDGE_REASONING_TOKENS } from "../src/humanize.mjs";

const GRAPH_URL = new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url);

async function loadGraph() {
  const dir = await mkdtemp(join(tmpdir(), "subnano-bound-"));
  await copyFile(GRAPH_URL, join(dir, "humanize-comment.noodle-graph.json"));
  const registry = await loadTools({ dirs: [dir], apiKey: "test-key", outDir: join(dir, "out"), log: () => {} });
  return { dir, registry, graph: registry.tools.find((t) => t.name === "humanize-comment").wf.graph };
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("input tokens are bytes/3.5 plus a margin, under one token per byte", () => {
  assert.equal(BYTES_PER_TOKEN, 3.5);
  assert.equal(TOKEN_MARGIN, 1.1);
  const bytes = 3500;
  const tokens = estimateTokensFromBytes(bytes);
  assert.equal(tokens, Math.ceil(bytes / BYTES_PER_TOKEN * TOKEN_MARGIN));
  assert.ok(tokens > Math.ceil(bytes / BYTES_PER_TOKEN));
  assert.ok(tokens < bytes);
  assert.equal(textBytes("€"), 3);
  assert.equal(textBytes("🙂"), 4);
  assert.equal(outputTokenCap(240), Math.ceil(240 * OUTPUT_FACTOR / BYTES_PER_TOKEN) + OUTPUT_SLACK);
  assert.equal(outputByteCap(outputTokenCap(240)), Math.ceil(outputTokenCap(240) * BYTES_PER_TOKEN));
  const judgeFor = (writer) => writer + HUMANIZE_JUDGE_JSON_TOKENS + HUMANIZE_JUDGE_REASONING_TOKENS;
  assert.equal(judgeTokenCap(50), judgeFor(50));
  assert.equal(judgeTokenCap(400), judgeFor(400));
  assert.equal(judgeTokenCap(2000), judgeFor(2000));
  assert.ok(judgeTokenCap(2000) > 1600, "the graph's 1600 is not the request cap");

  const outTokens = outputTokenCap(240);
  const none = refineProviderUsd({ draftBytes: 0, contextBytes: 0, guidanceBytes: 0, outTokens });
  const more = refineProviderUsd({ draftBytes: bytes, contextBytes: 0, guidanceBytes: 0, outTokens });
  assert.ok(more > none);
  const pin = TEXT_RATES[REFINE_MODEL][0];
  assert.ok((more - none) * 1e6 < bytes * pin, "the estimate stays under one token per byte");
  const old = chatCallUsd(TEXT_RATES[REFINE_MODEL], bytes / 3, 2, 0);
  const realistic = chatCallUsd(TEXT_RATES[REFINE_MODEL], bytes, 2, 0);
  assert.ok(realistic > old * 0.5);
  assert.ok(realistic < chatCallUsd(TEXT_RATES[REFINE_MODEL], bytes, 2, 0) + 1);
  assert.ok(realistic < (bytes * pin) / 1e6);
});

test("the judge reads the clipped writer texts, and writers are not priced on their own completions", async () => {
  const { dir, graph } = await loadGraph();
  try {
    const outTokens = outputTokenCap(240);
    const sized = humanizeTextBytes(graph, { draftBytes: 100, contextBytes: 40, guidanceBytes: 10, outTokens });
    const one = outputByteCap(Math.min(600, outTokens));
    assert.equal(sized.writerOutBytes, one * 5);
    assert.ok(sized.judgeUserBytes >= sized.writerOutBytes, "judge input includes every clipped writer output");
    assert.ok(sized.judgeUserBytes >= 100 + 40 + 10, "judge input includes draft, context, and guidance");
    for (const letter of ["A", "B", "C", "D", "E"]) {
      assert.ok(sized.writers[letter].userBytes < one, "a writer prompt is measured before its completion is installed");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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

test("property and fuzz: the quote caps the charge, and a longer context never lowers it", async () => {
  const { dir, registry, graph } = await loadGraph();
  try {
    const caps = HUMANIZE_INPUT_CAPS;
    const ceiling = subnanoChargeUsd({
      graph,
      draftChars: caps.Draft,
      draftBytes: caps.Draft * 4,
      contextBytes: caps.Context * 4,
      guidanceBytes: caps.Guidance * 4,
    });
    const cold = registry.quoteDeposit("subnano_comment", {
      Draft: "😀".repeat(caps.Draft),
      Context: "😀".repeat(caps.Context),
      Guidance: "😀".repeat(caps.Guidance),
    });
    assert.equal(cold, depositFromCharge(ceiling));
    assert.ok(settledCharge(ceiling / SETTLE_MARKUP, cold) <= cold);

    const alphabet = ["a", " ", "€", "你", "🙂"];
    for (let seed = 1; seed <= 40; seed++) {
      const rng = mulberry32(seed);
      const pick = (cap) => {
        const n = Math.floor(rng() * (cap + 1));
        let s = "";
        for (let i = 0; i < n; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
        return s;
      };
      const draft = pick(caps.Draft) || "d";
      const context = pick(caps.Context) || "c";
      const guidance = pick(caps.Guidance);
      const lens = {
        graph,
        draftChars: [...draft].length,
        draftBytes: textBytes(draft),
        contextBytes: textBytes(context),
        guidanceBytes: textBytes(guidance),
      };
      const charge = subnanoChargeUsd(lens);
      const quoted = registry.quoteDeposit("subnano_comment", {
        Draft: draft, Context: context, ...(guidance ? { Guidance: guidance } : {}),
      });
      assert.equal(quoted, depositFromCharge(charge));
      assert.ok(settledCharge(charge / SETTLE_MARKUP, quoted) <= quoted + 1e-9, `seed ${seed}: charge escaped the quote`);
      assert.ok(charge <= ceiling + 1e-9, `seed ${seed} exceeded the ceiling`);
      const bigger = subnanoChargeUsd({ ...lens, contextBytes: lens.contextBytes + 7 });
      assert.ok(bigger >= charge);
      const metered = rng() * quoted * 3;
      assert.ok(settledCharge(meteredWithinQuote(metered, quoted), quoted) <= quoted + 1e-9);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sfw_check's quote is a cap and still grows with each picture", async () => {
  assert.equal(SFW_QUOTE_IS_ESTIMATE, false);
  assert.equal(SFW_IMAGE_TOKENS, 1000);
  const { dir, registry } = await loadGraph();
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

/**
 * subnano_comment's quote is an upper bound: one token per UTF-8 byte, output
 * at max_tokens, judge input at the clipped writer texts. sfw_check stays an
 * estimate because image tokens have no published cap. Property and fuzz checks
 * compare the quote to that charge.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTools } from "../src/tools.mjs";
import {
  CHAT_WRAPPER_TOKENS, DECISION_WRAPPER_TOKENS, SETTLE_MARKUP,
  SFW_IMAGE_TOKEN_CAP, SFW_QUOTE_IS_ESTIMATE, TEXT_RATES, DECISION_RATES, REFINE_MODEL, SFW_MODEL,
  chatCallUsd, depositFromCharge, textTokens, maxUtf8Bytes,
  humanizeTextBytes, refineProviderUsd, subnanoChargeUsd, sfwChargeUsd,
  maxWriterOutBytes,
} from "../src/subnano.mjs";
import { HUMANIZE_INPUT_CAPS, writerOutBytes } from "../src/humanize.mjs";

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

test("a text token is one UTF-8 byte, which is above a bytes/3 estimate", () => {
  const ascii = "a".repeat(3000);
  assert.equal(textTokens(ascii), 3000);
  assert.ok(textTokens(ascii) > ascii.length / 3);
  assert.equal(textTokens("€"), 3);
  assert.equal(textTokens("🙂"), 4);
  assert.equal(maxUtf8Bytes(HUMANIZE_INPUT_CAPS.Draft), HUMANIZE_INPUT_CAPS.Draft * 4);
  const pin = TEXT_RATES[REFINE_MODEL][0];
  const none = refineProviderUsd({ draftBytes: 0, contextBytes: 0, guidanceBytes: 0 });
  const more = refineProviderUsd({ draftBytes: 1000, contextBytes: 0, guidanceBytes: 0 });
  assert.ok(Math.abs((more - none) * 1e6 - 1000 * pin) < 1e-6, "each extra draft byte adds one prompt token");
  const old = chatCallUsd(TEXT_RATES[REFINE_MODEL], 1000 / 3, 2, 0);
  const bound = chatCallUsd(TEXT_RATES[REFINE_MODEL], 1000, 2, 0);
  assert.ok(bound > old);
  assert.equal(CHAT_WRAPPER_TOKENS, 256);
  assert.equal(DECISION_WRAPPER_TOKENS, 2048);
});

test("the judge reserve is the joined writer texts, not the draft", async () => {
  const { dir, graph } = await loadGraph();
  try {
    const sized = humanizeTextBytes(graph, { draftBytes: 100, contextBytes: 40, guidanceBytes: 10 });
    let writerCaps = 0;
    for (const letter of ["A", "B", "C", "D", "E"]) writerCaps += writerOutBytes(600);
    assert.equal(sized.writerOutBytes, writerCaps);
    assert.ok(sized.judgeUserBytes >= writerCaps, "judge input includes every clipped writer output");
    assert.ok(sized.judgeUserBytes >= 100 + 40 + 10, "judge input includes draft, context, and guidance");
    assert.equal(maxWriterOutBytes(graph), writerOutBytes(600));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("property and fuzz: the subnano quote is at least the byte-bounded charge, and within the ceiling", async () => {
  const { dir, registry, graph } = await loadGraph();
  try {
    const ceiling = subnanoChargeUsd({
      graph,
      refineDraftBytes: maxUtf8Bytes(HUMANIZE_INPUT_CAPS.Draft),
      contextBytes: maxUtf8Bytes(HUMANIZE_INPUT_CAPS.Context),
      guidanceBytes: maxUtf8Bytes(HUMANIZE_INPUT_CAPS.Guidance),
    });
    const cold = registry.quoteDeposit("subnano_comment", {
      Draft: "😀".repeat(HUMANIZE_INPUT_CAPS.Draft),
      Context: "😀".repeat(HUMANIZE_INPUT_CAPS.Context),
      Guidance: "😀".repeat(HUMANIZE_INPUT_CAPS.Guidance),
    });
    assert.equal(cold, depositFromCharge(ceiling));
    assert.ok(cold >= ceiling);

    const alphabet = ["a", " ", "€", "你", "🙂"];
    for (let seed = 1; seed <= 40; seed++) {
      const rng = mulberry32(seed);
      const pick = (cap) => {
        const n = Math.floor(rng() * (cap + 1));
        let s = "";
        for (let i = 0; i < n; i++) s += alphabet[Math.floor(rng() * alphabet.length)];
        return s;
      };
      const draft = pick(HUMANIZE_INPUT_CAPS.Draft) || "d";
      const context = pick(HUMANIZE_INPUT_CAPS.Context) || "c";
      const guidance = pick(HUMANIZE_INPUT_CAPS.Guidance);
      const lens = {
        graph,
        refineDraftBytes: textTokens(draft),
        contextBytes: textTokens(context),
        guidanceBytes: textTokens(guidance),
      };
      const charge = subnanoChargeUsd(lens);
      const quoted = registry.quoteDeposit("subnano_comment", {
        Draft: draft, Context: context, ...(guidance ? { Guidance: guidance } : {}),
      });
      assert.ok(quoted >= charge, `seed ${seed}: quote ${quoted} < charge ${charge}`);
      assert.equal(quoted, depositFromCharge(charge));
      assert.ok(charge <= ceiling + 1e-9, `seed ${seed} exceeded the ceiling`);
      const bigger = subnanoChargeUsd({ ...lens, contextBytes: lens.contextBytes + 7 });
      assert.ok(bigger >= charge);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sfw_check is labeled an estimate and still grows with each picture", async () => {
  assert.equal(SFW_QUOTE_IS_ESTIMATE, true);
  assert.equal(SFW_IMAGE_TOKEN_CAP, 16 * 16 * 8);
  const { dir, registry } = await loadGraph();
  try {
    const sfw = registry.tools.find((t) => t.name === "sfw_check");
    assert.match(sfw.depositNote, /it is an estimate, not an upper bound/);
    assert.match(sfw.description, /safe for work/);
    let prev = 0;
    for (let frames = 1; frames <= 8; frames++) {
      const charge = sfwChargeUsd({ images: 0, frames });
      assert.ok(charge > prev);
      const deposit = depositFromCharge(charge);
      assert.ok(deposit >= charge);
      assert.ok(deposit <= charge * 1.12 + 1e-8);
      prev = charge;
    }
    const one = sfwChargeUsd({ images: 1, frames: 0 });
    const eight = sfwChargeUsd({ images: 1, frames: 8 });
    assert.ok(Math.abs(eight / one - 9) < 1e-6);
    const pin = DECISION_RATES[SFW_MODEL][0];
    assert.ok(one > SFW_IMAGE_TOKEN_CAP * pin / 1e6 * SETTLE_MARKUP);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

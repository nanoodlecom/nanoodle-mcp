// humanize-comment quotes a deposit per request: the worst case that request
// can be charged, plus a small margin, never below that charge.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChargeGate } from "../src/gate.mjs";
import { loadTools } from "../src/tools.mjs";
import { humanizeFetch, HUMANIZE_INPUT_CAPS, ONE_THREAD_PREFIX, MAX_CHARS_LIMIT, collectSpans, reinsertSpans, tokenUpperBound, writerForwardByteCap, writerOutputTokenCap, checkHumanizeInputs } from "../src/humanize.mjs";
import {
  humanizeChargeUsd, humanizeDepositUsd, humanizeCeilingDepositUsd, humanizePriceTable, humanizeStageBudget,
  depositFromCharge, HUMANIZE_DEPOSIT_FLOOR_USD, HUMANIZE_DEPOSIT_MARGIN,
} from "../src/humanize-deposit.mjs";

const GATE_ADDR = "nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet";
const graph = JSON.parse(await readFile(new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url), "utf8"));

const TYPICAL = { Draft: "a".repeat(1500), Context: "We cut CI from 14 to 6 minutes." };
const SHORT = { Draft: "Thanks.", Context: "We cut CI." };
const MAXIMUM = {
  Draft: "a".repeat(HUMANIZE_INPUT_CAPS.Draft),
  Context: "c".repeat(HUMANIZE_INPUT_CAPS.Context),
  Guidance: ONE_THREAD_PREFIX + "g".repeat(HUMANIZE_INPUT_CAPS.Guidance),
  maxChars: MAX_CHARS_LIMIT,
};
const REPAIR = { Draft: "Please keep the name Ada Lovelace in the reply.", Context: "a note", keep: ["Ada Lovelace"] };

function covers(args) {
  const charge = humanizeChargeUsd(graph, args);
  const deposit = humanizeDepositUsd(graph, args);
  assert.ok(charge > 0, "the request has a charge");
  assert.ok(deposit + 1e-12 >= charge, `deposit ${deposit} is below the charge ${charge}`);
  assert.ok(deposit <= charge * (1 + 0.15) + 1e-8, `deposit ${deposit} is more than 15% over ${charge}`);
  assert.ok(deposit + 1e-12 >= charge * (1 + HUMANIZE_DEPOSIT_MARGIN) || deposit === HUMANIZE_DEPOSIT_FLOOR_USD);
  return deposit;
}

test("the margin is 12% with a $0.001 floor, and a tiny charge still clears the floor", () => {
  assert.equal(HUMANIZE_DEPOSIT_MARGIN, 0.12);
  assert.equal(HUMANIZE_DEPOSIT_FLOOR_USD, 0.001);
  assert.equal(depositFromCharge(0.0001), 0.001);
  assert.ok(depositFromCharge(0.0001) >= 0.0001);
});

test("short, typical, and maximum-length deposits cover their own worst case and grow with the input", () => {
  const short = covers(SHORT);
  const typical = covers(TYPICAL);
  const maximum = covers(MAXIMUM);
  assert.ok(short < typical, `${short} should be under the 1,500-character draft`);
  assert.ok(typical < maximum, `${typical} should be under the capped request`);
  assert.equal(typical.toFixed(8), "0.02735012");
  assert.equal(maximum.toFixed(8), "0.03565818");
  const ceiling = humanizeCeilingDepositUsd(graph);
  assert.ok(maximum <= ceiling + 1e-12);
  assert.equal(ceiling.toFixed(8), graph.x402.usd.toFixed(8));
});

test("the repair path is priced only when a protected span can be repaired, and the deposit covers it", () => {
  const plain = { Draft: REPAIR.Draft, Context: REPAIR.Context };
  const kept = covers(REPAIR);
  const without = covers(plain);
  assert.ok(kept > without, "the second decider pass raises the deposit");
  assert.ok(humanizeChargeUsd(graph, REPAIR) > humanizeChargeUsd(graph, plain));
  assert.ok(kept <= humanizeCeilingDepositUsd(graph) + 1e-12);
});

test("maxChars lowers the deposit and is the max_tokens the writer request sends", async () => {
  const open = { Draft: "a".repeat(200), Context: "c".repeat(200) };
  const capped = { ...open, maxChars: 40 };
  assert.ok(covers(capped) < covers(open));
  const record = {
    A: { model: "qwen/qwen3.8-27b-novelist" },
    B: { model: "deepseek/deepseek-v4.1-flash-1017" },
    C: { model: "TheDrummer/Cydonia-24B-v4.3", fallbackModel: "gemma-4-12b-it-starry-ocean" },
    D: { model: "qwen/qwen3.8-27b-antislop" },
    E: { model: "inception/mercury-3" },
  };
  let sent = null;
  const hf = humanizeFetch({
    record, draft: open.Draft, maxChars: 40,
    fetch: (_url, init) => {
      sent = JSON.parse(init.body);
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: "short" } }] }), { status: 200 }));
    },
  });
  await hf.fetch("http://x/api/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: record.A.model, max_tokens: 600, messages: [{ role: "user", content: open.Draft }] }),
  });
  assert.equal(sent.max_tokens, 40);
});

test("a higher catalog rate raises the deposit and the deposit still covers that rate", () => {
  const prices = humanizePriceTable({
    chat: [{ id: "z-ai/glm-5.3", pricing: { prompt: 1.2, completion: 2.2, unit: "per_million_tokens" } }],
  });
  const charge = humanizeChargeUsd(graph, TYPICAL, { prices });
  const deposit = humanizeDepositUsd(graph, TYPICAL, { prices });
  assert.ok(charge > humanizeChargeUsd(graph, TYPICAL));
  assert.ok(deposit > humanizeDepositUsd(graph, TYPICAL));
  assert.ok(deposit >= charge);
});

test("the quote shown to the caller is the deposit that is collected", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noodle-humanize-deposit-"));
  try {
    await copyFile(new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url), join(dir, "humanize-comment.noodle-graph.json"));
    const registry = await loadTools({ dirs: [dir], apiKey: "k", outDir: join(dir, "out"), log: () => {} });
    const gate = createChargeGate({
      address: GATE_ADDR,
      ops: { rpc: async () => ({ blocks: {}, history: [] }), transfer: async () => "0".repeat(64) },
      usd: 0.05,
      xnoUsd: 1,
      publicBase: "http://pay.test",
      validate: (p) => registry.prepareCall(p),
      log: () => {},
    });
    const { listTools, callTool } = gate.wrapRegistry(registry);
    const listed = listTools().find((t) => t.name === "humanize-comment");
    assert.match(listed.description, /a deposit is quoted for each request from its length and maxChars and covers the most that request can cost/);
    assert.doesNotMatch(listed.description, /paid in Nano|x402|0\.0196/);

    const quote = async (args) => {
      const result = await callTool({ name: "humanize-comment", arguments: args });
      return { text: result.content[0].text, x402: result.structuredContent.x402 };
    };
    const typical = await quote(TYPICAL);
    const expected = humanizeDepositUsd(graph, TYPICAL);
    assert.equal(typical.x402.amountUsd, expected);
    assert.match(typical.text, new RegExp(`\\$${expected.toFixed(8)} deposit`));
    const maximum = await quote(MAXIMUM);
    assert.equal(maximum.x402.amountUsd, humanizeDepositUsd(graph, MAXIMUM));
    assert.ok(typical.x402.amountUsd < maximum.x402.amountUsd);

    registry.catalogs = {
      chat: [{ id: "z-ai/glm-5.3", pricing: { prompt: 1.2, completion: 2.2 } }],
    };
    const repriced = await quote(TYPICAL);
    const atCatalog = humanizeDepositUsd(graph, TYPICAL, { prices: humanizePriceTable(registry.catalogs) });
    assert.equal(repriced.x402.amountUsd, atCatalog);
    assert.ok(atCatalog > expected);
    assert.ok(atCatalog >= humanizeChargeUsd(graph, TYPICAL, { prices: humanizePriceTable(registry.catalogs) }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a writer completion is cut to the byte cap the deposit prices", async () => {
  const record = {
    A: { model: "qwen/qwen3.8-27b-novelist" },
    B: { model: "deepseek/deepseek-v4.1-flash-1017" },
    C: { model: "TheDrummer/Cydonia-24B-v4.3", fallbackModel: "gemma-4-12b-it-starry-ocean" },
    D: { model: "qwen/qwen3.8-27b-antislop" },
    E: { model: "inception/mercury-3" },
  };
  let sent = null;
  const hf = humanizeFetch({
    record, draft: "hello",
    fetch: (_url, init) => {
      sent = JSON.parse(init.body);
      return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: "a".repeat(10000) } }] }), { status: 200 }));
    },
  });
  const res = await hf.fetch("http://x/api/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: record.A.model, max_tokens: 9000, messages: [{ role: "user", content: "hello" }] }),
  });
  const body = await res.json();
  const cap = writerForwardByteCap(writerOutputTokenCap(600, null));
  assert.equal(sent.max_tokens, 600, "output tokens cannot exceed the priced cap");
  assert.equal(tokenUpperBound(body.choices[0].message.content), cap);
});

test("the quote is at least the max charge, including a restore that grows 1732 bytes to 7726 and a request over the old ceiling", () => {
  const emoji = "😀";
  const draft = emoji.repeat(HUMANIZE_INPUT_CAPS.Draft);
  const keep = emoji.repeat(500);
  const { spans } = collectSpans(draft, [keep]);
  assert.equal(spans.length, 1);
  assert.equal(tokenUpperBound(spans[0].text), 6000);
  const raw = "y".repeat(1732 - "[[k1]]".length) + "[[k1]]";
  assert.equal(tokenUpperBound(raw), 1732);
  const restored = reinsertSpans(raw, spans);
  assert.equal(tokenUpperBound(restored), 7726, "putting the phrase back grows the candidate from 1,732 bytes to 7,726");
  const grew = { Draft: draft, Context: "a note", keep: [keep] };
  const budget = humanizeStageBudget(graph, grew);
  assert.ok(budget.candidateBytes >= 7726, `judge reserve ${budget.candidateBytes} is under the restored candidate`);
  const grewCharge = humanizeChargeUsd(graph, grew);
  const grewDeposit = humanizeDepositUsd(graph, grew);
  assert.ok(grewDeposit >= grewCharge);
  assert.equal(budget.chargeUsd, grewCharge);

  // This request quoted $0.02597835 under the old bytes/3 estimate, above the old $0.02198746 pin.
  const ember = {
    Draft: draft,
    Context: emoji.repeat(HUMANIZE_INPUT_CAPS.Context),
    Guidance: ONE_THREAD_PREFIX + emoji.repeat(HUMANIZE_INPUT_CAPS.Guidance),
    maxChars: MAX_CHARS_LIMIT,
  };
  const emberCharge = humanizeChargeUsd(graph, ember);
  const emberDeposit = humanizeDepositUsd(graph, ember);
  assert.ok(emberCharge > 0.02597835, `true charge ${emberCharge} is still under the old under-quote`);
  assert.ok(emberCharge > 0.02198746);
  assert.ok(emberDeposit >= emberCharge);
  const ceiling = humanizeCeilingDepositUsd(graph);
  assert.equal(ceiling.toFixed(8), "0.12230219");
  assert.ok(emberDeposit <= ceiling);
  assert.ok(grewDeposit <= ceiling);
  assert.equal(graph.x402.usd, ceiling);
});

test("fuzz: every legal request's deposit covers its own max charge and stays under the ceiling", () => {
  const ceiling = humanizeCeilingDepositUsd(graph);
  let seed = 0xC0FFEE;
  const rnd = () => {
    seed = Math.imul(seed ^ (seed >>> 15), 0x6D2B79F5) >>> 0;
    return seed / 4294967296;
  };
  const alphabet = ["a", "0", " ", "😀", "\n"];
  const piece = (n) => {
    let s = "";
    for (let i = 0; i < n; i++) s += alphabet[Math.floor(rnd() * alphabet.length)];
    return s;
  };
  for (let i = 0; i < 40; i++) {
    const draftN = 1 + Math.floor(rnd() * HUMANIZE_INPUT_CAPS.Draft);
    const ctxN = 1 + Math.floor(rnd() * HUMANIZE_INPUT_CAPS.Context);
    const gN = Math.floor(rnd() * (HUMANIZE_INPUT_CAPS.Guidance + 1));
    const Draft = piece(draftN);
    const Context = piece(ctxN);
    const Guidance = rnd() < 0.5 ? ONE_THREAD_PREFIX + piece(gN) : piece(gN);
    const args = { Draft, Context, Guidance };
    if (rnd() < 0.5) args.maxChars = 1 + Math.floor(rnd() * MAX_CHARS_LIMIT);
    if (rnd() < 0.4) args.ending = ["any", "question", "keep_last"][Math.floor(rnd() * 3)];
    if (rnd() < 0.5 && draftN >= 4) {
      const width = 1 + Math.floor(rnd() * Math.min(40, draftN));
      const at = Math.floor(rnd() * (draftN - width + 1));
      const phrase = [...Draft].slice(at, at + width).join("");
      if (phrase.trim()) args.keep = [phrase];
    }
    if (args.keep || args.ending || args.maxChars) {
      try { checkHumanizeInputs(args); }
      catch { continue; }
    }
    const charge = humanizeChargeUsd(graph, args);
    const deposit = humanizeDepositUsd(graph, args);
    const budget = humanizeStageBudget(graph, args);
    assert.ok(charge > 0);
    assert.ok(deposit + 1e-12 >= charge, `deposit ${deposit} < charge ${charge}`);
    assert.equal(budget.chargeUsd, charge);
    let units = 0;
    for (const call of budget.calls) units += call.inTokens * call.rate[0] + call.outTokens * call.rate[1];
    assert.ok(Math.abs(units / 1e6 * 1.2 - charge) < 1e-9);
    assert.ok(deposit <= ceiling + 1e-12, `deposit ${deposit} exceeds the ceiling ${ceiling}`);
    const { spans } = collectSpans(Draft, args.keep || []);
    const tokenCap = writerOutputTokenCap(600, args.maxChars);
    const worstRaw = "z".repeat(Math.max(0, writerForwardByteCap(tokenCap) - 6)) + (spans.length ? "[[k1]]" : "");
    const restored = reinsertSpans(worstRaw.slice(0, writerForwardByteCap(tokenCap)), spans);
    assert.ok(tokenUpperBound(restored) <= budget.candidateBytes, `restored ${tokenUpperBound(restored)} exceeds reserve ${budget.candidateBytes}`);
  }
});

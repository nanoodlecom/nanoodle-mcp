// humanize-comment quotes a deposit per request. The quote caps what the
// customer pays: the priced worst case plus a small margin, never below that
// charge. A provider can still meter more; the operator absorbs any overrun.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createChargeGate } from "../src/gate.mjs";
import { loadTools } from "../src/tools.mjs";
import { humanizeFetch, failureMessage, HUMANIZE_INPUT_CAPS, ONE_THREAD_PREFIX, MAX_CHARS_LIMIT, collectSpans, reinsertSpans, tokenUpperBound, writerForwardByteCap, requestOutputTokenCap, checkHumanizeInputs } from "../src/humanize.mjs";
import {
  humanizeChargeUsd, humanizeDepositUsd, humanizeCeilingDepositUsd, humanizePriceTable, humanizeStageBudget,
  depositFromCharge, settledChargeUsd, HUMANIZE_DEPOSIT_FLOOR_USD, HUMANIZE_DEPOSIT_MARGIN, HUMANIZE_MODEL_PRICES,
} from "../src/humanize-deposit.mjs";
import { budgetCap, knownUsd } from "../src/usd.mjs";

const GATE_ADDR = "nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet";
const PAYER = "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3";
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

test("known USD amounts accept an exponent and a leading dot, and reject garbage", () => {
  assert.equal(knownUsd("1e-3"), 0.001);
  assert.equal(knownUsd(".001"), 0.001);
  assert.equal(knownUsd("0.001"), 0.001);
  assert.equal(knownUsd(0.001), 0.001);
  assert.equal(knownUsd("1e-7"), 1e-7);
  assert.equal(knownUsd("2.5e-3"), 0.0025);
  assert.equal(knownUsd("  1E-3  "), 0.001);
  assert.equal(knownUsd("0"), 0);
  assert.equal(knownUsd(0), 0);
  for (const raw of ["", "   ", false, [], null, undefined, NaN, Infinity, -1, "-0.01", "nope", "1e-7xyz"]) {
    assert.equal(knownUsd(raw), null, JSON.stringify(raw));
  }
  assert.equal(budgetCap(null), null);
  assert.equal(budgetCap("1e-3"), 0.001);
  assert.equal(budgetCap(0), 0);
  assert.throws(() => budgetCap("nope"), /usable USD/);
  assert.throws(() => budgetCap(""), /usable USD/);
});

test("quotes and settlement accept an exponent and a leading dot", () => {
  assert.equal(depositFromCharge("1e-3"), depositFromCharge(0.001));
  assert.equal(depositFromCharge(".001"), depositFromCharge(0.001));
  assert.throws(() => depositFromCharge("nope"), /non-negative/);
  assert.equal(settledChargeUsd("1e-7", ".001"), 1e-7 * 1.2);
  assert.equal(settledChargeUsd(0.05, "1e-3"), 0.001);
  assert.equal(settledChargeUsd("1e-7", null), 1e-7 * 1.2);
  assert.throws(() => settledChargeUsd(0.05, "nope"), /usable USD/);
  const prices = humanizePriceTable({
    chat: [{ id: "qwen/qwen3.8-27b-novelist", pricing: { prompt: "1e-3", completion: ".5" } }],
  });
  assert.deepEqual(prices["qwen/qwen3.8-27b-novelist"], [0.001, 0.5]);
  const kept = humanizePriceTable({
    chat: [{ id: "qwen/qwen3.8-27b-novelist", pricing: { prompt: "nope", completion: ".5" } }],
  });
  assert.deepEqual(kept["qwen/qwen3.8-27b-novelist"], HUMANIZE_MODEL_PRICES["qwen/qwen3.8-27b-novelist"]);
});

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
  assert.ok(typical <= 0.012, `typical deposit ${typical} is above $0.012`);
  assert.equal(typical.toFixed(8), "0.00830015");
  assert.equal(maximum.toFixed(8), "0.02669910");
  const ceiling = humanizeCeilingDepositUsd(graph);
  assert.ok(maximum <= ceiling + 1e-12);
  assert.equal(ceiling.toFixed(8), "0.05012747");
  assert.equal(ceiling.toFixed(8), graph.x402.usd.toFixed(8));
});

test("a second decider pass is priced for a repair, a title, a length cap, or a required ending", () => {
  const plain = { Draft: REPAIR.Draft, Context: REPAIR.Context };
  const glm = (args) => humanizeStageBudget(graph, args).calls.filter((c) => c.model === "z-ai/glm-5.3").length;
  assert.equal(glm(plain), 1);
  for (const args of [REPAIR, { ...plain, title: true }, { ...plain, maxChars: 80 }, { ...plain, ending: "question" }, { ...plain, ending: "keep_last" }]) {
    assert.equal(glm(args), 2);
    assert.ok(covers(args) > covers(plain), JSON.stringify(args));
  }
  assert.ok(humanizeChargeUsd(graph, REPAIR) > humanizeChargeUsd(graph, plain));
});

test("maxChars is the writer max_tokens, and the deposit reserves the confirm pass", async () => {
  const open = { Draft: "a".repeat(200), Context: "c".repeat(200) };
  const capped = { ...open, maxChars: 40 };
  assert.ok(requestOutputTokenCap(40, open.Draft) < requestOutputTokenCap(null, open.Draft));
  assert.ok(covers(capped) > covers(open), "a length cap adds the decider's confirm pass");
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
  assert.equal(sent.max_tokens, requestOutputTokenCap(40, open.Draft));
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
    assert.match(listed.description, /a deposit is quoted for each request from its length and maxChars and caps what the customer pays/);
    assert.match(listed.description, /the operator absorbs any overrun/);
    assert.match(listed.description, /When Cydonia fails and the Starry Ocean fallback runs, both calls are charged/);
    assert.match(listed.description, /This refund and cap apply to hosted payments/);
    assert.match(listed.description, /Direct-wallet spending has no cap/);
    assert.doesNotMatch(listed.description, /paid in Nano|x402|0\.0196|proven|only one is billed|not both/);

    const quote = async (args) => {
      const result = await callTool({ name: "humanize-comment", arguments: args });
      return { text: result.content[0].text, x402: result.structuredContent.x402 };
    };
    const typical = await quote(TYPICAL);
    const expected = humanizeDepositUsd(graph, TYPICAL);
    assert.equal(typical.x402.amountUsd, expected);
    const shown = expected.toFixed(8).replace(/(\.\d*?)0+$/, "$1");
    assert.match(typical.text, new RegExp(`\\$${shown.replace(/\./g, "\\.")} deposit`));
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
  const capTokens = requestOutputTokenCap(null, "hello");
  const cap = writerForwardByteCap(capTokens);
  assert.equal(sent.max_tokens, capTokens, "output tokens are the request length plus a small slack");
  assert.equal(tokenUpperBound(body.choices[0].message.content), cap);
});

test("the quote is at least the max charge, including a restore that grows 1732 bytes to 7726", () => {
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

  const ember = {
    Draft: draft,
    Context: emoji.repeat(HUMANIZE_INPUT_CAPS.Context),
    Guidance: ONE_THREAD_PREFIX + emoji.repeat(HUMANIZE_INPUT_CAPS.Guidance),
    maxChars: MAX_CHARS_LIMIT,
  };
  const emberCharge = humanizeChargeUsd(graph, ember);
  const emberDeposit = humanizeDepositUsd(graph, ember);
  assert.ok(emberDeposit >= emberCharge);
  const ceiling = humanizeCeilingDepositUsd(graph);
  assert.equal(ceiling.toFixed(8), "0.05012747");
  assert.ok(emberDeposit <= ceiling);
  assert.ok(grewDeposit <= ceiling);
  assert.equal(graph.x402.usd, ceiling);
  // A meter past the quote still settles at the quote. The operator absorbs the rest.
  assert.ok(Math.abs(settledChargeUsd(emberCharge / 1.2, emberDeposit) - emberCharge) < 1e-9);
  assert.equal(settledChargeUsd(10, emberDeposit), emberDeposit);
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
    const tokenCap = requestOutputTokenCap(args.maxChars, Draft);
    const forward = writerForwardByteCap(tokenCap);
    const worstRaw = "z".repeat(Math.max(0, forward - 6)) + (spans.length ? "[[k1]]" : "");
    const restored = reinsertSpans(worstRaw.slice(0, forward), spans);
    assert.ok(tokenUpperBound(restored) <= budget.candidateBytes, `restored ${tokenUpperBound(restored)} exceeds reserve ${budget.candidateBytes}`);
    assert.ok(Math.abs(settledChargeUsd(charge / 1.2, deposit) - charge) < 1e-9);
    assert.equal(settledChargeUsd(charge, deposit), deposit);
  }
});

test("the run stops before the next paid step once metered spend would pass the deposit", async () => {
  const record = {
    A: { model: "qwen/qwen3.8-27b-novelist" },
    B: { model: "deepseek/deepseek-v4.1-flash-1017" },
    C: { model: "TheDrummer/Cydonia-24B-v4.3", fallbackModel: "gemma-4-12b-it-starry-ocean" },
    D: { model: "qwen/qwen3.8-27b-antislop" },
    E: { model: "inception/mercury-3" },
  };
  const seen = [];
  const budgetUsd = 0.01;
  const hf = humanizeFetch({
    record,
    draft: "a".repeat(1500),
    budgetUsd,
    prices: HUMANIZE_MODEL_PRICES,
    fetch: (_url, init) => {
      seen.push(JSON.parse(init.body).model);
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: "short reply" } }],
        x_nanogpt_pricing: { costUsd: 0.05 },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    },
  });
  const url = "http://x/api/v1/chat/completions";
  const call = (model) => hf.fetch(url, {
    method: "POST",
    body: JSON.stringify({ model, max_tokens: 600, messages: [{ role: "user", content: "a".repeat(1500) }] }),
  });
  await call(record.A.model);
  await call(record.B.model);
  await call("z-ai/glm-5.3");
  const verdict = await hf.state.reviewRepair("repaired", "A", record.A.model);
  assert.deepEqual(seen, [record.A.model], "only the call already started is paid; the next writer, the decider, and the repair are not");
  assert.equal(verdict.ok, false);
  assert.ok(hf.state.meteredUsd * 1.2 > budgetUsd, "the in-flight call can meter past the deposit");
  assert.equal(settledChargeUsd(hf.state.meteredUsd, budgetUsd), budgetUsd);
  assert.ok(hf.state.skippedForBudget.some((s) => s.kind === "primary"));
  assert.ok(hf.state.skippedForBudget.some((s) => s.kind === "decider"));

  // A quote smaller than the first estimate never starts a paid call.
  const blocked = [];
  const hf2 = humanizeFetch({
    record, draft: "a".repeat(1500), budgetUsd: 0.0000001, prices: HUMANIZE_MODEL_PRICES,
    fetch: () => { blocked.push(1); return Promise.resolve(new Response("{}", { status: 200 })); },
  });
  const quiet = await hf2.fetch(url, {
    method: "POST",
    body: JSON.stringify({ model: record.A.model, messages: [{ role: "user", content: "a".repeat(1500) }] }),
  });
  const body = await quiet.json();
  assert.deepEqual(blocked, []);
  assert.equal(hf2.state.meteredUsd, 0);
  assert.equal(body.x_nanogpt_pricing.costUsd, 0);
  assert.equal(settledChargeUsd(hf2.state.meteredUsd, 0.0000001), 0);

  // The decider can finish, and the repair after it is the step that does not start.
  const reviewSeen = [];
  const hf3 = humanizeFetch({
    record, draft: "hi", budgetUsd, prices: HUMANIZE_MODEL_PRICES,
    fetch: (_url, init) => {
      reviewSeen.push(JSON.parse(init.body).model);
      return Promise.resolve(new Response(JSON.stringify({
        choices: [{ message: { content: "{}" } }],
        x_nanogpt_pricing: { costUsd: 0.05 },
      }), { status: 200, headers: { "content-type": "application/json" } }));
    },
  });
  await hf3.fetch(url, {
    method: "POST",
    body: JSON.stringify({ model: "z-ai/glm-5.3", messages: [{ role: "user", content: "hi" }] }),
  });
  const repair = await hf3.state.reviewRepair("fixed phrase", "A", record.A.model);
  assert.deepEqual(reviewSeen, ["z-ai/glm-5.3"]);
  assert.equal(repair.ok, false);
  assert.ok(hf3.state.skippedForBudget.some((s) => s.kind === "review"));
  assert.equal(settledChargeUsd(hf3.state.meteredUsd, budgetUsd), budgetUsd);
});

test("copy says both fallback calls are charged, and the refund and cap are hosted-only", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  const deposit = await readFile(new URL("../src/humanize-deposit.mjs", import.meta.url), "utf8");
  for (const text of [readme, deposit]) {
    assert.doesNotMatch(text, /only one is billed/i);
    assert.doesNotMatch(text, /One of the two is billed/);
    assert.doesNotMatch(text, /not both/);
    assert.match(text, /When Cydonia fails and the Starry Ocean fallback runs,[\s*]*both calls are charged/);
    assert.match(text, /Direct-wallet spending has no cap/);
  }
  assert.match(readme, /This refund and cap apply to hosted payments/);
  const wallet = failureMessage({ billing: "wallet", attempts: [{ paid: true, usd: 0.01 }] });
  assert.match(wallet, /not refunded/);
  assert.match(wallet, /Direct-wallet spending has no cap/);
});

test("a hosted unusable decider with one guard-dropped writer errors and refunds the deposit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noodle-humanize-refund-"));
  const guidance = "Keep it to one friendly sentence and do not add facts.";
  const draft = "Thanks for the note.";
  const transfers = [];
  const events = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      const content = body.model === "z-ai/glm-5.3" ? "not a ranking" : body.model && body.model.includes("novelist") ? guidance : "Glad you wrote this up.";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content } }], x_nanogpt_pricing: { costUsd: 0.0001 } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const receivable = {};
  try {
    await copyFile(new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url), join(dir, "humanize-comment.noodle-graph.json"));
    const registry = await loadTools({
      dirs: [dir], apiKey: "test-key", hosted: true,
      baseUrl: "http://127.0.0.1:" + server.address().port,
      outDir: join(dir, "out"), log: () => {},
    });
    const gate = createChargeGate({
      address: GATE_ADDR,
      ops: {
        rpc: async (body) => {
          if (body.action === "receivable") return { blocks: { ...receivable } };
          if (body.action === "account_history") return { history: [] };
          throw new Error("unexpected rpc " + body.action);
        },
        transfer: async (to, amountRaw, describe) => {
          transfers.push({ to, amountRaw, describe });
          return "F".repeat(64);
        },
        pocket: async () => {},
      },
      usd: 0.05,
      xnoUsd: 1,
      publicBase: "http://pay.test",
      pollMs: 10,
      waitMs: 300,
      validate: (p) => registry.prepareCall(p),
      usage: (e, f) => events.push([e, f]),
      log: () => {},
    });
    const { callTool } = gate.wrapRegistry(registry);
    const args = { Draft: draft, Context: "A short post.", Guidance: guidance };
    const quote = await callTool({ name: "humanize-comment", arguments: args });
    const x = quote.structuredContent.x402;
    receivable["B".repeat(64)] = { amount: x.amountRaw, source: PAYER };
    const res = await callTool({ name: "humanize-comment", arguments: { ...args, _payment_id: x.paymentId } });
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /not valid JSON with a ranked list/);
    assert.match(res.content[0].text, /refunded to/);
    assert.doesNotMatch(res.content[0].text, /winner/);
    assert.equal(res.content[0].text.includes(draft), false);
    const deadline = Date.now() + 5000;
    while (transfers.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(transfers, [{ to: PAYER, amountRaw: x.amountRaw, describe: "refunded" }]);
    const refund = events.find(([e]) => e === "refund");
    assert.equal(refund[1].reason, "run_failed");
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a hosted run refuses an invoice the quote cannot cover, and a direct wallet pays it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noodle-humanize-cap-"));
  const prevKey = process.env.NANOGPT_API_KEY;
  const prevFetch = globalThis.fetch;
  delete process.env.NANOGPT_API_KEY;
  try {
    await copyFile(new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url), join(dir, "humanize-comment.noodle-graph.json"));
    const run = async (hosted) => {
      let payments = 0;
      let n = 0;
      globalThis.fetch = async (url, init) => {
        const u = String(url);
        if (u.includes("/complete/")) {
          return new Response(JSON.stringify({ choices: [{ message: { content: "a short rewrite" } }] }), { status: 200, headers: { "content-type": "application/json" } });
        }
        const headers = init && init.headers;
        const pid = headers && (headers["x-x402-payment-id"] || (typeof headers.get === "function" && headers.get("x-x402-payment-id")));
        if (pid) {
          return new Response(JSON.stringify({ choices: [{ message: { content: "a short rewrite" } }], x_nanogpt_pricing: { costUsd: 0.0001 } }), { status: 200, headers: { "content-type": "application/json" } });
        }
        n += 1;
        const id = (hosted ? "h" : "w") + n;
        return new Response(JSON.stringify({
          payment: { paymentId: id, accepted: [{ scheme: "nano", payTo: "nano_1stub", maxAmountRequired: "1000", maxAmountRequiredUSD: 0.01, completeUrl: "http://x/api/x402/complete/" + id }] },
        }), { status: 402, headers: { "content-type": "application/json" } });
      };
      const registry = await loadTools({
        dirs: [dir],
        payment: async () => { payments += 1; },
        baseUrl: "http://x",
        outDir: join(dir, "out"),
        log: () => {},
        hosted,
      });
      try {
        await registry.callTool({ name: "humanize-comment", arguments: { Draft: "Thanks.", Context: "We cut CI." } });
      } catch { /* the payment count is the assertion */ }
      return payments;
    };
    assert.equal(await run(true), 0, "hosted refuses the $0.01 invoice");
    const walletPayments = await run(false);
    assert.ok(walletPayments > 0, "direct-wallet spending has no cap, payments=" + walletPayments);
  } finally {
    globalThis.fetch = prevFetch;
    if (prevKey === undefined) delete process.env.NANOGPT_API_KEY;
    else process.env.NANOGPT_API_KEY = prevKey;
    await rm(dir, { recursive: true, force: true });
  }
});

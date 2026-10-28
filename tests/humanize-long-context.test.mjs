// Long-context humanize-comment calls: the quote covers the decider's worst
// case, and writer re-asks cannot spend the room the decider needs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, copyFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createChargeGate } from "../src/gate.mjs";
import { loadTools } from "../src/tools.mjs";
import { humanizeFetch, HUMANIZE_SETTLE_MARKUP } from "../src/humanize.mjs";
import {
  humanizeChargeUsd, humanizeDepositUsd, humanizeDeciderReserveUsd, humanizeStageBudget, HUMANIZE_MODEL_PRICES,
} from "../src/humanize-deposit.mjs";

const GATE_ADDR = "nano_1qs6dkbx5336j7szmhab3i6et8qcuybx84o1er73kp88k43ct7jg3pekjaet";
const PAYER = "nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3";
const FIXTURE = new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url);
const graph = JSON.parse(await readFile(FIXTURE, "utf8"));

const SENTENCE = "Our team migrated the monorepo build to a remote cache and saw CI drop from 14 minutes to 6 on average across 400 runs. ";
const LONG = {
  Draft: "This is great work, honestly the cache change is what made the difference for us too. ".repeat(6).slice(0, 500),
  Context: SENTENCE.repeat(40).slice(0, 3500),
};
const SHORT = { Draft: "Thanks, this helped a lot.", Context: "We cut CI." };

test("a long-context quote prices the decider from the caller's context and candidates", () => {
  const budget = humanizeStageBudget(graph, LONG);
  const decider = budget.calls.filter((c) => c.kind === "decider");
  assert.equal(decider.length, 1);
  const callerBytes = Buffer.byteLength(LONG.Draft) + Buffer.byteLength(LONG.Context) + Buffer.byteLength(graph.nodes.find((n) => n.id === "guidance").fields.text);
  assert.ok(decider[0].inTokens >= Math.ceil(callerBytes / 2.5), "caller text on the decider is priced at the dense token rate");
  assert.ok(decider[0].inTokens >= Math.ceil(5 * budget.candidateBytes / 3.5), "and the five candidate rewrites are in it");
  const reserve = humanizeDeciderReserveUsd(graph, LONG);
  const deposit = humanizeDepositUsd(graph, LONG);
  assert.ok(reserve * HUMANIZE_SETTLE_MARKUP < deposit, "the decider fits inside the deposit");
  assert.ok(deposit >= humanizeChargeUsd(graph, LONG));
  // The reserve grows with the context, so a long call is not priced like a short one.
  assert.ok(humanizeDeciderReserveUsd(graph, SHORT) < reserve);
});

test("a short call's quote is not inflated by the decider reserve", () => {
  const deposit = humanizeDepositUsd(graph, SHORT);
  // main before this change quoted 0.00358265 for this call.
  assert.ok(deposit <= 0.00358265 * 1.01, `short deposit ${deposit} grew more than 1%`);
});

test("writer re-asks cannot spend the decider's reserve", async () => {
  const record = {
    A: { model: "qwen/qwen3.8-27b-novelist" },
    B: { model: "deepseek/deepseek-v4.1-flash-1017" },
    C: { model: "TheDrummer/Cydonia-24B-v4.3", fallbackModel: "gemma-4-12b-it-starry-ocean" },
    D: { model: "qwen/qwen3.8-27b-antislop" },
    E: { model: "inception/mercury-3" },
  };
  const json = (cost) => Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }], x_nanogpt_pricing: { costUsd: cost } }), { status: 200 }));
  const hf = humanizeFetch({ record, draft: "x", budgetUsd: 0.01, deciderReserveUsd: 0.0072, prices: HUMANIZE_MODEL_PRICES, fetch: () => json(0.001) });
  const url = "http://x/api/v1/chat/completions";
  const body = (model) => ({ method: "POST", body: JSON.stringify({ model, max_tokens: 600, messages: [{ role: "user", content: "a".repeat(10000) }] }) });
  // Each writer holds ~$0.00065 and meters $0.001. The first fits next to the
  // $0.0072 reserve; the second would only fit if it could spend the reserve.
  await hf.fetch(url, body(record.A.model));
  await hf.fetch(url, body(record.B.model));
  assert.ok(hf.state.skippedForBudget.some((s) => s.kind === "primary"), "the writer that would eat the reserve is skipped");
  await hf.fetch(url, body("z-ai/glm-5.3"));
  assert.equal(hf.state.skippedForBudget.some((s) => s.kind === "decider"), false, "the decider still runs");
  assert.equal(hf.state.deciderReserveUsd, 0, "the decider's own hold replaced the reserve");
});

test("hosted long-context call: near-copy re-asks run, and the decider is not skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "noodle-humanize-long-"));
  const seen = [];
  // Bill each call at 3 bytes per token on its input and the full max_tokens on
  // output: denser than the 3.5 the writers are priced at. Writers copy the draft,
  // so the run spends its re-asks. On main this skipped the decider and refunded.
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const b = raw ? JSON.parse(raw) : {};
      const inBytes = (b.messages || []).reduce((a, m) => a + Buffer.byteLength(String(m.content || "")), 0);
      const r = HUMANIZE_MODEL_PRICES[b.model] || [0, 0];
      const costUsd = (Math.ceil(inBytes / 3) * r[0] + (b.max_tokens || 500) * r[1]) / 1e6;
      seen.push(b.model);
      const content = b.model === "z-ai/glm-5.3"
        ? JSON.stringify({ winner: "A", why: "faithful", ranked: ["A", "B", "C", "D", "E"].map((w) => ({ writer: w, faithful: true, disqualified: false, reason: "ok" })) })
        : LONG.Draft;
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }], x_nanogpt_pricing: { costUsd } }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    await copyFile(FIXTURE, join(dir, "humanize-comment.noodle-graph.json"));
    const registry = await loadTools({ dirs: [dir], apiKey: "test-key", hosted: true, baseUrl: "http://127.0.0.1:" + server.address().port, outDir: join(dir, "out"), log: () => {} });
    const receivable = {};
    const gate = createChargeGate({
      address: GATE_ADDR,
      ops: {
        rpc: async (b) => (b.action === "receivable" ? { blocks: { ...receivable } } : { history: [] }),
        transfer: async () => "F".repeat(64),
        pocket: async () => {},
      },
      usd: 0.05, xnoUsd: 1, publicBase: "http://pay.test", pollMs: 10, waitMs: 300,
      validate: (p) => registry.prepareCall(p), log: () => {},
    });
    const { callTool } = gate.wrapRegistry(registry);
    const quote = await callTool({ name: "humanize-comment", arguments: LONG });
    const x = quote.structuredContent.x402;
    assert.equal(x.amountUsd, humanizeDepositUsd(graph, LONG));
    receivable["B".repeat(64)] = { amount: x.amountRaw, source: PAYER };
    const res = await callTool({ name: "humanize-comment", arguments: { ...LONG, _payment_id: x.paymentId } });
    const text = res.content[0].text;
    assert.doesNotMatch(text, /decider was skipped/);
    assert.notEqual(res.isError, true, text.slice(0, 300));
    assert.ok(seen.includes("z-ai/glm-5.3"), "the decider ran");
    assert.ok(seen.length > 6, "at least one re-ask ran before the decider");
  } finally {
    server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

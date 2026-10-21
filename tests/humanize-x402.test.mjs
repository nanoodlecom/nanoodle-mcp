// humanize-comment over x402 (keyless, payment callback), end to end against a stub NanoGPT:
// 402 invoice → pay → complete → result. No real money, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTools } from "../src/tools.mjs";
import { humanizeFetch } from "../src/humanize.mjs";

const DRAFT = "Thanks for sharing this, the drop from 14 to 6 minutes on CI is really great work.";
const CYD = "TheDrummer/Cydonia-24B-v4.3", STARRY = "gemma-4-12b-it-starry-ocean", ANTI = "qwen/qwen3.8-27b-antislop";
const PRICE = 0.0001;
delete process.env.NANOGPT_API_KEY; // keyless runs only: never fall back to an ambient key

/** Stub NanoGPT speaking x402. `plan(body, phase)` → { status } to fail, or { content }. */
async function stub(t, { plan, settleOnly = () => false }) {
  const invoices = new Map(); // paymentId → { body (exact string), paid, completed }
  const log = { chat: [], complete: [], replays: [] };
  let n = 0;
  const srv = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const send = (status, j) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(j)); };
      const answer = (bodyStr) => {
        const b = JSON.parse(bodyStr);
        const p = plan(b, "result");
        if (p.status) return send(p.status, { error: "upstream failed" });
        return send(200, { model: b.model, choices: [{ message: { content: p.content } }], x_nanogpt_pricing: { costUsd: PRICE } });
      };
      const m = req.url.match(/^\/api\/x402\/complete\/(.+)$/);
      if (m) {
        const inv = invoices.get(m[1]);
        log.complete.push(m[1]);
        if (!inv) return send(404, { error: "no such payment" });
        if (!inv.paid) return send(402, { error: "not verified yet" });
        if (inv.completed) return send(409, { error: "payment already used" });
        inv.completed = true;
        if (settleOnly(JSON.parse(inv.body))) return send(200, { status: "paid", paymentId: m[1] });
        return answer(inv.body);
      }
      if (req.url !== "/api/v1/chat/completions") return send(404, {});
      const b = JSON.parse(raw);
      const pid = req.headers["x-x402-payment-id"];
      if (pid) { // replay after a settle-only receipt: must be the exact invoiced body, once
        const inv = invoices.get(pid);
        log.replays.push({ pid, model: b.model, same: !!inv && inv.body === raw });
        if (!inv || inv.body !== raw || inv.replayed) return send(402, { error: "payment does not match this request" });
        inv.replayed = true;
        return answer(raw);
      }
      const reask = b.messages.length > 2;
      log.chat.push(b.model + (reask ? " (re-ask)" : ""));
      const pre = plan(b, "pre");
      if (pre && pre.status) return send(pre.status, { error: "overloaded" });
      const id = "pay" + (++n);
      invoices.set(id, { body: raw, paid: false, model: b.model });
      return send(402, { payment: { paymentId: id, accepted: [{ scheme: "nano", payTo: "nano_1stub", maxAmountRequired: "1000", maxAmountRequiredUSD: PRICE, completeUrl: "/api/x402/complete/" + id }] } });
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  t.after(() => srv.close());
  const paid = [];
  const payment = async (inv) => {
    paid.push(inv.paymentId);
    const rec = invoices.get(inv.paymentId);
    assert.ok(rec, "paying a known invoice");
    assert.equal(rec.paid, false, "an invoice is never paid twice");
    rec.paid = true;
  };
  const dir = await mkdtemp(join(tmpdir(), "noodle-humanize-x402-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url), join(dir, "humanize-comment.noodle-graph.json"));
  const registry = await loadTools({ dirs: [dir], payment, baseUrl: "http://127.0.0.1:" + srv.address().port, outDir: join(dir, "out"), log: () => {} });
  const run = async () => {
    const result = await registry.callTool({ name: "humanize-comment", arguments: { Draft: DRAFT, Context: "We cut CI from 14 to 6 minutes." } });
    const texts = result.content.map((c) => c.text || "");
    const jt = texts.find((x) => /^\{"winner"/.test(x));
    return { result, texts, json: jt ? JSON.parse(jt) : null };
  };
  return { run, paid, invoices, log };
}

const judge = (winner = "A") => JSON.stringify({ winner, text: "x", why: "warm", ranked: ["A", "B", "C", "D", "E"].map((w) => ({ writer: w, faithful: true, disqualified: false, reason: "ok" })) });
const near = (a, b) => Math.abs(a - b) < 1e-12;
const paidOncePerInvoice = (s) => {
  assert.equal(new Set(s.paid).size, s.paid.length, "no invoice paid twice");
  for (const [id, inv] of s.invoices) if (inv.paid) assert.ok(s.paid.includes(id));
};

test("x402 normal: writer invoices are settled by the wrapper, dashes fixed, one payment per call, exact cost", async (t) => {
  const s = await stub(t, { plan: (b) => ({ content: b.model === "z-ai/glm-5.3" ? judge("A") : b.model === "qwen/qwen3.8-27b-novelist" ? "Nice one \u2014 14 to 6 is a real cut." : "rewrite by " + b.model }) });
  const { result, texts, json } = await s.run();
  assert.notEqual(result.isError, true, texts.join("\n"));
  assert.equal(json.winner, "A");
  assert.equal(json.text, "Nice one, 14 to 6 is a real cut.", "the dash fix ran on the x402 path");
  assert.equal(json.ranked.find((r) => r.writer === "C").model, CYD);
  assert.equal(s.paid.length, 6, "5 writers + decider, each paid once");
  paidOncePerInvoice(s);
  assert.equal(s.log.replays.length, 0);
  assert.ok(near(result.costUsd, 6 * PRICE), String(result.costUsd));
});

test("x402 fallback: Cydonia 429 before any invoice → Starry invoice paid and replayed with Starry's own body, never Cydonia's", async (t) => {
  const s = await stub(t, {
    plan: (b, phase) => (b.model === CYD && phase === "pre" ? { status: 429 } : { content: b.model === "z-ai/glm-5.3" ? judge("C") : "rewrite by " + b.model }),
    settleOnly: (b) => b.model === STARRY, // complete answers a bare receipt, so the wrapper must replay
  });
  const { result, texts, json } = await s.run();
  assert.notEqual(result.isError, true, texts.join("\n"));
  const c = json.ranked.find((r) => r.writer === "C");
  assert.equal(c.model, STARRY);
  assert.equal(c.text, "rewrite by " + STARRY);
  assert.equal(json.winner, "C");
  assert.deepEqual(s.log.replays, [{ pid: s.log.replays[0].pid, model: STARRY, same: true }], "one replay, Starry's exact invoiced body");
  assert.equal([...s.invoices.values()].filter((i) => i.model === CYD).length, 0, "no Cydonia invoice was ever issued or paid");
  assert.equal(s.paid.length, 6);
  paidOncePerInvoice(s);
  assert.ok(texts.some((x) => /writer C \(TheDrummer\/Cydonia-24B-v4\.3\) did not answer \(HTTP 429\), so gemma-4-12b-it-starry-ocean wrote C's rewrite/.test(x)));
  assert.ok(near(result.costUsd, 6 * PRICE), String(result.costUsd));
});

test("x402 paid primary that fails: no fallback, no second payment, its cost stays in the total", async (t) => {
  const s = await stub(t, { plan: (b, phase) => (b.model === CYD && phase === "result" ? { status: 503 } : { content: b.model === "z-ai/glm-5.3" ? judge("A") : "rewrite by " + b.model }) });
  const { result, texts, json } = await s.run();
  assert.notEqual(result.isError, true, texts.join("\n"));
  assert.ok(!s.log.chat.includes(STARRY), "no fallback after paying for Cydonia");
  assert.equal(s.paid.length, 6);
  paidOncePerInvoice(s);
  const c = json.ranked.find((r) => r.writer === "C");
  assert.equal(c.text, ""); assert.equal(c.reason, "missing"); assert.equal(c.model, CYD);
  assert.ok(texts.some((x) => /writer C \(TheDrummer\/Cydonia-24B-v4\.3\) was paid for but did not return a rewrite \(503\); no fallback was tried/.test(x)));
  assert.ok(near(result.costUsd, 6 * PRICE), "the paid-but-failed Cydonia call is counted: " + result.costUsd);
});

test("x402 both fail: Cydonia 429 and Starry 503 → truthful notice, nothing paid for C", async (t) => {
  const s = await stub(t, { plan: (b, phase) => (phase === "pre" && (b.model === CYD || b.model === STARRY) ? { status: b.model === CYD ? 429 : 503 } : { content: b.model === "z-ai/glm-5.3" ? judge("A") : "rewrite by " + b.model }) });
  const { result, texts, json } = await s.run();
  assert.notEqual(result.isError, true, texts.join("\n"));
  assert.equal(s.paid.length, 5, "4 writers + decider");
  paidOncePerInvoice(s);
  assert.ok(!texts.some((x) => /wrote C's rewrite and is credited/.test(x)), "no success claim");
  assert.ok(texts.some((x) => /writer C \(TheDrummer\/Cydonia-24B-v4\.3\) did not answer \(HTTP 429\), and the fallback gemma-4-12b-it-starry-ocean also failed \(HTTP 503\), so writer C has no rewrite this run/.test(x)));
  assert.equal(json.ranked.find((r) => r.writer === "C").reason, "missing");
  assert.ok(near(result.costUsd, 5 * PRICE), String(result.costUsd));
});

test("x402 re-ask: the near-copy re-ask gets its own invoice, paid once, and replaces the first answer", async (t) => {
  const s = await stub(t, { plan: (b) => ({ content: b.model === "z-ai/glm-5.3" ? judge("D") : b.model === ANTI ? (b.messages.length > 2 ? "You took CI from 14 to 6 minutes. Thanks!" : DRAFT) : "rewrite by " + b.model }) });
  const { result, texts, json } = await s.run();
  assert.notEqual(result.isError, true, texts.join("\n"));
  assert.deepEqual(s.log.chat.filter((c) => c.startsWith(ANTI)).sort(), [ANTI, ANTI + " (re-ask)"]);
  assert.equal(json.ranked.find((r) => r.writer === "D").text, "You took CI from 14 to 6 minutes. Thanks!");
  assert.equal(json.text, "You took CI from 14 to 6 minutes. Thanks!");
  assert.equal(s.paid.length, 7, "5 writers + 1 re-ask + decider");
  paidOncePerInvoice(s);
  assert.ok(near(result.costUsd, 7 * PRICE), String(result.costUsd));
});

test("re-ask deadline: a re-ask that runs out of time is abandoned and the first answer (and its cost) is kept", async () => {
  const record = { A: { model: "a" }, B: { model: "b" }, C: { model: "c" }, D: { model: "d" }, E: { model: "e" } };
  let calls = 0;
  const hf = humanizeFetch({ record, draft: "one two three four five six", reaskEndMs: 60, fetch: (u, init) => {
    calls++;
    if (JSON.parse(init.body).messages.length > 1) return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
    return Promise.resolve(new Response(JSON.stringify({ choices: [{ message: { content: "one two three four five six" } }], x_nanogpt_pricing: { costUsd: 0.002 } }), { status: 200 }));
  } });
  const t0 = Date.now();
  const r = await hf.fetch("http://x/api/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: "d", messages: [{ role: "user", content: "hi" }] }) });
  assert.ok(Date.now() - t0 < 2000, "bounded by its own deadline, not the 60 s node timeout");
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.choices[0].message.content, "one two three four five six", "first answer kept");
  assert.equal(calls, 2);
  assert.match(hf.state.reasked.D.failed, /no answer within 0 s of the writer call/);
  assert.equal(hf.state.answered.D, "d");
  // keyed mode: an abandoned request may still be billed, so the total is marked inexact rather than dropped
  assert.equal(j.x_nanogpt_pricing, undefined);
  assert.ok(near(hf.state.unreportedUsd, 0.002));
  assert.equal(hf.state.costUnknown, true);
});

test("key mode: a failed fallback's billed cost still reaches the run total, and a 402 is never paid by the wrapper", async () => {
  const record = { A: { model: "a" }, B: { model: "b" }, C: { model: CYD, fallbackModel: STARRY }, D: { model: "d" }, E: { model: "e" } };
  const hf = humanizeFetch({ record, draft: "", fetch: (u, init) => {
    const m = JSON.parse(init.body).model;
    return Promise.resolve(new Response(JSON.stringify(m === CYD ? { error: "x" } : { error: "y", cost: 0.0003 }), { status: m === CYD ? 500 : 502 }));
  } });
  const r = await hf.fetch("http://x/api/v1/chat/completions", { method: "POST", body: JSON.stringify({ model: CYD, messages: [] }) });
  assert.equal(r.status, 502);
  assert.equal(hf.state.fallback.C.ok, false);
  assert.equal(hf.state.fallback.C.failed, "HTTP 502");
  const hf2 = humanizeFetch({ record, draft: "", payment: null, fetch: () => Promise.resolve(new Response("{}", { status: 402 })) });
  const r2 = await hf2.fetch("http://x/api/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer k" }, body: JSON.stringify({ model: CYD, messages: [] }) });
  assert.equal(r2.status, 402);
  assert.deepEqual(hf2.state.fallback, {});
});

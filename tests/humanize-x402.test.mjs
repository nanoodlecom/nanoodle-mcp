// humanize-comment over x402 (keyless, payment callback), end to end against a stub NanoGPT:
// 402 invoice → pay → complete → result. No real money, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadTools } from "../src/tools.mjs";
import { humanizeFetch, requestOutputTokenCap } from "../src/humanize.mjs";
import { HUMANIZE_MODEL_PRICES } from "../src/humanize-deposit.mjs";

const DRAFT = "Thanks for sharing this, the drop from 14 to 6 minutes on CI is really great work.";
const CYD = "TheDrummer/Cydonia-24B-v4.3", STARRY = "gemma-4-12b-it-starry-ocean", ANTI = "qwen/qwen3.8-27b-antislop";
const PRICE = 0.0001;
delete process.env.NANOGPT_API_KEY; // keyless runs only: never fall back to an ambient key

/** Stub NanoGPT speaking x402. `plan(body, phase)` → { status } to fail, or { content }.
 * `priceOf(body)` null omits a price. `invoiceUsd(body)` is the 402 amount. */
async function stub(t, { plan, settleOnly = () => false, invoiceUsd = () => PRICE, priceOf = () => PRICE }) {
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
        const payload = { model: b.model, choices: [{ message: { content: p.content } }] };
        const usd = priceOf(b);
        if (usd != null) payload.x_nanogpt_pricing = { costUsd: usd };
        return send(200, payload);
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
      const quoted = invoiceUsd(b);
      invoices.set(id, { body: raw, paid: false, model: b.model, usd: quoted });
      return send(402, { payment: { paymentId: id, accepted: [{ scheme: "nano", payTo: "nano_1stub", maxAmountRequired: "1000", maxAmountRequiredUSD: quoted, completeUrl: "/api/x402/complete/" + id }] } });
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
    if (hook) await hook(inv, rec);
    rec.paid = true;
  };
  const dir = await mkdtemp(join(tmpdir(), "noodle-humanize-x402-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await copyFile(new URL("./fixtures/hosted/humanize-comment.noodle-graph.json", import.meta.url), join(dir, "humanize-comment.noodle-graph.json"));
  const registry = await loadTools({ dirs: [dir], payment, baseUrl: "http://127.0.0.1:" + srv.address().port, outDir: join(dir, "out"), log: () => {} });
  let hook = null;
  const run = async (args) => {
    const result = await registry.callTool({ name: "humanize-comment", arguments: args || { Draft: DRAFT, Context: "We cut CI from 14 to 6 minutes." } });
    const texts = result.content.map((c) => c.text || "");
    const jt = texts.find((x) => /^\{"winner"/.test(x));
    return { result, texts, json: jt ? JSON.parse(jt) : null };
  };
  const runWith = async (h) => { hook = h; try { return await run(); } finally { hook = null; } };
  return { run, runWith, paid, invoices, log };
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
  assert.ok(near(hf.state.unreportedUsd, 0.0003), "the priced 502 is counted, not dropped: " + hf.state.unreportedUsd);
  assert.equal(hf.state.costUnknown, false);
  assert.equal(hf.state.fallback.C.ok, false);
  assert.equal(hf.state.fallback.C.failed, "HTTP 502");
  const hf2 = humanizeFetch({ record, draft: "", payment: null, fetch: () => Promise.resolve(new Response("{}", { status: 402 })) });
  const r2 = await hf2.fetch("http://x/api/v1/chat/completions", { method: "POST", headers: { Authorization: "Bearer k" }, body: JSON.stringify({ model: CYD, messages: [] }) });
  assert.equal(r2.status, 402);
  assert.deepEqual(hf2.state.fallback, {});
});

// ---- round 4 ----
const REC = { A: { model: "a" }, B: { model: "b" }, C: { model: CYD, fallbackModel: STARRY }, D: { model: "d" }, E: { model: "e" } };
const CHAT = "http://x/api/v1/chat/completions";
const inv402 = (id) => new Response(JSON.stringify({ payment: { paymentId: id, accepted: [{ scheme: "nano", payTo: "nano_1stub", maxAmountRequired: "1000", maxAmountRequiredUSD: PRICE, completeUrl: "http://x/api/x402/complete/" + id }] } }), { status: 402 });
const okRes = (content, usd = PRICE) => new Response(JSON.stringify({ choices: [{ message: { content } }], x_nanogpt_pricing: { costUsd: usd } }), { status: 200 });
const xreq = (model, messages = [{ role: "user", content: "hi" }]) => ({ method: "POST", headers: { "Content-Type": "application/json", "x-x402": "true" }, body: JSON.stringify({ model, messages }) });
const defer = () => { let res; const p = new Promise((r) => { res = r; }); return { p, res }; };

test("concurrent writers: C paid then failed while D's unpaid attempt is the newest → C never falls back", async () => {
  const dStarted = defer(), dFailed = defer();
  const seen = [];
  const paid = [];
  const hf = humanizeFetch({ record: REC, draft: "", payment: async (inv) => { paid.push(inv.paymentId); await dStarted.p; }, fetch: async (u, init) => {
    if (/complete\/payC/.test(u)) { await dFailed.p; throw new Error("socket hang up"); } // C fails after paying
    const m = JSON.parse(init.body).model;
    seen.push(m);
    if (m === CYD) return inv402("payC");
    if (m === "d") { dStarted.res(); await new Promise((r) => setTimeout(r, 5)); dFailed.res(); throw new Error("ECONNRESET"); }
    return okRes("from " + m);
  } });
  const [c, d] = await Promise.allSettled([hf.fetch(CHAT, xreq(CYD)), hf.fetch(CHAT, xreq("d"))]);
  assert.equal(c.status, "rejected"); assert.equal(d.status, "rejected");
  assert.ok(!seen.includes(STARRY), "no fallback after C's payment");
  assert.deepEqual(paid, ["payC"]);
  assert.equal(hf.state.fallback.C, undefined);
  assert.equal(hf.state.paidFailed.C.paymentId, "payC");
  assert.equal(hf.state.paidFailed.D, undefined, "D's error path never read C's record");
  assert.ok(near(hf.state.unreportedUsd, PRICE), "C's payment counted once; D's unpaid error adds nothing: " + hf.state.unreportedUsd);
  const attempts = hf.state.attempts.map((a) => a.letter + ":" + a.kind + ":" + a.paid);
  assert.deepEqual(attempts.sort(), ["C:primary:true", "D:primary:false"]);
});

test("ambiguous payment: the wallet call throws after sending → no fallback, reconcile state reported, cost a lower bound", async (t) => {
  const seen = [];
  const hf = humanizeFetch({ record: REC, draft: "", payment: async () => { throw new Error("RPC timed out after publish"); }, fetch: async (u, init) => {
    seen.push(JSON.parse(init.body).model);
    return inv402("payAmb");
  } });
  await assert.rejects(hf.fetch(CHAT, xreq(CYD)), /RPC timed out/);
  assert.deepEqual(seen, [CYD], "no Starry request");
  assert.deepEqual(hf.state.reconcile, [{ letter: "C", kind: "primary", model: CYD, paymentId: "payAmb", amountUsd: PRICE, ambiguous: true, status: "payment call failed" }]);
  assert.equal(hf.state.paidFailed.C.ambiguous, true);
  assert.equal(hf.state.costUnknown, true);
  const { humanizeRunNotes } = await import("../src/humanize.mjs");
  assert.ok(humanizeRunNotes(hf.state).some((n) => /payment for invoice payAmb was started but not confirmed \(payment call failed\); no fallback was tried.*Reconcile that invoice/.test(n)));
  // a wallet error that proves nothing was sent does allow the fallback
  const seen2 = [];
  const hf2 = humanizeFetch({ record: REC, draft: "", payment: async (inv) => { if (inv.paymentId === "payN") { const e = new Error("insufficient balance"); e.paymentNotSent = true; throw e; } }, fetch: async (u, init) => {
    if (/complete\//.test(u)) return okRes("from starry");
    const m = JSON.parse(init.body).model; seen2.push(m);
    return inv402(m === CYD ? "payN" : "payS");
  } });
  const r2 = await hf2.fetch(CHAT, xreq(CYD));
  assert.equal((await r2.json()).choices[0].message.content, "from starry");
  assert.deepEqual(seen2, [CYD, STARRY]);
  assert.equal(hf2.state.fallback.C.ok, true);
  assert.equal(hf2.state.answered.C, STARRY);
  assert.deepEqual(hf2.state.reconcile, []);
  assert.equal(hf2.state.costUnknown, false);
});

test("slow payment past the re-ask deadline: the wait is bounded and the first answer is kept", async () => {
  let calls = 0;
  const hf = humanizeFetch({ record: REC, draft: "one two three four five six", reaskEndMs: 80, payment: (inv) => (inv.paymentId === "payR" ? new Promise(() => {}) : Promise.resolve()), fetch: async (u, init) => {
    if (/complete\/pay1/.test(u)) return okRes("one two three four five six");
    calls++;
    return inv402(JSON.parse(init.body).messages.length > 1 ? "payR" : "pay1");
  } });
  const t0 = Date.now();
  const r = await hf.fetch(CHAT, xreq("d"));
  assert.ok(Date.now() - t0 < 2000, "bounded by the 55 s-style re-ask deadline, not the 60 s node timeout");
  assert.equal(r.status, 200);
  assert.equal((await r.json()).choices[0].message.content, "one two three four five six");
  assert.equal(calls, 2);
  assert.equal(hf.state.reconcile[0].paymentId, "payR");
  assert.equal(hf.state.reconcile[0].status, "payment still pending at the deadline");
  assert.equal(hf.state.costUnknown, true, "the re-ask may have been paid: the total is a lower bound");
});

test("cost flag through tools: an ambiguous writer payment makes the tool's cost a labelled lower bound with costExact false", async (t) => {
  const s = await stub(t, { plan: (b) => ({ content: b.model === "z-ai/glm-5.3" ? judge("A") : "rewrite by " + b.model }) });
  // swap in a wallet that throws after "sending" for Cydonia only
  const { result, texts } = await (async () => {
    const r = await s.runWith(async (inv, rec) => { if (rec.model === CYD) throw new Error("publish result unknown"); });
    return r;
  })();
  assert.notEqual(result.isError, true, texts.join("\n"));
  assert.equal(result.costExact, false);
  assert.ok(texts.some((x) => /^cost: \$0\.0005 \(a lower bound/.test(x)), texts.find((x) => /^cost/.test(x)));
  assert.ok(texts.some((x) => /Reconcile that invoice/.test(x)));
});

// ---- round 5 ----
const keyed = (model, messages = [{ role: "user", content: "hi" }]) => ({ method: "POST", headers: { Authorization: "Bearer k" }, body: JSON.stringify({ model, messages }) });
const fetchFailed = (code) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(code), { code }) });

test("keyed mode: a reset after send flags the cost as uncertain; a refused-before-write failure is free", async () => {
  const { humanizeFetch } = await import("../src/humanize.mjs");
  let hf = humanizeFetch({ record: REC, draft: "", fetch: async () => { throw fetchFailed("ECONNRESET"); } });
  await assert.rejects(hf.fetch(CHAT, keyed("d")), /fetch failed/);
  assert.equal(hf.state.costUnknown, true, "ECONNRESET after send: may have been billed");
  hf = humanizeFetch({ record: REC, draft: "", fetch: async () => { throw fetchFailed("ECONNREFUSED"); } });
  await assert.rejects(hf.fetch(CHAT, keyed("d")), /fetch failed/);
  assert.equal(hf.state.costUnknown, false, "refused before the write: provably not billed");
  hf = humanizeFetch({ record: REC, draft: "", fetch: async () => { throw fetchFailed("ENOTFOUND"); } });
  await assert.rejects(hf.fetch(CHAT, keyed("d")), /fetch failed/);
  assert.equal(hf.state.costUnknown, false, "DNS failure: never sent");
  // a reset on the Cydonia primary: falls back (nothing paid), but the total is a lower bound
  hf = humanizeFetch({ record: REC, draft: "", fetch: async (u, init) => { if (JSON.parse(init.body).model === CYD) throw fetchFailed("ECONNRESET"); return okRes("from starry"); } });
  const r = await hf.fetch(CHAT, keyed(CYD));
  assert.equal(r.status, 200);
  assert.equal(hf.state.answered.C, STARRY);
  const j = await r.json();
  assert.equal(j.x_nanogpt_pricing, undefined, "no exact price claimed");
  assert.equal(hf.state.costUnknown, true);
  assert.ok(near(hf.state.unreportedUsd, PRICE), "Starry's known price still counted");
  // a reset during a keyed re-ask keeps the first answer and flags the cost
  hf = humanizeFetch({ record: REC, draft: "one two three four five six", fetch: async (u, init) => { if (JSON.parse(init.body).messages.length > 1) throw fetchFailed("ECONNRESET"); return okRes("one two three four five six"); } });
  const r2 = await hf.fetch(CHAT, keyed("d"));
  assert.equal((await r2.json()).choices[0].message.content, "one two three four five six");
  assert.equal(hf.state.reasked.D.failed, "request error");
  assert.equal(hf.state.costUnknown, true);
  assert.ok(near(hf.state.unreportedUsd, PRICE));
});

test("outer cancel during a paid re-ask: its payment stays in the totals and the reconcile is reported", async () => {
  const ac = new AbortController();
  let completes = 0;
  const hf = humanizeFetch({ record: REC, draft: "one two three four five six", pollMs: 5, payment: async () => {}, fetch: async (u, init) => {
    if (/complete\/pay1/.test(u)) return okRes("one two three four five six");
    if (/complete\/payR/.test(u)) { if (++completes === 3) ac.abort(new Error("node timeout")); return new Response("{}", { status: 402 }); }
    return inv402(JSON.parse(init.body).messages.length > 1 ? "payR" : "pay1");
  } });
  await assert.rejects(hf.fetch(CHAT, { ...xreq("d"), signal: ac.signal }), /node timeout/);
  assert.ok(near(hf.state.unreportedUsd, 2 * PRICE), "first call + paid re-ask both kept: " + hf.state.unreportedUsd);
  assert.equal(hf.state.costUnknown, false);
  assert.deepEqual(hf.state.reconcile.map((c) => [c.kind, c.paymentId, c.ambiguous, c.status]), [["reask", "payR", false, "aborted after payment"]]);
  assert.equal(hf.state.reasked.D.failed, "cancelled");
  const { humanizeRunNotes } = await import("../src/humanize.mjs");
  assert.ok(humanizeRunNotes(hf.state).some((n) => /writer D's reask payment payR needs reconciling \(aborted after payment\)/.test(n)));
});

test("late settlement after the deadline or a cancel: recorded once, never lost or double-counted", async () => {
  const late = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const hf = humanizeFetch({ record: REC, draft: "one two three four five six", reaskEndMs: 40, payment: (inv) => (inv.paymentId === "payR" ? gate : Promise.resolve()), fetch: async (u, init) => {
    if (/complete\/pay1/.test(u)) return okRes("one two three four five six");
    if (/complete\/payR/.test(u)) throw new Error("complete must not be polled after giving up");
    return inv402(JSON.parse(init.body).messages.length > 1 ? "payR" : "pay1");
  } });
  hf.state.onLate = (c) => late.push(c.paymentId);
  const r = await hf.fetch(CHAT, xreq("d"));
  assert.equal((await r.json()).choices[0].message.content, "one two three four five six", "first answer kept");
  assert.equal(hf.state.reconcile[0].ambiguous, true);
  const before = hf.state.unreportedUsd;
  release(); await new Promise((r2) => setTimeout(r2, 20));
  release(); await new Promise((r2) => setTimeout(r2, 20)); // a second resolve is a no-op
  assert.deepEqual(late, ["payR"], "reported exactly once");
  assert.ok(near(hf.state.unreportedUsd - before, PRICE), "the late payment is added exactly once");
  assert.equal(hf.state.reconcile.length, 1);
  assert.equal(hf.state.reconcile[0].ambiguous, false);
  assert.equal(hf.state.reconcile[0].late, true);
  assert.match(hf.state.reconcile[0].status, /paid after the writer stopped waiting/);
  // after a cancel too: a primary whose wallet call is still pending when the node is cancelled
  const ac = new AbortController();
  let rel2; const g2 = new Promise((r3) => { rel2 = r3; });
  const seen = [];
  const hf2 = humanizeFetch({ record: REC, draft: "", payment: () => g2, fetch: async (u, init) => { seen.push(JSON.parse(init.body).model); return inv402("payC"); } });
  const p = hf2.fetch(CHAT, { ...xreq(CYD), signal: ac.signal });
  await new Promise((r3) => setTimeout(r3, 10));
  ac.abort(new Error("cancelled"));
  await assert.rejects(p, /cancelled/);
  assert.deepEqual(seen, [CYD], "no fallback while the payment is unresolved");
  assert.equal(hf2.state.paidFailed.C.ambiguous, true);
  const b2 = hf2.state.unreportedUsd;
  rel2(); await new Promise((r3) => setTimeout(r3, 20));
  assert.ok(near(hf2.state.unreportedUsd - b2, PRICE));
  assert.equal(hf2.state.paidFailed.C.ambiguous, false);
});

test("a paid review whose replay has no price is unknown, and a 10-call run is not an exact $0.0009", async (t) => {
  const GLM = "z-ai/glm-5.3";
  let glmInvoices = 0;
  let glmAnswers = 0;
  const span = "Keep this joke.";
  const s = await stub(t, {
    plan: (b) => ({ content: b.model === GLM ? judge("A") : "No token in this reply at all." }),
    settleOnly: (b) => b.model === GLM && glmInvoices >= 2,
    invoiceUsd: (b) => {
      if (b.model !== GLM) return PRICE;
      glmInvoices++;
      return glmInvoices === 2 ? 0.004 : PRICE;
    },
    priceOf: (b) => {
      if (b.model !== GLM) return PRICE;
      glmAnswers++;
      return glmAnswers === 1 ? PRICE : null;
    },
  });
  const { result, texts, json } = await s.run({ Draft: `A point worth making. ${span}`, Context: "a point", keep: [span] });
  assert.notEqual(result.isError, true, texts.join("\n"));
  assert.ok(json.text.includes(span), json.text);
  assert.equal(s.paid.length, 10, "5 writers + 3 retries + first decider + repair review");
  assert.equal(glmAnswers, 2, "the review replay is the unpriced call");
  const review = [...s.invoices.values()].find((i) => i.model === GLM && i.usd === 0.004);
  assert.ok(review && review.paid, "the $0.004 review invoice was paid");
  assert.equal(result.costExact, false);
  const costLine = texts.find((x) => x.startsWith("cost:"));
  assert.match(costLine, /lower bound/);
  assert.notEqual(costLine, "cost: $0.0009");
  assert.ok(near(result.costUsd, 0.0009 + 0.004), String(result.costUsd) + " " + costLine);
});

test("review replay with no price records the call as unknown, not $0", async () => {
  const hf = humanizeFetch({
    record: REC,
    draft: "draft",
    payment: async () => {},
    fetch: async (url) => {
      if (String(url).includes("/complete/")) return new Response(JSON.stringify({ status: "paid" }), { status: 200, headers: { "content-type": "application/json" } });
      if (!hf.state.attempts.some((a) => a.kind === "review" && a.paid)) {
        return new Response(JSON.stringify({ payment: { paymentId: "payRev", accepted: [{ scheme: "nano", payTo: "nano_1stub", maxAmountRequired: "1000", maxAmountRequiredUSD: 0.004, completeUrl: "http://x/api/x402/complete/payRev" }] } }), { status: 402, headers: { "content-type": "application/json" } });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ winner: "A", ranked: [{ writer: "A", faithful: true, disqualified: false }] }) } }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  hf.state.judgeReq = {
    url: "http://x/api/v1/chat/completions",
    headers: { "Content-Type": "application/json", "x-x402": "true" },
    body: { model: "z-ai/glm-5.3", messages: [{ role: "user", content: "ctx\n\n=====\n\n[ORIGINAL]\ndraft\n\n=====\n\n[A] m\nold" }] },
    user: "ctx\n\n=====\n\n[ORIGINAL]\ndraft\n\n=====\n\n[A] m\nold",
  };
  const verdict = await hf.state.reviewRepair("repaired text", "A", "qwen/qwen3.8-27b-novelist");
  assert.equal(verdict.ok, true);
  const rec = hf.state.attempts.find((a) => a.kind === "review");
  assert.equal(rec.paid, true);
  assert.equal(rec.usd, null);
  assert.equal(rec.priceKnown, false);
  assert.equal(hf.state.costUnknown, true);
  assert.ok(near(hf.state.reviewUsd, 0.004));
});

const reviewUser = "ctx\n\n=====\n\n[ORIGINAL]\ndraft\n\n=====\n\n[A] m\nold";
const judgeBody = () => ({ model: "z-ai/glm-5.3", messages: [{ role: "user", content: reviewUser }] });

test("cancelling mid repair-review aborts without further paid calls", async () => {
  const ac = new AbortController();
  const seen = [];
  let payments = 0;
  let phase = "judge";
  let started;
  const startedP = new Promise((r) => { started = r; });
  const hf = humanizeFetch({
    record: REC,
    draft: "draft",
    pollMs: 10000,
    payment: async () => { payments++; },
    fetch: (url, init) => {
      if (phase === "judge") {
        phase = "review";
        return Promise.resolve(okRes("{}"));
      }
      seen.push(String(url));
      if (!init || !init.signal) return Promise.reject(new Error("repair review dropped the abort signal"));
      if (String(url).includes("/complete/")) return Promise.reject(new Error("complete after cancel"));
      started();
      return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(init.signal.reason)));
    },
  });
  await hf.fetch(CHAT, { method: "POST", headers: { "Content-Type": "application/json", "x-x402": "true" }, signal: ac.signal, body: JSON.stringify(judgeBody()) });
  assert.equal(hf.state.judgeReq.signal, ac.signal, "the decider abort signal is kept for the review");
  const p = hf.state.reviewRepair("repaired text", "A", "qwen/qwen3.8-27b-novelist");
  await startedP;
  ac.abort(new Error("cancelled"));
  const t0 = Date.now();
  await Promise.race([
    assert.rejects(p, /cancelled/),
    new Promise((_, rej) => setTimeout(() => rej(new Error("review did not abort")), 2000)),
  ]);
  assert.ok(Date.now() - t0 < 2000);
  assert.equal(payments, 0, "cancel before the wallet call does not pay");
  assert.deepEqual(seen, [CHAT], "no complete poll and no replay after cancel");
});

test("cancelling during the repair invoice read never pays", async () => {
  const ac = new AbortController();
  let payments = 0;
  let markStarted;
  const startedP = new Promise((r) => { markStarted = r; });
  let finishRead;
  const readP = new Promise((r) => { finishRead = r; });
  const invoice = JSON.stringify({ payment: { paymentId: "payLate", accepted: [{ scheme: "nano", payTo: "nano_1stub", maxAmountRequired: "1000", maxAmountRequiredUSD: 0.004, completeUrl: "http://x/api/x402/complete/payLate" }] } });
  const hf = humanizeFetch({
    record: REC,
    draft: "draft",
    payment: async () => { payments++; },
    fetch: () => ({ status: 402, text: () => { markStarted(); return readP; } }),
  });
  hf.state.judgeReq = {
    url: CHAT,
    headers: { "Content-Type": "application/json", "x-x402": "true" },
    body: judgeBody(),
    user: reviewUser,
    signal: ac.signal,
  };
  const before = hf.state.unreportedUsd;
  const p = hf.state.reviewRepair("repaired text", "A", "qwen/qwen3.8-27b-novelist");
  await startedP;
  ac.abort(new Error("cancelled"));
  finishRead(invoice);
  await assert.rejects(p, /cancelled/);
  assert.equal(payments, 0, "a cancel during the invoice read does not call payment");
  assert.equal(hf.state.unreportedUsd, before, "no late $0.004 charge is recorded");
  const rec = hf.state.attempts.find((a) => a.kind === "review");
  assert.equal(rec.paymentStarted, false);
});

test("repair review deadline: a slow payment stops without another paid call", async () => {
  const seen = [];
  let payments = 0;
  const hf = humanizeFetch({
    record: REC,
    draft: "draft",
    pollMs: 10000,
    reaskEndMs: 50,
    payment: () => { payments++; return new Promise(() => {}); },
    fetch: async (url, init) => {
      seen.push(String(url));
      if (!init || !init.signal) throw new Error("repair review dropped the abort signal");
      if (String(url).includes("/complete/")) throw new Error("complete after the deadline");
      return inv402("payRev");
    },
  });
  hf.state.judgeReq = {
    url: CHAT,
    headers: { "Content-Type": "application/json", "x-x402": "true" },
    body: judgeBody(),
    user: reviewUser,
  };
  const t0 = Date.now();
  await Promise.race([
    assert.rejects(hf.state.reviewRepair("repaired text", "A", "qwen/qwen3.8-27b-novelist"), /repair review timed out/),
    new Promise((_, rej) => setTimeout(() => rej(new Error("review ignored its deadline")), 2000)),
  ]);
  assert.ok(Date.now() - t0 < 2000, "bounded by the review deadline, not the invoice window");
  assert.equal(payments, 1, "the in-flight payment is not followed by another");
  assert.deepEqual(seen, [CHAT]);
  assert.equal(hf.state.reconcile[0].paymentId, "payRev");
  assert.equal(hf.state.reconcile[0].status, "payment still pending at the deadline");
  assert.equal(hf.state.reconcile[0].ambiguous, true);
  assert.equal(hf.state.costUnknown, true);
});

/** A 402 whose body stays pending until `finish`. Cancelling before that must not pay. */
function delayedInvoice(id) {
  let markStarted;
  let finishRead;
  const startedP = new Promise((r) => { markStarted = r; });
  const readP = new Promise((r) => { finishRead = r; });
  const invoice = JSON.stringify({ payment: { paymentId: id, accepted: [{ scheme: "nano", payTo: "nano_1stub", maxAmountRequired: "1000", maxAmountRequiredUSD: 0.004, completeUrl: "http://x/api/x402/complete/" + id }] } });
  const res = { status: 402, ok: false, text: () => { markStarted(); return readP; } };
  return { res, startedP, finish: () => finishRead(invoice) };
}

/**
 * Drive one paid path, abort once its 402 body has started and before it resolves,
 * then release the invoice. payment() must not run.
 */
async function cancelDuringRead({ kind, draft = "draft", extra = {}, fetch, call }) {
  const ac = new AbortController();
  let payments = 0;
  const late = delayedInvoice("pay" + kind);
  const hf = humanizeFetch({
    record: REC,
    draft,
    payment: async () => { payments++; },
    fetch: (url, init) => fetch(url, init, late),
    ...extra,
  });
  const before = hf.state.unreportedUsd;
  const p = call(hf, ac);
  await Promise.race([
    late.startedP,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${kind} invoice read did not start`)), 2000)),
  ]);
  ac.abort(new Error("cancelled"));
  late.finish();
  await assert.rejects(p, /cancelled/);
  assert.equal(payments, 0, `${kind}: a cancel during the invoice read does not call payment`);
  // A writer retry's first answer can already be metered. The cancelled invoice is $0.004 and must not land.
  assert.ok(hf.state.unreportedUsd - before < 0.004, `${kind}: no late $0.004 charge is recorded (${hf.state.unreportedUsd})`);
  assert.equal(hf.state.paidIds.has("pay" + kind), false, `${kind}: the invoice is not recorded as paid`);
  const rec = hf.state.attempts.find((a) => a.kind === kind);
  assert.ok(rec, `${kind} attempt was recorded`);
  assert.equal(rec.paymentStarted, false);
  assert.notEqual(rec.usd, 0.004);
}

test("cancelling during the primary writer invoice read never pays", async () => {
  await cancelDuringRead({
    kind: "primary",
    fetch: (_url, _init, late) => late.res,
    call: (hf, ac) => hf.fetch(CHAT, { ...xreq("a"), signal: ac.signal }),
  });
});

test("cancelling during the fallback invoice read never pays", async () => {
  await cancelDuringRead({
    kind: "fallback",
    fetch: (_url, init, late) => {
      const model = JSON.parse(init.body).model;
      if (model === CYD) return new Response(JSON.stringify({ error: "overloaded" }), { status: 429 });
      return late.res;
    },
    call: (hf, ac) => hf.fetch(CHAT, { ...xreq(CYD), signal: ac.signal }),
  });
});

test("cancelling during the reask invoice read never pays", async () => {
  const draft = "one two three four five six";
  let n = 0;
  await cancelDuringRead({
    kind: "reask",
    draft,
    fetch: (_url, _init, late) => {
      n++;
      if (n === 1) return okRes(draft);
      return late.res;
    },
    call: (hf, ac) => hf.fetch(CHAT, { ...xreq("d"), signal: ac.signal }),
  });
});

test("cancelling during the guard invoice read never pays", async () => {
  const draft = "Thanks for the detailed writeup about the release.";
  let n = 0;
  await cancelDuringRead({
    kind: "guard",
    draft,
    extra: { ending: "question" },
    fetch: (_url, _init, late) => {
      n++;
      if (n === 1) return okRes("A different sentence entirely.");
      return late.res;
    },
    call: (hf, ac) => hf.fetch(CHAT, { ...xreq("d"), signal: ac.signal }),
  });
});

const pricedRecord = {
  A: { model: "qwen/qwen3.8-27b-novelist" },
  B: { model: "deepseek/deepseek-v4.1-flash-1017" },
  C: { model: CYD, fallbackModel: STARRY },
  D: { model: "qwen/qwen3.8-27b-antislop" },
  E: { model: "inception/mercury-3" },
};
const invoiceOf = (id, usd) => new Response(JSON.stringify({
  payment: { paymentId: id, accepted: [{ scheme: "nano", payTo: "nano_1stub", maxAmountRequired: "1000", maxAmountRequiredUSD: usd, completeUrl: "http://x/api/x402/complete/" + id }] },
}), { status: 402, headers: { "content-type": "application/json" } });

test("paid retry resends the billed 306-token request, not the original 1600-token request", async () => {
  const draft = "hello";
  assert.equal(requestOutputTokenCap(null, draft, { judge: true }), 306);
  const original = JSON.stringify({
    model: "z-ai/glm-5.3",
    messages: [{ role: "user", content: draft }],
    temperature: 0.8,
    max_tokens: 1600,
  });
  const seen = [];
  let payments = 0;
  const hf = humanizeFetch({
    record: REC,
    draft,
    payment: async () => { payments += 1; },
    fetch: async (url, init) => {
      const raw = typeof init.body === "string" ? init.body : "";
      seen.push(raw);
      if (String(url).includes("/complete/")) {
        return new Response(JSON.stringify({ status: "paid" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (init.headers && init.headers["x-x402-payment-id"]) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }], x_nanogpt_pricing: { costUsd: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return invoiceOf("payJudge", 0.0001);
    },
  });
  const settled = await hf.fetch(CHAT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-x402": "true" },
    body: original,
  });
  assert.equal(settled.status, 200);
  assert.equal(payments, 1);
  const chats = seen.filter((s) => s.includes("glm-5.3"));
  assert.equal(chats.length, 2, "the billed request and the settle-only replay");
  assert.equal(chats[0], chats[1], "the replay body is the billed body, byte for byte");
  assert.equal(JSON.parse(chats[0]).max_tokens, 306);
  assert.equal(JSON.parse(chats[1]).max_tokens, 306);
  assert.equal(JSON.parse(original).max_tokens, 1600);
  assert.notEqual(chats[0], original);

  // The nanoodle client retries by calling the wrapper again with the original body plus the payment id.
  const seen2 = [];
  const hf2 = humanizeFetch({
    record: REC,
    draft,
    payment: null,
    fetch: async (_url, init) => {
      seen2.push(init.body);
      if (seen2.length === 1) return invoiceOf("payRetry", 0.0001);
      return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const first = await hf2.fetch(CHAT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-x402": "true" },
    body: original,
  });
  assert.equal(first.status, 402);
  const second = await hf2.fetch(CHAT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-x402": "true", "x-x402-payment-id": "payRetry" },
    body: original,
  });
  assert.equal(second.status, 200);
  assert.equal(seen2.length, 2);
  assert.equal(seen2[0], seen2[1]);
  assert.equal(JSON.parse(seen2[0]).max_tokens, 306);
  assert.equal(JSON.parse(seen2[1]).max_tokens, 306);
});

test("an invoice of $0.01 is not paid against a $0.001 budget", async () => {
  let payments = 0;
  const hf = humanizeFetch({
    record: pricedRecord,
    draft: "hello",
    budgetUsd: 0.001,
    prices: HUMANIZE_MODEL_PRICES,
    payment: async () => { payments += 1; },
    fetch: async (url) => {
      if (String(url).includes("/complete/")) return new Response("{}", { status: 200 });
      return invoiceOf("payBig", 0.01);
    },
  });
  const r = await hf.fetch(CHAT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-x402": "true" },
    body: JSON.stringify({ model: pricedRecord.A.model, max_tokens: 600, messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(payments, 0);
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.x_nanogpt_pricing.costUsd, 0);
  assert.ok(hf.state.skippedForBudget.some((s) => s.kind === "primary"));

  let open = 0;
  const wallet = humanizeFetch({
    record: pricedRecord,
    draft: "hello",
    payment: async () => { open += 1; },
    fetch: async (url, init) => {
      if (String(url).includes("/complete/")) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (init.headers && init.headers["x-x402-payment-id"]) return okRes("ok");
      return invoiceOf("payOpen", 0.01);
    },
  });
  const paid = await wallet.fetch(CHAT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-x402": "true" },
    body: JSON.stringify({ model: pricedRecord.A.model, max_tokens: 600, messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(paid.status, 200);
  assert.equal(open, 1, "a run with no budget pays the invoice");
});

test("a paid check of the draft counts, so a repair invoice is not paid once the budget is used", async () => {
  const payments = [];
  let n = 0;
  const hf = humanizeFetch({
    record: pricedRecord,
    draft: "hello",
    budgetUsd: 0.02,
    prices: HUMANIZE_MODEL_PRICES,
    payment: async (inv) => { payments.push(inv.amountUsd); },
    fetch: async (url, init) => {
      if (String(url).includes("/complete/")) {
        return new Response(JSON.stringify({ status: "paid" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (init.headers && init.headers["x-x402-payment-id"]) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }], x_nanogpt_pricing: { costUsd: 0 } }), { status: 200, headers: { "content-type": "application/json" } });
      }
      n += 1;
      return invoiceOf("pay" + n, 0.01);
    },
  });
  const judged = await hf.fetch(CHAT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-x402": "true" },
    body: JSON.stringify({ model: "z-ai/glm-5.3", messages: [{ role: "user", content: "rank" }], max_tokens: 1600 }),
  });
  assert.equal(judged.status, 200);
  assert.deepEqual(payments, [0.01]);
  assert.ok(hf.state.meteredUsd + 1e-12 >= 0.01, "the invoice counts even though the response meter is 0");
  const verdict = await hf.state.reviewRepair("fixed hello", "A", pricedRecord.A.model);
  assert.equal(verdict.ok, false);
  assert.deepEqual(payments, [0.01], "the repair invoice is refused");
});

test("cancelling during the decider invoice read never pays", async () => {
  await cancelDuringRead({
    kind: "decider",
    fetch: (_url, _init, late) => late.res,
    call: (hf, ac) => hf.fetch(CHAT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-x402": "true" },
      signal: ac.signal,
      body: JSON.stringify(judgeBody()),
    }),
  });
});

/** 1 XNO, with no USD figure. Number(null) must not turn that into a free invoice. */
const invoiceNoUsd = (id) => new Response(JSON.stringify({
  payment: { paymentId: id, accepted: [{ scheme: "nano", payTo: "nano_1stub", maxAmountRequired: "1000000000000000000000000000000", completeUrl: "http://x/api/x402/complete/" + id }] },
}), { status: 402, headers: { "content-type": "application/json" } });

const x402Headers = { "Content-Type": "application/json", "x-x402": "true" };
const chatBody = (model, content) => JSON.stringify({ model, messages: [{ role: "user", content }] });

async function refuseUnknownUsd({ budgetUsd, kind }) {
  const payments = [];
  const hf = humanizeFetch({
    record: pricedRecord,
    draft: "hello",
    budgetUsd,
    prices: HUMANIZE_MODEL_PRICES,
    payment: async (inv) => { payments.push(inv.paymentId); },
    fetch: async (url) => {
      if (String(url).includes("/complete/")) return okRes("should not settle");
      return invoiceNoUsd("pay" + kind);
    },
  });
  const model = kind === "decider" ? "z-ai/glm-5.3" : pricedRecord.A.model;
  const r = await hf.fetch(CHAT, { method: "POST", headers: x402Headers, body: chatBody(model, "hello") });
  assert.equal(payments.length, 0, `${kind}: an invoice with no USD price is not paid`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).x_nanogpt_pricing.costUsd, 0);
  assert.equal(hf.state.meteredUsd, 0);
  assert.equal(hf.state.committedUsd, 0);
  assert.equal(hf.state.costUnknown, false);
  assert.equal(hf.state.paidIds.has("pay" + kind), false);
  const rec = hf.state.attempts.find((a) => a.kind === (kind === "decider" ? "decider" : "primary"));
  assert.ok(rec, `${kind} attempt recorded`);
  assert.equal(rec.priceUnknown, true);
  assert.equal(rec.paymentStarted, false);
  assert.equal(rec.invoiceCommitted ?? null, null);
}

test("an invoice with no USD price is refused before payment on a $0.001 budget", async () => {
  await refuseUnknownUsd({ budgetUsd: 0.001, kind: "writer" });
  await refuseUnknownUsd({ budgetUsd: 0.001, kind: "decider" });
});

test("an invoice with no USD price is refused on a direct wallet too", async () => {
  await refuseUnknownUsd({ budgetUsd: null, kind: "writer" });
  await refuseUnknownUsd({ budgetUsd: null, kind: "decider" });
});

test("a known USD price of zero is still payable", async () => {
  const payments = [];
  const hf = humanizeFetch({
    record: pricedRecord,
    draft: "hello",
    budgetUsd: 0.001,
    prices: HUMANIZE_MODEL_PRICES,
    payment: async (inv) => { payments.push(inv.amountUsd); },
    fetch: async (url) => {
      if (String(url).includes("/complete/")) return new Response(JSON.stringify({ choices: [{ message: { content: "free" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      return invoiceOf("payZero", 0);
    },
  });
  const r = await hf.fetch(CHAT, { method: "POST", headers: x402Headers, body: chatBody(pricedRecord.A.model, "hello") });
  assert.equal(r.status, 200);
  assert.deepEqual(payments, [0]);
  assert.equal((await r.json()).choices[0].message.content, "free");
});

test("a fallback is not paid for an invoice with no USD price, and a priced fallback still can be", async () => {
  const payments = [];
  const hf = humanizeFetch({
    record: REC,
    draft: "hello",
    payment: async (inv) => { payments.push(inv.paymentId); },
    fetch: async (url, init) => {
      if (String(url).includes("/complete/")) return new Response(JSON.stringify({ choices: [{ message: { content: "from starry" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      const model = JSON.parse(init.body).model;
      if (model === CYD) return invoiceNoUsd("payCyd");
      return invoiceOf("payStar", 0.0001);
    },
  });
  const r = await hf.fetch(CHAT, xreq(CYD));
  assert.deepEqual(payments, ["payStar"]);
  assert.equal(hf.state.paidIds.has("payCyd"), false);
  assert.equal(hf.state.paidIds.has("payStar"), true);
  assert.equal(hf.state.fallback.C.ok, true);
  assert.equal((await r.json()).choices[0].message.content, "from starry");
  assert.equal(hf.state.costUnknown, false);
});

test("a re-ask invoice with no USD price is not paid and the first answer is kept", async () => {
  const draft = "one two three four five six";
  let n = 0;
  const payments = [];
  const hf = humanizeFetch({
    record: REC,
    draft,
    payment: async (inv) => { payments.push(inv.paymentId); },
    fetch: async () => {
      n += 1;
      if (n === 1) return okRes(draft);
      return invoiceNoUsd("payReask");
    },
  });
  const r = await hf.fetch(CHAT, xreq("d"));
  assert.deepEqual(payments, []);
  assert.equal((await r.json()).choices[0].message.content, draft);
  assert.equal(hf.state.paidIds.has("payReask"), false);
  assert.equal(hf.state.costUnknown, false);
  const rec = hf.state.attempts.find((a) => a.kind === "reask");
  assert.equal(rec.priceUnknown, true);
  assert.equal(rec.paymentStarted, false);
});

test("a repair invoice with no USD price is not paid", async () => {
  for (const budgetUsd of [0.001, null]) {
    const payments = [];
    const hf = humanizeFetch({
      record: pricedRecord,
      draft: "hello",
      budgetUsd,
      prices: HUMANIZE_MODEL_PRICES,
      payment: async (inv) => { payments.push(inv.paymentId); },
      fetch: async () => invoiceNoUsd("payReview"),
    });
    hf.state.judgeReq = {
      url: CHAT,
      headers: x402Headers,
      body: { model: "z-ai/glm-5.3", messages: [{ role: "user", content: "rank" }] },
      user: "rank",
    };
    const verdict = await hf.state.reviewRepair("fixed hello", "A", pricedRecord.A.model);
    assert.equal(verdict.ok, false);
    assert.deepEqual(payments, [], `budget ${budgetUsd}: repair does not pay an unpriced invoice`);
    assert.equal(hf.state.paidIds.has("payReview"), false);
    assert.equal(hf.state.meteredUsd, 0);
    assert.equal(hf.state.committedUsd, 0);
    assert.equal(hf.state.costUnknown, false);
    const rec = hf.state.attempts.find((a) => a.kind === "review");
    assert.ok(rec, "the review reached the invoice");
    assert.equal(rec.priceUnknown, true);
    assert.equal(rec.paymentStarted, false);
  }
});

test("a rejected decider payment records the invoice before rethrowing", async () => {
  const hf = humanizeFetch({
    record: REC,
    draft: "hello",
    payment: async () => { throw new Error("wallet rejected"); },
    fetch: async () => inv402("payDec"),
  });
  await assert.rejects(hf.fetch(CHAT, {
    method: "POST",
    headers: x402Headers,
    body: chatBody("z-ai/glm-5.3", "rank"),
  }), (err) => {
    assert.equal(err instanceof ReferenceError, false);
    assert.doesNotMatch(String(err && err.message), /inv is not defined/);
    assert.match(err.message, /wallet rejected/);
    return true;
  });
  assert.equal(hf.state.reconcile.length, 1);
  assert.equal(hf.state.reconcile[0].paymentId, "payDec");
  assert.equal(hf.state.reconcile[0].kind, "decider");
  assert.equal(hf.state.reconcile[0].ambiguous, true);
  assert.equal(hf.state.reconcile[0].status, "payment call failed");
  assert.equal(hf.state.costUnknown, true);
  assert.equal(hf.state.paidIds.has("payDec"), true, "a wallet error keeps the reservation");
});

test("cancelling a pending decider payment records the invoice before rethrowing", async () => {
  let mark;
  const started = new Promise((r) => { mark = r; });
  const ac = new AbortController();
  const hf = humanizeFetch({
    record: REC,
    draft: "hello",
    payment: async () => { mark(); await new Promise(() => {}); },
    fetch: async () => inv402("payPend"),
  });
  const pending = hf.fetch(CHAT, {
    method: "POST",
    headers: x402Headers,
    signal: ac.signal,
    body: chatBody("z-ai/glm-5.3", "rank"),
  });
  await started;
  ac.abort(new Error("cancelled"));
  await assert.rejects(pending, (err) => {
    assert.equal(err instanceof ReferenceError, false);
    assert.doesNotMatch(String(err && err.message), /inv is not defined/);
    assert.match(err.message, /cancelled/);
    return true;
  });
  assert.equal(hf.state.reconcile.length, 1);
  assert.equal(hf.state.reconcile[0].paymentId, "payPend");
  assert.equal(hf.state.reconcile[0].ambiguous, true);
  assert.equal(hf.state.reconcile[0].status, "payment still pending at the deadline");
  assert.equal(hf.state.costUnknown, true);
  assert.equal(hf.state.paidIds.has("payPend"), true, "an in-flight cancel keeps the reservation");
});

test("two simultaneous payments on one id pay exactly once", async () => {
  const paid = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const hf = humanizeFetch({
    record: REC,
    draft: "hello",
    payment: async (inv) => { paid.push(inv.paymentId); await gate; },
    fetch: async (url) => {
      if (String(url).includes("/complete/")) return new Response(JSON.stringify({ choices: [{ message: { content: "once" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      return invoiceOf("shared", 0.0001);
    },
  });
  const pending = Promise.allSettled([
    hf.fetch(CHAT, xreq("a", [{ role: "user", content: "alpha-body" }])),
    hf.fetch(CHAT, xreq("b", [{ role: "user", content: "beta-body" }])),
  ]);
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(paid, ["shared"]);
  release();
  const settled = await pending;
  assert.deepEqual(paid, ["shared"]);
  assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1);
  assert.equal(settled.filter((s) => s.status === "rejected").length, 1);
  const rejected = settled.find((s) => s.status === "rejected").reason;
  assert.match(rejected.message, /already reserved/);
  assert.equal(hf.state.paidIds.size, 1);
});

test("a second request cannot replace the body of a payment that is still in flight", async () => {
  const paid = [];
  let mark;
  const started = new Promise((r) => { mark = r; });
  let release;
  const gate = new Promise((r) => { release = r; });
  const seen = [];
  const hf = humanizeFetch({
    record: REC,
    draft: "unrelated draft",
    payment: async (inv) => { paid.push(inv.paymentId); mark(); await gate; },
    fetch: async (url, init) => {
      const raw = typeof init.body === "string" ? init.body : "";
      const pid = init.headers && init.headers["x-x402-payment-id"];
      seen.push({ raw, pid: pid || null });
      if (String(url).includes("/complete/")) return new Response(JSON.stringify({ status: "paid" }), { status: 200, headers: { "content-type": "application/json" } });
      if (pid) return okRes("replayed");
      return invoiceOf("shared", 0.0001);
    },
  });
  const first = hf.fetch(CHAT, { method: "POST", headers: x402Headers, body: chatBody("a", "alpha-body") });
  await started;
  await assert.rejects(
    hf.fetch(CHAT, { method: "POST", headers: x402Headers, body: chatBody("b", "beta-body") }),
    /already reserved/,
  );
  assert.deepEqual(paid, ["shared"]);
  release();
  const res = await first;
  assert.equal(res.status, 200);
  assert.deepEqual(paid, ["shared"]);
  const replay = seen.find((s) => s.pid === "shared");
  assert.ok(replay, "the winner replays after settle");
  assert.match(replay.raw, /alpha-body/);
  assert.doesNotMatch(replay.raw, /beta-body/);
});

test("a wallet error keeps the id reserved and the first body stored", async () => {
  const paid = [];
  const seen = [];
  const hf = humanizeFetch({
    record: REC,
    draft: "unrelated draft",
    payment: async (inv) => { paid.push(inv.paymentId); throw new Error("mid-flight"); },
    fetch: async (_url, init) => {
      seen.push(init.body);
      return invoiceOf("shared", 0.0001);
    },
  });
  await assert.rejects(hf.fetch(CHAT, { method: "POST", headers: x402Headers, body: chatBody("a", "alpha-body") }), /mid-flight/);
  assert.equal(hf.state.paidIds.has("shared"), true);
  assert.equal(hf.state.reconcile.length, 1);
  assert.equal(hf.state.costUnknown, true);
  await assert.rejects(hf.fetch(CHAT, { method: "POST", headers: x402Headers, body: chatBody("b", "beta-body") }), /already reserved/);
  assert.deepEqual(paid, ["shared"], "the second request does not pay");
  const retry = await hf.fetch(CHAT, {
    method: "POST",
    headers: { ...x402Headers, "x-x402-payment-id": "shared" },
    body: chatBody("b", "beta-body"),
  });
  assert.equal(retry.status, 402, "the stub still answers the forwarded retry");
  assert.equal(seen.length, 3);
  assert.match(seen[2], /alpha-body/);
  assert.doesNotMatch(seen[2], /beta-body/);
  assert.deepEqual(paid, ["shared"]);
});

test("cancelling an in-flight writer payment does not free its id for a second payment", async () => {
  const paid = [];
  let mark;
  const started = new Promise((r) => { mark = r; });
  const ac = new AbortController();
  const hf = humanizeFetch({
    record: REC,
    draft: "hello",
    payment: async (inv) => { paid.push(inv.paymentId); mark(); await new Promise(() => {}); },
    fetch: async () => invoiceOf("shared", 0.0001),
  });
  const first = hf.fetch(CHAT, { ...xreq("a"), signal: ac.signal });
  await started;
  ac.abort(new Error("cancelled"));
  await assert.rejects(first, /cancelled/);
  assert.equal(hf.state.paidIds.has("shared"), true);
  assert.equal(hf.state.costUnknown, true);
  await assert.rejects(hf.fetch(CHAT, xreq("b")), /already reserved/);
  assert.deepEqual(paid, ["shared"]);
});

test("two invoices that race the remaining budget pay only what still fits", async () => {
  const paid = [];
  let release;
  const gate = new Promise((r) => { release = r; });
  const hf = humanizeFetch({
    record: pricedRecord,
    draft: "hello",
    budgetUsd: 0.02,
    prices: HUMANIZE_MODEL_PRICES,
    payment: async (inv) => { paid.push(inv.paymentId); await gate; },
    fetch: async (url, init) => {
      if (String(url).includes("/complete/")) return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), { status: 200, headers: { "content-type": "application/json" } });
      const model = JSON.parse(init.body).model;
      return invoiceOf("pay-" + model, 0.01);
    },
  });
  const pending = Promise.allSettled([
    hf.fetch(CHAT, xreq(pricedRecord.A.model)),
    hf.fetch(CHAT, xreq(pricedRecord.B.model)),
  ]);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(paid.length, 1);
  release();
  const settled = await pending;
  assert.equal(paid.length, 1);
  assert.equal(settled.filter((s) => s.status === "rejected").length, 0);
  assert.equal(hf.state.paidIds.size, 1);
  const metered = hf.state.meteredUsd + hf.state.committedUsd;
  assert.ok(metered <= 0.02 + 1e-9, `spend stayed inside the budget: ${metered}`);
});

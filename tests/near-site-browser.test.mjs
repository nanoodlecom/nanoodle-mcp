import { test } from "node:test";
import assert from "node:assert/strict";
import { startStudio, callMcp, savedInputs, resultText } from "../src/near-site-browser.mjs";

const config = { merchant: "merchant.near", tools: [{ name: "poster" }] };
const payment = { paymentId: "nq_test", status: "payment_required", payTo: "merchant.near", asset: "USDC", amount: "0.01", amountAtomic: "10000" };
const receipt = { outcome: "succeeded", charged: { amount: "0.002" }, refund: { amount: "0.008", status: "sent" } };
const complete = { content: [{ type: "text", text: "A finished result" }], structuredContent: { receipt } };
const store = () => { const data = new Map(); return { setItem: (k, v) => data.set(k, v), getItem: k => data.get(k) || null }; };

test("paid output stays visible while the current structured receipt replaces stale pending copy", () => {
  const content = [{ type: "text", text: "Paid in moonlight, the fox sails home. ✓" },
    { type: "text", text: "charged: $0.002; refund pending" }, { type: "text", text: "Paid 0.01 USDC on NEAR mainnet. Refund pending." }];
  assert.equal(resultText({ content, structuredContent: { receipt } }), content[0].text);
  assert.equal(content.length, 3, "rendering does not change the original MCP response");
  assert.equal(resultText(complete), "A finished result", "an unexpected response never loses its paid text");
  const failed = { content: [{ type: "text", text: "The run failed; refund pending." }], structuredContent: { receipt: { outcome: "run_failed" } } };
  assert.equal(resultText(failed), failed.content[0].text);
});

for (const name of ["run_noodle", "poster"]) test(`browser studio ${name}: quoting does not run, then payment resumes the immutable request`, async () => {
  const calls = [], storage = store(); let checks = 0, finish;
  const done = new Promise(resolve => { finish = resolve; });
  let permitPayment; const paid = new Promise(resolve => { permitPayment = resolve; });
  const studio = startStudio({ config, storage, pause: async () => {},
    rpc: async (tool, args) => {
      calls.push({ tool, args: structuredClone(args) });
      return args._payment_id ? complete : { structuredContent: { payment, pricing: {} } };
    }, status: async () => { checks++; await paid; return { status: "paid" }; },
    update: session => { if (session.phase === "finished") finish(session); } });
  const args = name === "run_noodle" ? { graph: { v: 1 }, inputs: { Topic: "original" }, _pay_with: "usdc" } : { Idea: "original", _pay_with: "usdc" };
  await studio.quote(name, args);
  assert.equal(calls.length, 1); assert.ok(!calls[0].args._payment_id);
  if (args.inputs) args.inputs.Topic = "edited after quote"; else args.Idea = "edited after quote";
  permitPayment(); const session = await done;
  assert.equal(calls.length, 2); assert.equal(calls[1].args._payment_id, payment.paymentId); assert.equal(calls[1].args._pay_with, "usdc");
  assert.equal(name === "run_noodle" ? calls[1].args.inputs.Topic : calls[1].args.Idea, "original");
  assert.equal(session.result, complete);
  assert.ok(!storage.getItem("nanoodle-near-studio:v1").includes("A finished result"), "paid result text is not persisted in the tab's request state");
});

test("browser reload resumes a paid quote without issuing another quote or payment", async () => {
  const storage = store(), calls = []; let finish;
  storage.setItem("nanoodle-near-studio:v1", JSON.stringify([{ name: "poster", args: { Idea: "original", _pay_with: "usdc" }, payment, phase: "waiting" }]));
  const done = new Promise(resolve => { finish = resolve; });
  const studio = startStudio({ config, storage, status: async () => ({ status: "settled" }), pause: async () => {},
    rpc: async (name, args) => { calls.push(args); return complete; }, update: session => { if (session.phase === "finished") finish(); } });
  studio.restore(); await done;
  assert.equal(calls.length, 1); assert.equal(calls[0]._payment_id, payment.paymentId);
});

test("expired quotes never execute and unexpected destinations are refused", async () => {
  let runs = 0, finish;
  const done = new Promise(resolve => { finish = resolve; });
  const studio = startStudio({ config, storage: store(), status: async () => ({ status: "expired" }), pause: async () => {},
    rpc: async () => { runs++; return { structuredContent: { payment } }; }, update: s => { if (s.phase === "finished") finish(); } });
  await studio.quote("poster", {}); await done; assert.equal(runs, 1);
  const bad = startStudio({ config, status: async () => assert.fail("must not monitor"), update: () => {},
    rpc: async () => ({ structuredContent: { payment: { ...payment, payTo: "attacker.near" } } }) });
  await assert.rejects(bad.quote("poster", {}), /unexpected payment destination/);
});

test("streamed results survive split frames and progress without confusing notifications with the result", async () => {
  const progress = [], encoder = new TextEncoder();
  const wire = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress","params":{"message":"Rendering"}}\n\n' +
    'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Done ✓"}]}}\n\n';
  const response = new Response(new ReadableStream({ start(controller) {
    const bytes = encoder.encode(wire); for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close();
  } }), { headers: { "Content-Type": "text/event-stream" } });
  const r = await callMcp("poster", { _payment_id: "nq_test" }, { fetch: async () => response, onProgress: p => progress.push(p) });
  assert.deepEqual(progress, ["Rendering"]); assert.equal(r.content[0].text, "Done ✓");
});

test("saved workflow inputs omit payment fields and honor required choices/defaults", () => {
  assert.deepEqual(savedInputs({ required: ["Idea", "Mode", "Count", "_payment_id"], properties: {
    Mode: { enum: ["portrait", "landscape"] }, Count: { type: "integer", minimum: 2 },
  } }), { Idea: "a lighthouse at dawn", Mode: "portrait", Count: 2 });
});

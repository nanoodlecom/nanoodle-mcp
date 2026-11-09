// The pricing vocabulary: stable structured field names next to text a model
// can read cold (estimated cost, service fee, deposit, refund, rate).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  priceGraph, assertGraphSafe, estUsd, exactUsd, summarySentence, depositWhySentence,
  pricingVocabulary, formatQuote, formatReceipt, authoringGuide, checkGraphSafety,
} from "../src/custom-workflow.mjs";

const link = (id, from, fromPort, to, toPort) => ({ id, from: { node: from, port: fromPort }, to: { node: to, port: toPort } });
const WORKED = {
  v: 1,
  nodes: [
    { id: "n1", type: "text", name: "Idea", fields: { text: "" } },
    { id: "n2", type: "llm", fields: { model: "z-ai/glm-5.3-flash", system: "Write one vivid image prompt for the idea. Reply with the prompt only." } },
    { id: "n3", type: "image", fields: { model: "blackforestlabs/flux-3/klein/text-to-image", size: "1024x1024" } },
  ],
  links: [link("l1", "n1", "text", "n2", "prompt"), link("l2", "n2", "text", "n3", "prompt")],
};
const CATS = {
  chat: [{ id: "z-ai/glm-5.3-flash", pricing: { prompt: 0.1, completion: 0.3 } }, { id: "z-ai/glm-5.3-uncensored", pricing: { prompt: 1.25, completion: 2.25 } }],
  image: [{ id: "blackforestlabs/flux-3/klein/text-to-image", pricing: { per_image: { "1024x1024": 0.009, "768x768": 0.008 } } }],
  video: [{ id: "kling-v26-pro", pricing: { per_duration: { 5: 0.35, 10: 0.7 } } }],
};
const pricing = () => priceGraph(assertGraphSafe(WORKED), CATS, { inputs: { Idea: "a lighthouse at dawn" } });
const NEAR = { network: "testnet", nearUsd: "3.64", rateSource: "coingecko", rateAt: "2026-11-09T12:00:00.000Z", likelyChargeNear: "0.003172", depositNear: "0.008379" };

const DOC_SUMMARY_NEAR = "You will most likely pay about $0.0115 (0.003172 NEAR): the estimated cost plus a 20% service fee. You send 0.008379 NEAR as a deposit; that is the most you can be charged, even if the run costs more, and the rest is refunded to your account as soon as the run finishes.";
const DOC_SUMMARY_USD = "You will most likely pay about $0.0115: the estimated cost plus a 20% service fee. The deposit is $0.03; that is the most you can be charged, even if the run costs more, and the rest is refunded automatically as soon as the run finishes.";
const DOC_WHY = "Text, video and audio steps bill by what they actually produce, so the deposit holds twice the likely charge as headroom, rounded up to the next cent ($0.03); image prices are fixed.";
const LLM_BASIS = "up to 223 input + 2000 output tokens (maxTokens; usually less)";

test("estUsd: three significant digits below $1, plain decimals, cents above $1", () => {
  assert.equal(estUsd(0), "0");
  assert.equal(estUsd(0.0096223), "0.00962");
  assert.equal(estUsd(0.0006223), "0.000622");
  assert.equal(estUsd(0.01154676), "0.0115");
  assert.equal(estUsd(0.009), "0.009");
  assert.equal(estUsd(0.0000001234), "0.000000123");
  assert.equal(estUsd(1), "1.00");
  assert.equal(estUsd(43.2), "43.20");
  assert.equal(estUsd(0.5), "0.5");
  for (const v of [1e-7, 1e-9, 3e-12]) assert.doesNotMatch(estUsd(v), /e/i);
});

test("exactUsd: up to nine decimals, trimmed, never exponent notation", () => {
  assert.equal(exactUsd(0.011292), "0.011292");
  assert.equal(exactUsd(0.03), "0.03");
  assert.equal(exactUsd(2), "2");
  assert.equal(exactUsd(0.0000001), "0.0000001");
  assert.equal(exactUsd(1.23456789012), "1.23456789");
  assert.equal(exactUsd(1e-12), "0");
});

test("summary and deposit-why sentences match the doc", () => {
  const p = pricing();
  assert.equal(summarySentence(p, NEAR), DOC_SUMMARY_NEAR);
  assert.equal(summarySentence(p), DOC_SUMMARY_USD);
  assert.equal(depositWhySentence(p), DOC_WHY);
});

test("deposit-why for fixed-price graphs and for the minimum deposit", () => {
  const img = priceGraph(assertGraphSafe({ nodes: [{ id: "i", type: "image", fields: { model: "blackforestlabs/flux-3/klein/text-to-image", size: "1024x1024", variations: "4", prompt: "x" } }], links: [] }), CATS);
  assert.equal(img.headroom, 1.25);
  assert.equal(depositWhySentence(img), "Every model here has a fixed price, so the deposit is the likely charge plus 25% headroom, rounded up to the next cent ($0.02).");
  const tiny = priceGraph(assertGraphSafe({ nodes: [{ id: "l", type: "llm", fields: { model: "z-ai/glm-5.3-flash", prompt: "hi", maxTokens: 10 } }], links: [] }), CATS);
  assert.equal(tiny.depositUsd, 0.01);
  assert.equal(depositWhySentence(tiny), "The deposit is the $0.01 minimum, because this workflow most likely costs less than that.");
  const none = priceGraph(assertGraphSafe({ nodes: [{ id: "t", type: "text", fields: { text: "x" } }], links: [] }), CATS);
  assert.match(depositWhySentence(none), /\$0\.01 minimum/);
  assert.match(summarySentence(none), /no paid models/);
});

test("pricingVocabulary: structured field names exactly as documented", () => {
  const { structured, text } = pricingVocabulary(pricing(), { near: NEAR });
  const sp = structured.pricing;
  assert.deepEqual(Object.keys(sp), ["currency", "estimatedCost", "serviceFee", "likelyCharge", "deposit", "refund", "summary", "safety", "unpriced"]);
  assert.equal(sp.currency, "USD");
  assert.deepEqual(Object.keys(sp.estimatedCost), ["usd", "fixedPrice", "items"]);
  assert.equal(sp.estimatedCost.usd, "0.00962");
  assert.equal(sp.estimatedCost.fixedPrice, false);
  assert.deepEqual(sp.estimatedCost.items, [
    { nodeId: "n2", node: "LLM", type: "llm", model: "z-ai/glm-5.3-flash", basis: LLM_BASIS, usd: "0.000622", fixedPrice: false },
    { nodeId: "n3", node: "Image", type: "image", model: "blackforestlabs/flux-3/klein/text-to-image", basis: "1 image at 1024x1024 (fixed price)", usd: "0.009", fixedPrice: true },
  ]);
  assert.deepEqual(sp.serviceFee, { rate: "0.2", appliesTo: "actual model cost", likelyUsd: "0.00192" });
  assert.deepEqual(sp.likelyCharge, { usd: "0.0115" });
  assert.deepEqual(sp.deposit, { usd: "0.03", headroom: "2", why: DOC_WHY });
  assert.deepEqual(sp.refund, { likelyUsd: "0.0185", how: "returned automatically to the paying account after the run" });
  assert.equal(sp.summary, DOC_SUMMARY_NEAR);
  assert.deepEqual(sp.safety, { ok: true, refusals: [] });
  assert.deepEqual(sp.unpriced, []);
  assert.deepEqual(structured.near, {
    network: "testnet", rate: { nearUsd: "3.64", source: "coingecko", at: "2026-11-09T12:00:00.000Z" },
    likelyChargeNear: "0.003172", depositNear: "0.008379",
  });
  // text: summary first, then why, then itemized lines, fee, deposit, refund, rate
  const lines = text.split("\n");
  assert.equal(lines[0], DOC_SUMMARY_NEAR);
  assert.equal(lines[1], DOC_WHY);
  assert.ok(lines.includes("Estimated cost:"));
  assert.ok(lines.includes(`- LLM (z-ai/glm-5.3-flash): $0.000622 — ${LLM_BASIS}`));
  assert.ok(lines.includes("- Image (blackforestlabs/flux-3/klein/text-to-image): $0.009 — 1 image at 1024x1024 (fixed price)"));
  assert.ok(lines.some((l) => l.startsWith("Service fee: 20% of the actual model cost")));
  assert.ok(lines.includes("Likely charge: $0.0115 (0.003172 NEAR) (estimated cost + 20% service fee)"));
  assert.ok(lines.some((l) => l.startsWith("Deposit: 0.008379 NEAR (about $") && l.endsWith("the most you can be charged")));
  assert.ok(lines.some((l) => l.startsWith("Refund: the deposit minus what is actually charged, returned automatically")));
  assert.ok(lines.includes("Rate: 1 NEAR = $3.64 (coingecko, 2026-11-09T12:00:00.000Z), locked for this quote; network testnet"));
});

test("pricingVocabulary without NEAR has no near block and no rate line", () => {
  const { structured, text } = pricingVocabulary(pricing());
  assert.equal(structured.near, undefined);
  assert.equal(structured.pricing.summary, DOC_SUMMARY_USD);
  assert.doesNotMatch(text, /Rate:/);
  assert.match(text, /^Deposit: \$0\.03; the most you can be charged$/m);
});

test("price_noodle NEAR figures say the deposit is approximate (before the quote's dust) and the rate is locked at quote time", () => {
  const { structured, text } = pricingVocabulary(pricing(), { near: { ...NEAR, depositNear: "0.008242", depositApprox: true } });
  assert.equal(structured.near.depositNearIsApproximate, true);
  assert.match(text, /You will send a deposit of about 0\.008242 NEAR \(the quote adds up to 0\.000999 NEAR so each amount is unique; that comes back with the refund\); that is the most you can be charged/);
  assert.match(text, /^Deposit: \$0\.03 \(about 0\.008242 NEAR before the quote's unique dust\); the most you can be charged$/m);
  assert.match(text, /locked when you ask for a quote/);
});

test("pricingVocabulary lists refusals and unpriced nodes", () => {
  const bad = { nodes: [...WORKED.nodes, { id: "u", type: "upload", fields: {} }, { id: "x", type: "llm", name: "Ghost", fields: { model: "no/such", prompt: "hi" } }], links: WORKED.links };
  const safety = checkGraphSafety(bad);
  assert.equal(safety.ok, false);
  const p = priceGraph(safety.workflowGraph, CATS);
  const { structured, text } = pricingVocabulary(p, { safety });
  assert.equal(structured.pricing.safety.ok, false);
  assert.equal(structured.pricing.safety.refusals[0].code, "NODE_NOT_ALLOWED");
  assert.deepEqual(structured.pricing.unpriced.map((u) => [u.nodeId, u.node, u.type, u.model]), [["x", "Ghost", "llm", "no/such"]]);
  assert.match(text, /^This workflow cannot run on this server as written: 1 problem/);
  assert.match(text, /Problems to fix before this can run:\n- node "Image input" \(upload\) is not allowed/);
});

const PAYMENT = {
  network: "testnet", paymentId: "nq_4kGm2b7XyQ1v", payTo: "merchant.testnet",
  amountYocto: "8379000000000000000000", amountNear: "0.008379", depositUsd: "0.03",
  depositUsdSent: "0.0305", dustNear: "0.000137", likelyChargeNear: "0.003172",
  rate: { nearUsd: "3.64", source: "coingecko", at: "2026-11-09T12:00:00.000Z" }, expiresAt: "2026-11-09T12:15:00.000Z",
};

test("formatQuote: payment block, next line naming all three _payment_ args, amounts untouched", () => {
  const q = formatQuote({ pricing: pricing(), payment: PAYMENT, now: Date.parse("2026-11-09T12:00:00.000Z") });
  const pay = q.structured.payment;
  assert.deepEqual(Object.keys(pay), ["rail", "status", "network", "paymentId", "payTo", "amountYocto", "amountNear", "depositUsd", "depositUsdSent", "dustNear", "likelyChargeNear", "rate", "expiresAt", "next"]);
  assert.equal(pay.rail, "near");
  assert.equal(pay.status, "payment_required");
  assert.equal(pay.amountYocto, "8379000000000000000000");
  assert.equal(pay.amountNear, "0.008379");
  assert.equal(pay.next, "Send exactly 0.008379 NEAR (8379000000000000000000 yoctoNEAR) to merchant.testnet on testnet in ONE transfer, then call this tool again with the same arguments plus _payment_id, _payment_tx and _payment_sender.");
  for (const a of ["_payment_id", "_payment_tx", "_payment_sender"]) assert.ok(pay.next.includes(a) && q.text.includes(a), a);
  assert.equal(q.structured.pricing.summary, DOC_SUMMARY_NEAR);
  assert.equal(q.structured.pricing.deposit.usd, "0.03");

  const t = q.text;
  assert.ok(t.startsWith(`PAYMENT REQUIRED (NEAR testnet) — ${DOC_SUMMARY_NEAR}`), t);
  assert.ok(t.includes("Send exactly 0.008379 NEAR (8379000000000000000000 yoctoNEAR) to merchant.testnet on testnet: one transfer, no other actions."));
  assert.ok(t.includes('_payment_id: "nq_4kGm2b7XyQ1v"'));
  assert.ok(t.includes("expires in about 15 minutes (2026-11-09T12:15:00.000Z)"));
  assert.ok(t.includes("If the run fails, the whole deposit is refunded."));
  assert.ok(t.includes(DOC_WHY));
  assert.ok(t.includes("- LLM (z-ai/glm-5.3-flash): $0.000622"));
  assert.ok(t.indexOf("Send exactly") < t.indexOf("Estimated cost:"));
  // the deposit line shows what is actually sent, in NEAR and USD, and where the extra comes from
  assert.ok(t.includes("Deposit: 0.008379 NEAR (about $0.0305 at the locked rate: the $0.03 deposit plus 0.000137 NEAR that makes the amount unique and comes back with the refund); the most you can be charged"), t);
});

test("formatQuote: odd-looking amount strings pass through verbatim", () => {
  const p = { ...PAYMENT, amountYocto: "1000000000000000000000001", amountNear: "1.000000000000000000000001" };
  const q = formatQuote({ pricing: pricing(), payment: p, now: Date.parse("2026-11-09T12:05:00.000Z") });
  assert.equal(q.structured.payment.amountYocto, "1000000000000000000000001");
  assert.ok(q.text.includes("1.000000000000000000000001 NEAR (1000000000000000000000001 yoctoNEAR)"));
  assert.ok(q.text.includes("about 10 minutes"));
});

const RECEIPT = {
  rail: "near", network: "testnet", paymentId: "nq_4kGm2b7XyQ1v",
  deposit: { yocto: "8379000000000000000000", near: "0.008379", usd: "0.03049956", quotedUsd: "0.03", txHash: "PAYHASH", explorerUrl: "https://testnet.nearblocks.io/txns/PAYHASH" },
  actualCost: { usd: "0.00941", exact: true, billedAs: "reported", reportedUsd: "0.00941" },
  serviceFee: { usd: "0.001882" },
  charged: { yocto: "3102197802197802197803", near: "0.003102197802197802197803", usd: "0.011292", capped: false },
  refund: { yocto: "5276802197802197802197", near: "0.005276802197802197802197", usd: "0.019207559", to: "payer.testnet", status: "sent", txHash: "REFHASH", explorerUrl: "https://testnet.nearblocks.io/txns/REFHASH" },
  rate: { nearUsd: "3.64", source: "coingecko", at: "2026-11-09T12:00:00.000Z" },
  outcome: "succeeded",
};

test("formatReceipt: succeeded, refund sent", () => {
  const r = formatReceipt(RECEIPT);
  assert.deepEqual(r.structured, { receipt: RECEIPT });
  assert.equal(r.text,
    "Paid 0.008379 NEAR deposit (tx PAYHASH, https://testnet.nearblocks.io/txns/PAYHASH). " +
    "Actual model cost $0.00941 + 20% service fee = $0.011292 (≈0.003102 NEAR) charged. " +
    "Refund ≈0.005277 NEAR to payer.testnet: sent (tx REFHASH, https://testnet.nearblocks.io/txns/REFHASH). " +
    "Rate 3.64 USD/NEAR (coingecko, 2026-11-09T12:00:00.000Z), locked when quoted.");
});

test("formatReceipt: refund pending, none, and failed permanently", () => {
  const pending = formatReceipt({ ...RECEIPT, refund: { ...RECEIPT.refund, status: "pending", txHash: null, explorerUrl: null } });
  assert.match(pending.text, /: pending, queued for retry\./);
  const none = formatReceipt({ ...RECEIPT, refund: { ...RECEIPT.refund, near: "0", yocto: "0", status: "none", txHash: null } });
  assert.match(none.text, /Refund 0 NEAR to payer\.testnet: none/);
  const dead = formatReceipt({ ...RECEIPT, refund: { ...RECEIPT.refund, status: "failed_permanent" } });
  assert.match(dead.text, /contact the operator with payment id nq_4kGm2b7XyQ1v/);
});

test("formatReceipt: run_failed, interrupted, wrong_amount, late_payment", () => {
  const full = { ...RECEIPT.refund, near: "0.008379", yocto: "8379000000000000000000" };
  const nothing = { yocto: "0", near: "0", usd: "0" };
  const base = { ...RECEIPT, actualCost: { usd: null, exact: false }, serviceFee: { usd: "0" }, charged: nothing, refund: full };
  const failed = formatReceipt({ ...base, outcome: "run_failed" }).text;
  assert.match(failed, /The run failed, so nothing was charged and the whole deposit is refunded\. Refund 0\.008379 NEAR to payer\.testnet: sent/);
  const intr = formatReceipt({ ...base, outcome: "interrupted" }).text;
  assert.match(intr, /restarted during the run, so nothing was charged and the whole deposit is refunded\. The run was not repeated\./);
  const wrong = formatReceipt({ ...base, deposit: { ...RECEIPT.deposit, near: "0.5" }, refund: { ...full, near: "0.5" }, outcome: "wrong_amount" }).text;
  assert.match(wrong, /Received 0\.5 NEAR \(tx PAYHASH\), which is not the quoted amount, so nothing ran and nothing was charged\. Everything you sent is refunded\. Refund 0\.5 NEAR/);
  const late = formatReceipt({ ...base, outcome: "late_payment" }).text;
  assert.match(late, /after the quote expired, so nothing ran and nothing was charged\. Everything you sent is refunded\./);
  for (const t of [failed, intr, wrong, late]) assert.match(t, /Rate 3\.64 USD\/NEAR/);
});

test("formatReceipt: a cost the provider did not fully report is billed at the estimate, and says so", () => {
  const est = formatReceipt({ ...RECEIPT, actualCost: { usd: "0.0096223", exact: false, billedAs: "estimate", reportedUsd: "0" } }).text;
  assert.match(est, /The provider reported only \$0 for this run, so you are charged the estimated cost \$0\.0096223 \+ 20% service fee = \$0\.011292/);
  const none = formatReceipt({ ...RECEIPT, actualCost: { usd: "0.0096223", exact: false, billedAs: "estimate", reportedUsd: null } }).text;
  assert.match(none, /The provider reported no cost for this run, so you are charged the estimated cost/);
  const capped = formatReceipt({ ...RECEIPT, charged: { ...RECEIPT.charged, capped: true } }).text;
  assert.match(capped, /charged, capped at the deposit\./);
});

test("receipt USD figures reconcile: deposit.usd - charged.usd = refund.usd (to the nano-dollar)", () => {
  const r = RECEIPT;
  const nano = (x) => Math.round(Number(x) * 1e9);
  assert.ok(Math.abs(nano(r.deposit.usd) - nano(r.charged.usd) - nano(r.refund.usd)) <= 2);
});

test("authoringGuide: node types, rules, example, and filtered priced models", () => {
  const g = authoringGuide({ catalogs: CATS });
  assert.deepEqual(Object.keys(g.structured), ["nodeTypes", "wiringRules", "example", "models"]);
  assert.equal(g.structured.nodeTypes.length, 31);
  const llm = g.structured.nodeTypes.find((t) => t.type === "llm");
  assert.deepEqual(Object.keys(llm), ["type", "title", "allowed", "why", "inputs", "textPorts", "mediaPorts", "outputs", "keyFields", "fields"]);
  assert.deepEqual(llm.textPorts, ["prompt", "system"]);
  // the text says which ports take wires (llm has no NODE_TYPES inputs, yet its prompt is wireable)
  assert.match(g.text, /^- llm \(LLM\): wire text into \[prompt, system\]; media inputs \[img1, img2/m);
  assert.match(g.text, /^Model kinds: chat -> llm, decide; image -> image, edit;/m);
  assert.deepEqual(llm.keyFields, ["model", "system", "prompt", "maxTokens"]);
  assert.deepEqual(llm.outputs, [{ name: "text", type: "text" }]);
  const ep = g.structured.nodeTypes.find((t) => t.type === "endpoint");
  assert.equal(ep.allowed, false);
  assert.ok(g.structured.wiringRules.length >= 5);
  assert.equal(g.structured.example.nodes.length, 3);
  // the example graph is itself safe
  assert.equal(checkGraphSafety(g.structured.example).ok, true);
  // all kinds, sorted by their smallest unit price (image $0.008, video $0.35, chat $0.1+$0.3, chat $1.25+$2.25)
  assert.deepEqual(g.structured.models.map((m) => m.id), [
    "blackforestlabs/flux-3/klein/text-to-image", "kling-v26-pro", "z-ai/glm-5.3-flash", "z-ai/glm-5.3-uncensored"]);
  assert.equal(g.structured.models[0].unitPrice, "$0.008 per image (size 768x768)");
  assert.equal(g.structured.models[2].unitPrice, "$0.1 in / $0.3 out per 1M tokens");
  assert.equal(g.structured.models[1].unitPrice, JSON.stringify(CATS.video[0].pricing));
  assert.match(g.text, /price_noodle/);
  assert.ok(g.text.trim().split("\n").pop().includes("price_noodle"));
});

test("authoringGuide: kind, search and limit filters", () => {
  assert.deepEqual(authoringGuide({ catalogs: CATS, kind: "chat" }).structured.models.map((m) => m.id), ["z-ai/glm-5.3-flash", "z-ai/glm-5.3-uncensored"]);
  assert.deepEqual(authoringGuide({ catalogs: CATS, search: "UNCENS" }).structured.models.map((m) => m.id), ["z-ai/glm-5.3-uncensored"]);
  assert.equal(authoringGuide({ catalogs: CATS, limit: 1 }).structured.models.length, 1);
  const many = { chat: Array.from({ length: 80 }, (_, i) => ({ id: "m" + i, pricing: { prompt: i, completion: 1 } })) };
  assert.equal(authoringGuide({ catalogs: many, limit: 500 }).structured.models.length, 50);
  assert.equal(authoringGuide({ catalogs: many }).structured.models.length, 20);
  const long = { video: [{ id: "v", pricing: { note: "x".repeat(300), per_second: 0.1 } }] };
  assert.ok(authoringGuide({ catalogs: long }).structured.models[0].unitPrice.length <= 120);
  assert.deepEqual(authoringGuide({}).structured.models, []);
});

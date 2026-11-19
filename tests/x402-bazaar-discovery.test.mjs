import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodePaymentSignatureHeader } from "@x402/core/http";
import { createX402ExactIngress, BASE, SOLANA } from "../src/integrations/x402-exact-ingress.mjs";
import { createDurableX402Boundary } from "../src/integrations/x402-boundary-store.mjs";
import { sdkPayload, verifyOffline, evmSigner, svmSigner, svmSeller, svmFeePayer } from "./fixtures/x402/sdk-fixtures.mjs";

const clone = x => JSON.parse(JSON.stringify(x));
const params = { name: "hello-noodle", arguments: { Name: "Ada" } };
const DESCRIPTION = "Runs a saved nanoodle workflow that turns a name into a greeting card image. Call it when an agent needs a finished greeting image, not raw model output.";

async function harness(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "x402-bazaar-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const counts = { settle: 0, execute: 0, verify: 0 };
  const settleSeen = [];
  const ctx = { requestId: "server-request-1", customerScope: "authenticated-customer", workflowDigest: "a".repeat(64),
    resource: { url: "https://offline.invalid/tools/hello-noodle", mimeType: "application/json" } };
  const routes = [{ network: BASE, payTo: "0x1111111111111111111111111111111111111111" },
    { network: SOLANA, payTo: svmSeller.address }];
  const supported = { kinds: routes.map(r => ({ x402Version: 2, scheme: "exact", network: r.network,
    ...(r.network === SOLANA ? { extra: { feePayer: svmFeePayer.address } } : {}) })), extensions: [], signers: {} };
  const boundary = createDurableX402Boundary({
    file: join(dir, "boundary.json"),
    priceQuote: async () => ({ downstream: { asset: "XNO", unit: "raw", amountAtomic: "1000" }, ttlMs: 60_000,
      prices: routes.map(r => ({ network: r.network, amountAtomic: "10000" })) }),
    execute: async () => { counts.execute++; return { status: "completed", refund: { state: "not_required" },
      result: { isError: false, content: [{ type: "text", text: "offline protected output" }] } }; },
  });
  const facilitator = {
    async getSupported() { return clone(supported); },
    async verify(payload, requirements) { counts.verify++; return verifyOffline(payload, requirements); },
    async settle(payload, requirements) {
      counts.settle++; settleSeen.push(clone(payload));
      return { success: true, network: requirements.network,
        transaction: requirements.network === BASE ? `0x${"ab".repeat(32)}` : "2".repeat(88),
        payer: requirements.network === BASE ? evmSigner.address : svmSigner.address };
    },
  };
  const registry = { listTools: () => [{ name: params.name, description: "greets",
      inputSchema: { type: "object", properties: { Name: { type: "string" } }, required: ["Name"] } }, { name: "run_noodle" }],
    async prepareCall() {}, callTool() { assert.fail("unguarded executor must not run"); } };
  const settings = { registry, resolveContext: () => clone(ctx), boundary, facilitator,
    facilitatorId: "offline-fixture-only", routes, timeoutMs: 5000, capabilityTtlMs: 1000,
    discoveryFor: options.discoveryFor ?? (() => ({ description: DESCRIPTION, example: { Name: "Ada" },
      output: { example: { text: "offline protected output" } } })) };
  return { app: createX402ExactIngress(settings), settings, counts, settleSeen, boundary,
    async payment(network = BASE) {
      const quote = await this.app.handle({ params }); assert.equal(quote.status, 402);
      const payload = await sdkPayload(quote.body.accepts.find(r => r.network === network), quote.body.resource);
      return { quote, payload, paymentSignature: encodePaymentSignatureHeader(payload) };
    } };
}

test("402 challenge advertises a valid bazaar extension with schemas and a <=500 char description", async t => {
  const h = await harness(t);
  const { quote } = await h.payment();
  const bazaar = quote.body.extensions?.bazaar;
  assert.ok(bazaar, JSON.stringify(quote.body));
  assert.equal(bazaar.info.input.type, "mcp");
  assert.equal(bazaar.info.input.toolName, "hello-noodle");
  assert.equal(bazaar.info.input.description, DESCRIPTION);
  assert.ok(bazaar.info.input.description.length <= 500);
  assert.deepEqual(bazaar.info.input.example, { Name: "Ada" });
  assert.equal(bazaar.info.input.inputSchema.properties.Name.type, "string");
  assert.ok(bazaar.schema, "extension carries its JSON schema");
  assert.equal(bazaar.schema.properties.input.properties.type.const, "mcp");
});

test("settlement forwards resource + extensions.bazaar to the facilitator (the indexing trigger)", async t => {
  const h = await harness(t);
  const { paymentSignature } = await h.payment();
  const result = await h.app.handle({ params, paymentSignature });
  assert.equal(result.status, 200, JSON.stringify(result));
  assert.equal(h.counts.settle, 1); assert.equal(h.counts.execute, 1);
  assert.equal(h.settleSeen.length, 1);
  const forwarded = h.settleSeen[0];
  assert.deepEqual(forwarded.resource, { url: "https://offline.invalid/tools/hello-noodle", mimeType: "application/json" });
  assert.equal(forwarded.extensions?.bazaar?.info?.input?.toolName, "hello-noodle");
});

test("end to end on the durable boundary: replay after adapter restart returns the cached outcome, one settle, one execution", async t => {
  const h = await harness(t);
  const { paymentSignature } = await h.payment();
  const first = await h.app.handle({ params, paymentSignature });
  assert.equal(first.status, 200);
  const restartedAdapter = createX402ExactIngress(h.settings);
  const replay = await restartedAdapter.handle({ params, paymentSignature });
  assert.equal(replay.status, 200); assert.deepEqual(replay.body, first.body);
  assert.equal(h.counts.settle, 1); assert.equal(h.counts.execute, 1);
});

test("a description over 500 chars fails closed before any payment operation", async t => {
  const h = await harness(t, { discoveryFor: () => ({ description: "x".repeat(501) }) });
  const res = await h.app.handle({ params });
  assert.equal(res.status, 402); assert.equal(res.body.code, "DISCOVERY_DESCRIPTION_INVALID");
  assert.equal(h.counts.settle, 0); assert.equal(h.counts.execute, 0);
});

test("discoveryFor returning null leaves the call undiscoverable but fully functional", async t => {
  const h = await harness(t, { discoveryFor: () => null });
  const { quote, paymentSignature } = await h.payment();
  assert.equal(quote.body.extensions, undefined);
  const result = await h.app.handle({ params, paymentSignature });
  assert.equal(result.status, 200);
  assert.equal(h.settleSeen[0].extensions, undefined);
});

test("without discoveryFor nothing changes: no extensions anywhere", async t => {
  const h = await harness(t, { discoveryFor: undefined });
  // settings.discoveryFor was replaced by the default via ?? — rebuild manually
  const { discoveryFor, ...rest } = h.settings;
  const app = createX402ExactIngress(rest);
  const quote = await app.handle({ params });
  assert.equal(quote.status, 402); assert.equal(quote.body.extensions, undefined);
});

test("a discovery failure after settlement cannot block replay of paid work", async t => {
  const h = await harness(t);
  const { paymentSignature } = await h.payment();
  assert.equal((await h.app.handle({ params, paymentSignature })).status, 200);
  const broken = createX402ExactIngress({ ...h.settings,
    discoveryFor: () => { throw new Error("metadata service down"); } });
  const replay = await broken.handle({ params, paymentSignature });
  assert.equal(replay.status, 200, JSON.stringify(replay));
  assert.equal(h.counts.settle, 1); assert.equal(h.counts.execute, 1);
});

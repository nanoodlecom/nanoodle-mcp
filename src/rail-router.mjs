/**
 * One server, multiple payment rails: route each tools/call to the Nano
 * charge gate (src/gate.mjs) or to the server's composition rail — the
 * NEAR gate (src/near-gate.mjs) or the NanoUSD gate (src/nanusd/gate.mjs,
 * on the shared route core). The composition rails are alternatives: a
 * server runs NEAR or NanoUSD in that seat, not both. No gate knows the
 * others exist; this module only decides which one answers.
 *
 * Routing, in order:
 *   1. a tool only the composition gate offers (run_noodle, price_noodle, noodle_guide) → composition
 *   2. _payment_id starting with the composition gate's prefix ("nq_" / "uq_")          → composition
 *   3. _payment_id starting "pay_"                                                      → Nano
 *   4. no _payment_id and "_pay_with" naming the composition rail                       → composition
 *   5. everything else                                                                  → Nano
 * Strip the Nano selector before the Nano gate. The composition gate
 * receives an explicit asset selector to reject cross-asset resumes,
 * then strips it before hashing the workflow arguments.
 */
import { ParamsError } from "./tools.mjs";

const refuse = (text) => ({ content: [{ type: "text", text }], isError: true });

const SECOND_ROUTES = {
  near: (wrapped) => ({
    key: "near", wrapped,
    railOnly: wrapped.nearOnly,
    payValues: ["near", "usdc"],
    enabledPayValues: ["near", ...(wrapped.assets?.has("usdc") ? ["usdc"] : [])],
    prefixes: ["nq_"],
    claimFields: ["_payment_tx", "_payment_sender"],
    assetWord: (v) => (v === "usdc" ? "USDC" : "NEAR"),
    sentence: ' It can also be paid in NEAR: add "_pay_with": "near" for a NEAR quote, send the exact amount in one transfer, ' +
      "then call again with the same arguments plus _payment_id, _payment_tx and _payment_sender.",
    // NEAR validates the asset selector itself, so it travels with the call.
    passSelector: true,
  }),
  nanusd: (wrapped) => ({
    key: "nanusd", wrapped,
    railOnly: wrapped.railOnly ?? new Set(["run_noodle", "price_noodle", "noodle_guide"]),
    payValues: ["nanusd"],
    enabledPayValues: ["nanusd"],
    prefixes: ["uq_"],
    claimFields: [],
    assetWord: () => "NanoUSD",
    sentence: ' It can also be paid in NanoUSD: add "_pay_with": "nanusd" for a NanoUSD quote, send the exact amount in one transfer, ' +
      "then call again with the same arguments plus _payment_id.",
    passSelector: false,
  }),
};

/**
 * @param {object} o
 * @param {{listTools: Function, callTool: Function}} o.nano  createChargeGate().wrapRegistry(registry)
 * @param {{listTools: Function, callTool: Function, sells: Function, nearOnly: Set<string>}} [o.near]
 *        createNearGate().wrapRegistry(registry)
 * @param {{listTools: Function, callTool: Function, sells: Function, railOnly: Set<string>}} [o.nanusd]
 *        createNanusdGate().wrapRegistry(registry) — alternative composition rail to NEAR
 */
export function createRailRouter({ nano, near = null, nanusd = null }) {
  if (near && nanusd) throw new Error("rail router: near and nanusd are alternative composition rails — provide one");
  const second = near ? SECOND_ROUTES.near(near) : nanusd ? SECOND_ROUTES.nanusd(nanusd) : null;
  if (!second) throw new Error("rail router: provide a composition rail (near or nanusd)");
  const railOnly = second.railOnly;
  const PAY_WITH = new Set(["nano", ...second.payValues]);
  const CLAIM_FIELDS = second.claimFields;
  const payWithList = () => {
    const values = ["nano", ...second.enabledPayValues];
    return values.map((v) => `"${v}"`).join(", ").replace(/, ([^,]*)$/, " or $1");
  };

  /** Which gate answers, and the arguments it sees; or a refusal. Pure: exported for tests via route(). */
  function route(params) {
    if (params == null || typeof params !== "object" || Array.isArray(params)) return { gate: "nano", params };
    const name = params.name;
    const raw = params.arguments;
    if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) {
      return { gate: railOnly.has(name) ? second.key : "nano", params };
    }
    const args = raw == null ? {} : raw;
    const { _pay_with: payWith, ...rest } = args;

    if (payWith !== undefined && !PAY_WITH.has(payWith)) {
      return { refusal: `_pay_with must be ${payWithList()}, got ${JSON.stringify(payWith).slice(0, 40)}. Nothing was charged.` };
    }
    const stripped = raw == null && payWith === undefined ? params : { ...params, arguments: payWith === "usdc" ? { ...rest, _pay_with: "usdc" } : rest };
    const secondParams = second.passSelector && payWith === second.payValues[0]
      ? { ...params, arguments: { ...rest, _pay_with: payWith } } : stripped;
    const pid = rest._payment_id;
    const hasClaimFields = CLAIM_FIELDS.some((k) => rest[k] != null);

    const nanoQuote = typeof pid === "string" && pid.startsWith("pay_");
    if (payWith === "usdc" && !second.wrapped.assets?.has("usdc") && !nanoQuote) {
      return { refusal: "USDC payments are not enabled on this server. If you already have a quote, keep its original _payment_id and payment asset. Nothing was charged." };
    }
    if (railOnly.has(name)) {
      if (payWith === "nano" || nanoQuote) {
        return { refusal: `${name} does not accept Nano (XNO) payments on this server. See the tool schema for supported payment assets. Nothing was charged.` };
      }
      return { gate: second.key, params: secondParams };
    }
    if (pid != null) {
      const id = String(pid);
      if (second.prefixes.some((p) => id.startsWith(p))) {
        if (payWith === "nano") return { refusal: "This quote uses a different payment asset. Keep the same _payment_id and original workflow arguments; remove _pay_with, then retry. Nothing was consumed." };
        return { gate: second.key, params: secondParams };
      }
      if (id.startsWith("pay_")) {
        if ((payWith !== undefined && payWith !== "nano") || hasClaimFields) {
          const remove = ["_pay_with", ...CLAIM_FIELDS].join(", ").replace(/, ([^,]*)$/, " and $1");
          return { refusal: `payment id ${id} is a Nano (XNO) quote. Keep the same _payment_id and original workflow arguments; remove ${remove}, then retry. Nothing was consumed.` };
        }
        return { gate: "nano", params: stripped };
      }
      // An id neither gate issued: let the chosen gate answer "unknown payment id".
      return (payWith !== undefined && payWith !== "nano") || hasClaimFields
        ? { gate: second.key, params: secondParams } : { gate: "nano", params: stripped };
    }
    if (payWith !== undefined && payWith !== "nano") {
      if (!second.wrapped.sells(name)) {
        return { refusal: `${name} does not accept ${second.assetWord(payWith)} payments on this server. See the tool schema for supported payment assets. Nothing was charged.` };
      }
      return { gate: second.key, params: secondParams };
    }
    if (hasClaimFields) {
      const fields = CLAIM_FIELDS.join(" or ");
      const remove = CLAIM_FIELDS.join(" and ");
      return { refusal: `Nano (XNO) requests do not use ${fields}. For Nano, remove ${remove} and retry with the same workflow arguments. If you already paid, include the original _payment_id and keep its payment rail. Nothing was charged.` };
    }
    return { gate: "nano", params: stripped };
  }

  const PAY_WITH_SCHEMA = {
    type: "string",
    enum: ["nano", ...second.enabledPayValues],
    description: 'Payment rail for the quote: "nano" (default, XNO over x402)' + (second.key === "near"
      ? ', "near" (native NEAR)' + (second.enabledPayValues.includes("usdc") ? ' or "usdc" (Circle-issued USDC on NEAR).' : '.')
      : ', "nanusd" (NanoUSD on the NanUSD network).'),
  };

  function listTools() {
    const nanoList = nano.listTools();
    const secondList = second.wrapped.listTools();
    const secondByName = new Map(secondList.map((t) => [t.name, t]));
    const out = nanoList.map((t) => {
      if (railOnly.has(t.name) || !second.wrapped.sells(t.name)) return t;
      const nt = secondByName.get(t.name);
      const secondProps = (nt && nt.inputSchema && nt.inputSchema.properties) || {};
      return {
        ...t,
        description: t.description + second.sentence,
        inputSchema: {
          ...t.inputSchema,
          properties: {
            ...(t.inputSchema.properties || {}),
            _pay_with: PAY_WITH_SCHEMA,
            ...Object.fromEntries(CLAIM_FIELDS.filter((f) => secondProps[f]).map((f) => [f, secondProps[f]])),
          },
        },
      };
    });
    const have = new Set(out.map((t) => t.name));
    for (const t of secondList) if (railOnly.has(t.name) && !have.has(t.name)) out.push(t);
    return out;
  }

  async function callTool(params, ctx = null) {
    const r = route(params);
    if (r.refusal) return refuse(r.refusal);
    if (r.gate === "nano" && params && typeof params === "object" && typeof params.name === "string") {
      // An unknown tool names everything this server offers, not one rail's list.
      const names = listTools().map((t) => t.name);
      if (!names.includes(params.name)) throw new ParamsError(`unknown tool "${params.name}" — available: ${names.join(", ")}`);
    }
    return r.gate === "nano" ? nano.callTool(r.params, ctx) : second.wrapped.callTool(r.params, ctx);
  }

  return { listTools, callTool, route };
}

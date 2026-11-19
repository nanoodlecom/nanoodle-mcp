/**
 * One server, two payment rails: route each tools/call to the Nano charge gate
 * (src/gate.mjs) or the NEAR gate (src/near-gate.mjs). Neither gate knows the
 * other exists; this module only decides which one answers.
 *
 * Routing, in order:
 *   1. a tool only the NEAR gate offers (run_noodle, price_noodle, noodle_guide)  → NEAR
 *   2. _payment_id starting "nq_"                                                 → NEAR
 *   3. _payment_id starting "pay_"                                                → Nano
 *   4. no _payment_id and "_pay_with": "near" or "usdc"                                     → NEAR
 *   5. everything else                                                            → Nano
 * Strip the Nano selector before the Nano gate. The NEAR gate receives an
 * explicit native/token selector to reject cross-asset resumes, then strips it
 * before hashing the workflow arguments.
 */
import { ParamsError } from "./tools.mjs";

const PAY_WITH = new Set(["nano", "near", "usdc"]);
const NEAR_FIELDS = ["_payment_tx", "_payment_sender"];

const refuse = (text) => ({ content: [{ type: "text", text }], isError: true });

/**
 * @param {object} o
 * @param {{listTools: Function, callTool: Function}} o.nano  createChargeGate().wrapRegistry(registry)
 * @param {{listTools: Function, callTool: Function, sells: (name: string) => boolean, nearOnly: Set<string>}} o.near
 *        createNearGate().wrapRegistry(registry)
 */
export function createRailRouter({ nano, near }) {
  const nearOnly = near.nearOnly;

  /** Which gate answers, and the arguments it sees; or a refusal. Pure: exported for tests via route(). */
  function route(params) {
    if (params == null || typeof params !== "object" || Array.isArray(params)) return { gate: "nano", params };
    const name = params.name;
    const raw = params.arguments;
    if (raw != null && (typeof raw !== "object" || Array.isArray(raw))) {
      return { gate: nearOnly.has(name) ? "near" : "nano", params };
    }
    const args = raw == null ? {} : raw;
    const { _pay_with: payWith, ...rest } = args;

    if (payWith !== undefined && !PAY_WITH.has(payWith)) {
      return { refusal: `_pay_with must be ${near.assets?.has("usdc") ? '"nano", "near" or "usdc"' : '"nano" or "near"'}, got ${JSON.stringify(payWith).slice(0, 40)}. Nothing was charged.` };
    }
    const stripped = raw == null && payWith === undefined ? params : { ...params, arguments: payWith === "usdc" ? { ...rest, _pay_with: "usdc" } : rest };
    const nearParams = payWith === "near" ? { ...params, arguments: { ...rest, _pay_with: "near" } } : stripped;
    const pid = rest._payment_id;
    const hasNearFields = NEAR_FIELDS.some((k) => rest[k] != null);

    const nanoQuote = typeof pid === "string" && pid.startsWith("pay_");
    if (payWith === "usdc" && !near.assets?.has("usdc") && !nanoQuote) {
      return { refusal: "USDC payments are not enabled on this server. If you already have a quote, keep its original _payment_id and payment asset. Nothing was charged." };
    }
    if (nearOnly.has(name)) {
      if (payWith === "nano" || nanoQuote) {
        return { refusal: `${name} does not accept Nano (XNO) payments on this server. See the tool schema for supported payment assets. Nothing was charged.` };
      }
      return { gate: "near", params: nearParams };
    }
    if (pid != null) {
      const id = String(pid);
      if (id.startsWith("nq_")) {
        if (payWith === "nano") return { refusal: "This quote uses a different payment asset. Keep the same _payment_id and original workflow arguments; remove _pay_with, then retry. Nothing was consumed." };
        return { gate: "near", params: nearParams };
      }
      if (id.startsWith("pay_")) {
        if (payWith === "near" || payWith === "usdc" || hasNearFields) {
          return { refusal: `payment id ${id} is a Nano (XNO) quote. Keep the same _payment_id and original workflow arguments; remove _pay_with, _payment_tx and _payment_sender, then retry. Nothing was consumed.` };
        }
        return { gate: "nano", params: stripped };
      }
      // An id neither gate issued: let the chosen gate answer "unknown payment id".
      return payWith === "near" || payWith === "usdc" || hasNearFields
        ? { gate: "near", params: nearParams } : { gate: "nano", params: stripped };
    }
    if (payWith === "near" || payWith === "usdc") {
      if (!near.sells(name)) {
        return { refusal: `${name} does not accept ${payWith === "usdc" ? "USDC" : "NEAR"} payments on this server. See the tool schema for supported payment assets. Nothing was charged.` };
      }
      return { gate: "near", params: nearParams };
    }
    if (hasNearFields) {
      return { refusal: `Nano (XNO) requests do not use _payment_tx or _payment_sender. For Nano, remove _payment_tx and _payment_sender and retry with the same workflow arguments. If you already paid, include the original _payment_id and keep its payment rail. Nothing was charged.` };
    }
    return { gate: "nano", params: stripped };
  }

  const PAY_WITH_SCHEMA = {
    type: "string",
    enum: ["nano", "near", ...(near.assets?.has("usdc") ? ["usdc"] : [])],
    description: 'Payment rail for the quote: "nano" (default, XNO over x402), "near" (native NEAR)' + (near.assets?.has("usdc") ? ' or "usdc" (Circle-issued USDC on NEAR).' : '.'),
  };
  const NEAR_SENTENCE = ' It can also be paid in NEAR: add "_pay_with": "near" for a NEAR quote, send the exact amount in one transfer, ' +
    "then call again with the same arguments plus _payment_id, _payment_tx and _payment_sender.";

  function listTools() {
    const nanoList = nano.listTools();
    const nearList = near.listTools();
    const nearByName = new Map(nearList.map((t) => [t.name, t]));
    const out = nanoList.map((t) => {
      if (nearOnly.has(t.name) || !near.sells(t.name)) return t;
      const nt = nearByName.get(t.name);
      const nearProps = (nt && nt.inputSchema && nt.inputSchema.properties) || {};
      return {
        ...t,
        description: t.description + NEAR_SENTENCE,
        inputSchema: {
          ...t.inputSchema,
          properties: {
            ...(t.inputSchema.properties || {}),
            _pay_with: PAY_WITH_SCHEMA,
            ...(nearProps._payment_tx ? { _payment_tx: nearProps._payment_tx } : {}),
            ...(nearProps._payment_sender ? { _payment_sender: nearProps._payment_sender } : {}),
          },
        },
      };
    });
    const have = new Set(out.map((t) => t.name));
    for (const t of nearList) if (nearOnly.has(t.name) && !have.has(t.name)) out.push(t);
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
    return r.gate === "near" ? near.callTool(r.params, ctx) : nano.callTool(r.params, ctx);
  }

  return { listTools, callTool, route };
}

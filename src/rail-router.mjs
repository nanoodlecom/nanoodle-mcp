/**
 * One server, two payment rails: route each tools/call to the Nano charge gate
 * (src/gate.mjs) or the NEAR gate (src/near-gate.mjs). Neither gate knows the
 * other exists; this module only decides which one answers.
 *
 * Routing, in order:
 *   1. a tool only the NEAR gate offers (run_noodle, price_noodle, noodle_guide)  → NEAR
 *   2. _payment_id starting "nq_"                                                 → NEAR
 *   3. _payment_id starting "pay_"                                                → Nano
 *   4. no _payment_id and "_pay_with": "near"                                     → NEAR
 *   5. everything else                                                            → Nano
 * `_pay_with` is removed before a gate sees the call, so the quote and the
 * paying call hash to the same arguments whether or not the paying call
 * repeats it. Contradictory payment arguments are refused before either gate
 * runs, so nothing is quoted or consumed.
 */
import { ParamsError } from "./tools.mjs";

const PAY_WITH = new Set(["nano", "near"]);
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
      return { refusal: `_pay_with must be "nano" or "near", got ${JSON.stringify(payWith).slice(0, 40)}. Nothing was charged.` };
    }
    const stripped = raw == null && payWith === undefined ? params : { ...params, arguments: rest };
    const pid = rest._payment_id;
    const hasNearFields = NEAR_FIELDS.some((k) => rest[k] != null);

    if (nearOnly.has(name)) {
      if (payWith === "nano") {
        return { refusal: `${name} is paid in NEAR only on this server; call it without "_pay_with" (or with "_pay_with": "near"). Nothing was charged.` };
      }
      return { gate: "near", params: stripped };
    }
    if (pid != null) {
      const id = String(pid);
      if (id.startsWith("nq_")) {
        if (payWith === "nano") return { refusal: `payment id ${id} is a NEAR quote, but "_pay_with" says nano. Drop "_pay_with" (or set it to "near") and call again. Nothing was consumed.` };
        return { gate: "near", params: stripped };
      }
      if (id.startsWith("pay_")) {
        if (payWith === "near" || hasNearFields) {
          return { refusal: `payment id ${id} is a Nano (XNO) quote; it takes no "_pay_with": "near", _payment_tx or _payment_sender. Call again with the same arguments plus only "_payment_id". Nothing was consumed.` };
        }
        return { gate: "nano", params: stripped };
      }
      // An id neither gate issued: let the chosen gate answer "unknown payment id".
      return { gate: payWith === "near" || hasNearFields ? "near" : "nano", params: stripped };
    }
    if (payWith === "near") {
      if (!near.sells(name)) {
        return { refusal: `${name} cannot be paid in NEAR on this server. Pay in Nano (XNO) instead: call it again without "_pay_with". Nothing was charged.` };
      }
      return { gate: "near", params: stripped };
    }
    if (hasNearFields) {
      return { refusal: `_payment_tx and _payment_sender pay a NEAR quote: ask for one with "_pay_with": "near", send the transfer, then call again with _payment_id, _payment_tx and _payment_sender. Nothing was charged.` };
    }
    return { gate: "nano", params: stripped };
  }

  const PAY_WITH_SCHEMA = {
    type: "string",
    enum: ["nano", "near"],
    description: 'Payment rail for the quote: "nano" (default, XNO over x402) or "near" (native NEAR). Only needed to ask for a NEAR quote.',
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

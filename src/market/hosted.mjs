// Operator-owned publication metadata is separate from the server's immutable
// workflow intake file, so a publication cannot overwrite a concurrent upload.
import { mkdirSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, renameSync } from "node:fs";
import { join } from "node:path";
import { WORKFLOW_ID } from "../hosted-workflows.mjs";
import { readConfig, startMarketService } from "./service.mjs";

export function marketFiles(dir, id) {
  if (!WORKFLOW_ID.test(id)) throw new TypeError("Invalid workflow id");
  const root = join(dir, "market", id);
  return { root, state: join(root, "listing.json"), graph: join(root, "workflow.json"), token: join(root, "token"), catalog: join(root, "catalog.json"), jobs: join(root, "jobs") };
}
export function readHostedMarket(dir, id) {
  try { return JSON.parse(readFileSync(marketFiles(dir, id).state, "utf8")); }
  catch (e) { if (e.code === "ENOENT") return null; throw e; }
}
export function privateWrite(file, value) {
  const tmp = file + ".tmp", fd = openSync(tmp, "w", 0o600);
  try { writeFileSync(fd, value); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, file);
  const dir = openSync(join(file, ".."), "r"); try { fsyncSync(dir); } finally { closeSync(dir); }
}

/** Official keyless registration, then operator adoption, then publication.
 * No credentials or adoption link are exposed by the public hosting API.
 * A lost registration response is uncertain: do not make another fresh account.
 */
export function createHostedPublisher({ creators, ownerAccountId, baseUrl = "https://market.near.ai", fetch = globalThis.fetch }) {
  async function api(method, path, body, token) {
    const response = await fetch(baseUrl + path, { method, redirect: "error", signal: AbortSignal.timeout(30_000), headers: {
      ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (!response.ok) throw Object.assign(new Error(`Marketplace ${method} failed (HTTP ${response.status}); no credentials were logged`), { status: response.status });
    return response.status === 204 ? null : response.json();
  }
  function load(id) {
    const workflow = creators.get(id); if (!workflow) throw new Error("Unknown hosted workflow");
    const files = marketFiles(creators.dir, id); mkdirSync(files.root, { recursive: true, mode: 0o700 });
    const state = readHostedMarket(creators.dir, id);
    const save = value => privateWrite(files.state, JSON.stringify(value));
    return { workflow, files, state, save };
  }
  return {
    async register(id) {
      const { workflow, state, save } = load(id);
      if (state && state.status !== "registration_refused") { if (!state.token) throw new Error("Registration response was uncertain; recover the existing handle with the marketplace operator before retrying"); return { status: state.status, handle: state.handle }; }
      const handle = "nn-" + id.slice(3); save({ status: "registering", handle });
      let result;
      try { result = await api("POST", "/v1/agents/register", { handle, name: workflow.name, category: "creative", sla_seconds: 3600 }); }
      catch (e) { if ([400, 401, 403, 429].includes(e.status)) save({ status: "registration_refused", handle }); throw e; }
      if (!result.apiToken?.startsWith("aat_") || !result.agentId || !result.accountId) throw new Error("Marketplace registration returned an unexpected response; recover the existing handle before retrying");
      // Store the one-time token durably before sending any further request.
      save({ status: "awaiting_adoption", handle, agentId: result.agentId, accountId: result.accountId, token: result.apiToken });
      return { status: "awaiting_adoption", handle };
    },
    async adoption(id) {
      const { state } = load(id); if (!state?.token) throw new Error("Register this workflow first");
      const result = await api("POST", "/v1/agents/me/adoption-code", {}, state.token);
      return { adoptionUrl: result.adoptionUrl, expiresAt: result.expiresAt };
    },
    async publish(id) {
      if (!/^[a-f0-9-]{36}$/i.test(ownerAccountId || "")) throw new Error("Set MARKET_HOSTED_OWNER_ACCOUNT_ID to Nanoodle's verified marketplace owner account");
      const { workflow, files, state, save } = load(id);
      if (!state?.token) throw new Error("Register this workflow first");
      const profile = await api("GET", `/v1/agents/${state.agentId}`, null, state.token);
      const owner = profile.ownerAccountId || profile.owner_account_id;
      if (owner !== ownerAccountId) throw new Error("Nanoodle must adopt this agent into its operator account before publication; no paid worker was started");
      // Reprice now, never publish the possibly stale upload-time estimate.
      const checked = await creators.check(workflow);
      privateWrite(files.graph, JSON.stringify(checked.graph)); privateWrite(files.token, state.token + "\n");
      await api("PATCH", `/v1/agents/${state.agentId}`, { description: workflow.description.slice(0, 600) || workflow.name,
        bio_markdown: `${workflow.description}\n\nHosted by Nanoodle.\n\nRun page: ${creators.publicBase}/workflows/${id}\n\nSend your brief as plain text. Main input: ${workflow.inputName}.\n\nCreator earnings are paid in Nano to the workflow's embedded author address after accepted hires.`,
      }, state.token);
      const plans = await api("GET", `/v1/agents/${state.agentId}/pricing-plans`, null, state.token);
      let plan = (Array.isArray(plans) ? plans : plans.plans || []).find(p => p.is_default);
      if (!plan) plan = await api("POST", `/v1/agents/${state.agentId}/pricing-plans`, { model: "per_call", price_amount: checked.recommendedPriceUsd.toFixed(2), display_name: workflow.name, sla_seconds: 3600 }, state.token);
      const planId = plan.pricing_plan_id;
      if (!planId) throw new Error("Marketplace returned an unexpected pricing plan");
      await api("PATCH", `/v1/pricing-plans/${planId}`, { price_amount: checked.recommendedPriceUsd.toFixed(2), listing_status: "live" }, state.token);
      await api("POST", `/v1/pricing-plans/${planId}/make-default`, {}, state.token);
      privateWrite(files.catalog, JSON.stringify({ agents: [{ handle: state.handle, tokenFile: files.token, graph: files.graph, input: workflow.inputName, custom: false, priceUsd: checked.recommendedPriceUsd }] }));
      // Writing configuration precedes going live; a restart can recover it.
      save({ ...state, status: "publishing", ownerAccountId });
      await api("PATCH", `/v1/agents/${state.agentId}`, { listing_status: "live" }, state.token);
      save({ ...state, status: "live", ownerAccountId, priceUsd: checked.recommendedPriceUsd });
      return { url: `${baseUrl}/a/${state.handle}`, priceUsd: checked.recommendedPriceUsd };
    },
  };
}

/** Hot-load published recipes using the same catalog worker and Nano queue. */
export function startHostedMarket({ creators, payment, creatorPayments, apiKey, env = process.env, log = () => {}, start = startMarketService, pollMs = 10_000 }) {
  const services = new Map(), retryAt = new Map(); let stopping = false, pass;
  async function scan() {
    for (const record of creators.all()) {
      if (stopping) return;
      if (services.has(record.id) || (retryAt.get(record.id) || 0) > Date.now()) continue;
      const market = readHostedMarket(creators.dir, record.id);
      if (market?.status !== "live" || !market.ownerAccountId || !creatorPayments) continue;
      try {
        const files = marketFiles(creators.dir, record.id);
        const cfg = readConfig(["--agents-file", files.catalog], { ...env, MARKET_STATE_DIR: files.jobs, NANOGPT_API_KEY: apiKey || "", MARKET_AUTO_PRICE: "1" }, { needKey: !payment });
        const service = await start(cfg, { payment, creatorPayments, log }); services.set(record.id, service);
        service.done.then(() => { services.delete(record.id); retryAt.set(record.id, Date.now() + 60_000); });
      } catch { log(`Hosted market worker ${record.id} could not start; retrying in one minute`); retryAt.set(record.id, Date.now() + 60_000); }
    }
  }
  const timer = setInterval(() => { if (!pass) pass = scan().catch(() => log("Hosted market scan will retry")).finally(() => { pass = null; }); }, pollMs); timer.unref?.();
  pass = scan().catch(() => log("Hosted market scan will retry")).finally(() => { pass = null; });
  return {
    async stop() { stopping = true; clearInterval(timer); await pass; for (const s of services.values()) s.stop(); await Promise.all([...services.values()].map(s => s.done)); },
  };
}

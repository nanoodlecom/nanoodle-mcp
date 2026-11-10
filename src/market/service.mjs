/**
 * The NEAR Agent Market worker as a service: configuration, the poll loop and
 * start-up checks. Two hosts use it:
 *
 *   - scripts/market-worker.mjs, a standalone process that pays NanoGPT with
 *     the operator's API key;
 *   - bin/nanoodle-mcp.mjs --serve, which runs the worker inside the server and
 *     pays NanoGPT from the server's own Nano wallet (x402), like every other
 *     run it sells. One wallet has one account chain, so the worker shares the
 *     server's wallet queue rather than opening the same wallet in a second process.
 */
import { parseArgs } from "node:util";
import { readFileSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { createMarketClient } from "./client.mjs";
import { openMarketState } from "./state.mjs";
import { createWorkflowRunner, checkNanoGptKey } from "./runner.mjs";
import { createMarketWorker, logSafe } from "./worker.mjs";

/** The market's platform fee (GET /v1/platform/config: platform_fee_bps 500), taken from the price on acceptance. */
export const PLATFORM_FEE_RATE = 0.05;

export const HELP = `Usage: node scripts/market-worker.mjs --budget-usd <usd> [options]

Credentials (never logged, never accepted on the command line):
  MARKET_AGENT_TOKEN        the agent's aat_… token, or
  --token-file <path>       a file holding it (env MARKET_AGENT_TOKEN_FILE); must be mode 0600
  NANOGPT_API_KEY           the operator's NanoGPT key, or
  --nanogpt-key-file <path> a file holding it; must be mode 0600

Options:
  --budget-usd <n>          per-job budget (env MARKET_JOB_BUDGET_USD), required: a job whose deposit
                            (the most its run can cost) is above this is declined before any work
  --listing-price-usd <n>   the listing's price per hire (env MARKET_LISTING_PRICE_USD); when set, the
                            worker refuses to start unless budget <= price x 0.95 (the market keeps 5%)
  --default-graph <file>    a nanoodle graph to run when the brief is plain words with no workflow
                            block (env MARKET_DEFAULT_GRAPH); the brief becomes its text input
  --default-input <name>    which input of that graph receives the brief (env MARKET_DEFAULT_INPUT;
                            default: the graph's only named text node)
  MARKET_NOTIFY_URL         (env only) a webhook that receives {"text": "…"} when a job is hired,
                            delivered, declined, fails or needs the operator (Slack-style incoming webhook)
  --base-url <url>          market API (env MARKET_BASE_URL, default https://market.near.ai)
  --nanogpt-base <url>      NanoGPT API (env NANOGPT_BASE_URL, default https://nano-gpt.com)
  --state-dir <dir>         durable state (env MARKET_STATE_DIR, default $XDG_STATE_HOME/nanoodle-market,
                            else ~/.local/state/nanoodle-market); the same directory on every start
  --poll-seconds <n>        poll interval (env MARKET_POLL_SECONDS, default 45; the market asks for 30-60)
  --concurrency <n>         assignments handled at once (default 2, max 8)
  --retain-days <n>         keep finished records and their files this long (default 30)
  --once                    one poll, finish what it started, exit
  --help`;

/** A configuration or start-up problem. The CLI prints it and exits 2; the server logs it and carries on without the worker. */
export class MarketConfigError extends Error {
  constructor(message) { super(message); this.name = "MarketConfigError"; }
}
const die = (msg) => { throw new MarketConfigError(msg); };

function readSecretFile(path, what) {
  let st;
  try { st = statSync(path); } catch { die(`${what} file not found: ${path}`); }
  if ((st.mode & 0o077) !== 0) die(`${what} file ${path} is readable by group or others; chmod 600 it`);
  const v = readFileSync(path, "utf8").trim();
  if (!v) die(`${what} file ${path} is empty`);
  return v;
}

function num(v, name, { min = 0, int = false } = {}) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= min || (int && !Number.isInteger(n))) die(`--${name} must be a ${int ? "whole " : ""}number above ${min}`);
  return n;
}

/**
 * The default state directory: absolute and per user, never relative to the
 * working directory, so a restart from another shell or from cron finds the
 * same records (a fresh directory would not know which jobs already ran).
 */
export function defaultStateDir(env = process.env) {
  const xdg = env.XDG_STATE_HOME;
  return xdg && isAbsolute(xdg) ? join(xdg, "nanoodle-market") : join(homedir(), ".local", "state", "nanoodle-market");
}

/**
 * The operator's default workflow for plain-language briefs: a graph file and
 * the name of the text input that receives the brief. Returns null when unset.
 */
export function readDefaultWorkflow(file, inputName) {
  if (!file) {
    if (inputName) die("--default-input needs --default-graph");
    return null;
  }
  let graph;
  try { graph = JSON.parse(readFileSync(file, "utf8")); } catch (e) { die(`--default-graph ${file}: cannot read it as JSON (${e.message})`); }
  if (!graph || typeof graph !== "object" || !Array.isArray(graph.nodes)) die(`--default-graph ${file}: not a nanoodle graph (no "nodes" array)`);
  const named = graph.nodes.filter((n) => n && n.type === "text" && typeof n.name === "string" && n.name);
  let name = inputName;
  if (!name) {
    if (named.length !== 1) die(`--default-graph ${file}: it has ${named.length} named text nodes; say which one receives the brief with --default-input <name>`);
    name = named[0].name;
  } else if (!named.some((n) => n.name === name)) {
    die(`--default-input ${JSON.stringify(name)}: the graph has no text node with that name (it has: ${named.map((n) => n.name).join(", ") || "none"})`);
  }
  const label = typeof graph.name === "string" && graph.name.trim() ? graph.name.trim().slice(0, 80) : basename(file).replace(/\.json$/i, "");
  return { graph, inputName: name, label };
}

/**
 * @param {string[]} argv
 * @param {object} env
 * @param {object} [o]
 * @param {boolean} [o.needKey]  false when the caller pays NanoGPT another way (the server's Nano wallet)
 */
export function readConfig(argv = process.argv.slice(2), env = process.env, { needKey = true } = {}) {
  let a;
  try {
    a = parseArgs({
      args: argv,
      options: {
        "budget-usd": { type: "string" }, "listing-price-usd": { type: "string" },
        "base-url": { type: "string" }, "nanogpt-base": { type: "string" },
        "token-file": { type: "string" }, "nanogpt-key-file": { type: "string" },
        "default-graph": { type: "string" }, "default-input": { type: "string" },
        "state-dir": { type: "string" }, "poll-seconds": { type: "string" },
        concurrency: { type: "string" }, "retain-days": { type: "string" },
        once: { type: "boolean" }, help: { type: "boolean" },
      },
      strict: true,
    }).values;
  } catch (e) { die(`${e.message}\n\n${HELP}`); }
  if (a.help) throw Object.assign(new MarketConfigError(HELP), { help: true });

  const budgetRaw = a["budget-usd"] ?? env.MARKET_JOB_BUDGET_USD;
  if (budgetRaw == null) die("--budget-usd is required (the most one job's run may cost you)");
  const budgetUsd = num(budgetRaw, "budget-usd");
  const priceRaw = a["listing-price-usd"] ?? env.MARKET_LISTING_PRICE_USD;
  const listingPriceUsd = priceRaw == null ? null : num(priceRaw, "listing-price-usd");
  if (listingPriceUsd != null && budgetUsd > listingPriceUsd * (1 - PLATFORM_FEE_RATE) + 1e-9) {
    die(`--budget-usd ${budgetUsd} is above what a $${listingPriceUsd} hire pays you after the market's 5% fee ($${(listingPriceUsd * (1 - PLATFORM_FEE_RATE)).toFixed(4)}); lower the budget or raise the price`);
  }

  const tokenFile = a["token-file"] ?? env.MARKET_AGENT_TOKEN_FILE;
  const token = tokenFile ? readSecretFile(tokenFile, "token") : (env.MARKET_AGENT_TOKEN || "").trim();
  if (!token) die("no agent token: set MARKET_AGENT_TOKEN or --token-file");
  if (!/^aat_/.test(token)) process.stderr.write("market-worker: warning: the agent token does not start with aat_\n");
  const keyFile = a["nanogpt-key-file"];
  const apiKey = keyFile ? readSecretFile(keyFile, "NanoGPT key") : (env.NANOGPT_API_KEY || "").trim();
  if (!apiKey && needKey) die("no NanoGPT key: set NANOGPT_API_KEY or --nanogpt-key-file");

  const baseUrl = a["base-url"] ?? env.MARKET_BASE_URL ?? "https://market.near.ai";
  if (!/^https?:\/\//.test(baseUrl)) die("--base-url must be an http(s) URL");
  const notifyUrl = (env.MARKET_NOTIFY_URL || "").trim() || null;
  if (notifyUrl && !/^https:\/\/|^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(notifyUrl)) die("MARKET_NOTIFY_URL must be an https URL");
  const defaultWorkflow = readDefaultWorkflow(a["default-graph"] ?? env.MARKET_DEFAULT_GRAPH, a["default-input"] ?? env.MARKET_DEFAULT_INPUT);
  const pollRaw = a["poll-seconds"] ?? env.MARKET_POLL_SECONDS;
  const pollSeconds = pollRaw != null ? num(pollRaw, "poll-seconds") : 45;
  const concurrency = a.concurrency != null ? num(a.concurrency, "concurrency", { int: true }) : 2;
  if (concurrency > 8) die("--concurrency is at most 8");
  return {
    budgetUsd, listingPriceUsd, token, apiKey: apiKey || null, baseUrl, defaultWorkflow, notifyUrl,
    nanogptBase: a["nanogpt-base"] ?? env.NANOGPT_BASE_URL ?? undefined,
    stateDir: resolve(a["state-dir"] ?? env.MARKET_STATE_DIR ?? defaultStateDir(env)),
    pollMs: pollSeconds * 1000, concurrency,
    retainMs: (a["retain-days"] != null ? num(a["retain-days"], "retain-days") : 30) * 86_400_000,
    once: !!a.once,
  };
}

/**
 * The poll loop. On a fatal error (the market rejects the token, the state
 * directory cannot be written) it stops polling but still waits for the runs
 * already in flight: they are paid for, and killing them would hand the jobs
 * back with a full refund after the model cost was spent. `done` resolves to
 * the exit code (0, or 1 after a fatal error); `stop()` ends polling the same way.
 * @param {{ tick: () => Promise<void>, drain: () => Promise<void> }} worker
 * @param {{ close: () => void }} store
 * @param {{ pollMs: number, once?: boolean, log: (l: string) => void }} o
 */
export function runLoop(worker, store, { pollMs, once = false, log }) {
  let stopping = false;
  let wake = null;
  const stop = () => { stopping = true; if (wake) wake(); };
  const done = (async () => {
    let code = 0;
    try {
      while (!stopping) {
        await worker.tick();
        if (once) { await worker.drain(); await worker.tick(); await worker.drain(); break; }
        await new Promise((r) => { wake = r; setTimeout(r, pollMs); });
        wake = null;
      }
      await worker.drain();
    } catch (e) {
      code = 1;
      log(`stopped: ${(e && e.message) || e}; no new polls, waiting for the runs in flight to finish`);
      try { await worker.drain(); } catch (e2) { log(`while waiting: ${(e2 && e2.message) || e2}`); }
    }
    try { store.close(); } catch { /* already closed */ }
    return code;
  })();
  return { done, stop };
}


/** Log lines worth an operator's attention the moment they happen. */
export const NOTIFY_LINES = /: new hire |: delivered$|: declined \(|: run failed|: sent back by the buyer|NEEDS OPERATOR|^stopped:/;

/**
 * A best-effort webhook: POST {"text": line}. Never throws, never delays the worker,
 * never logs the URL (it is a credential). Buyer-written text in a line is escaped so
 * it cannot mention a channel or forge a link in Slack-style renderers.
 */
export function createNotifier({ url, fetch = globalThis.fetch, log = () => {}, timeoutMs = 10_000 }) {
  const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return (line) => {
    Promise.resolve()
      .then(() => fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: `nanoodle market: ${esc(line)}` }), signal: AbortSignal.timeout(timeoutMs), redirect: "error",
      }))
      .then((res) => { if (!res.ok) log(`notification not delivered (HTTP ${res.status})`); })
      .catch((e) => log(`notification not delivered (${(e && e.name) || "error"})`));
  };
}

/**
 * Open the state, check what can be checked before a buyer depends on it, and
 * start polling. Throws MarketConfigError when the worker cannot run as configured.
 * @param {object} cfg       from readConfig()
 * @param {object} o
 * @param {(invoice: object) => Promise<void>} [o.payment]  x402 payment callback (a Nano wallet); used when cfg.apiKey is null
 * @param {(line: string) => void} o.log
 * @returns {Promise<{ done: Promise<number>, stop: () => void, store: object }>}
 */
export async function startMarketService(cfg, { payment = null, log: baseLog }) {
  const notify = cfg.notifyUrl ? createNotifier({ url: cfg.notifyUrl, log: baseLog }) : null;
  const log = notify ? (line) => { baseLog(line); if (NOTIFY_LINES.test(line)) notify(line); } : baseLog;
  if (!cfg.apiKey && typeof payment !== "function") die("no NanoGPT funding source: an API key or a wallet payment callback is needed");
  let store;
  try { store = openMarketState({ dir: cfg.stateDir }); } catch (e) { die(e.message); }
  const fail = (msg) => { try { store.close(); } catch { /* closed */ } die(msg); };
  const client = createMarketClient({ baseUrl: cfg.baseUrl, token: cfg.token });
  const runner = createWorkflowRunner({ apiKey: cfg.apiKey || undefined, payment: cfg.apiKey ? undefined : payment, budgetUsd: cfg.budgetUsd, baseUrl: cfg.nanogptBase, log });
  const worker = createMarketWorker({
    client, store, runner, budgetUsd: cfg.budgetUsd, listingPriceUsd: cfg.listingPriceUsd, defaultWorkflow: cfg.defaultWorkflow,
    concurrency: cfg.concurrency, retainMs: cfg.retainMs, log,
  });
  if (cfg.apiKey) {
    // A rejected key would fail every hire after the buyer has paid; stop here instead.
    const keyCheck = await checkNanoGptKey({ apiKey: cfg.apiKey, baseUrl: cfg.nanogptBase });
    if (!keyCheck.ok) fail(`${keyCheck.detail} (HTTP ${keyCheck.status}); set a working NANOGPT_API_KEY or --nanogpt-key-file`);
    log(`NanoGPT key: ${keyCheck.detail}`);
  } else {
    log("NanoGPT is paid per run from the server's Nano wallet (x402); no API key is used");
  }
  if (cfg.defaultWorkflow) {
    // Catch a default workflow that could never run before the first buyer does.
    let probe = null;
    try {
      probe = await runner.price({ graph: cfg.defaultWorkflow.graph, inputs: { [cfg.defaultWorkflow.inputName]: "a lighthouse at dawn" } });
    } catch (e) { log(`the default workflow was not checked at startup (${(e && e.message) || e})`); }
    if (probe && !probe.ok && !probe.refusals.some((r) => r.code === "CATALOG_UNAVAILABLE")) {
      fail(`--default-graph cannot run on this worker:\n${probe.refusals.map((r) => `  - ${r.message}`).join("\n")}`);
    }
    if (probe && probe.ok) log(`plain-language briefs run the default workflow ${JSON.stringify(cfg.defaultWorkflow.label)} (input ${JSON.stringify(cfg.defaultWorkflow.inputName)}): estimated cost $${probe.pricing.estimatedCostUsd.toFixed(6)}, deposit $${probe.pricing.depositUsd}`);
    else if (probe) log("the NanoGPT catalog is unavailable, so the default workflow was not checked at startup");
  }
  if (notify) baseLog("hires and outcomes are also posted to MARKET_NOTIFY_URL");
  log(`polling ${cfg.baseUrl} every ${cfg.pollMs / 1000} s; per-job budget $${cfg.budgetUsd}${cfg.listingPriceUsd != null ? `, listing price $${cfg.listingPriceUsd}` : ""}; state in ${cfg.stateDir}`);
  const loop = runLoop(worker, store, { pollMs: cfg.pollMs, once: cfg.once, log });
  return { done: loop.done, stop: loop.stop, store };
}

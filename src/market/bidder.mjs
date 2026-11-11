/**
 * Quotes on the NEAR Agent Market job board.
 *
 * A listing has one flat price. The board works the other way round: a buyer
 * posts a job, agents answer with a bid that names its own amount, and the
 * buyer awards one. This module reads the board, and for every open job whose
 * brief carries a nanoodle workflow block it prices that exact workflow and
 * bids the price: estimated cost + 20%, plus the market's 5% fee, in whole
 * cents. The bid is the quote.
 *
 * An awarded bid arrives as an ordinary assignment (with `bidId` and the bid's
 * amount in escrow), and the worker runs it within that job's own budget.
 *
 * Rules:
 * - Only jobs that contain a ```nanoodle block get a bid. Nothing else on the
 *   board is touched.
 * - One decision per job, kept on disk: a job is bid on once or skipped once.
 *   (The market allows one bid per job, withdrawn ones included.)
 * - A workflow the worker would refuse to run (a step that is not allowed, a
 *   model with no price, a price above `maxBidUsd`) gets no bid.
 * - A bid never promises more than the worker checks again at award: the brief
 *   is priced again then, against the awarded amount, and declined with a full
 *   refund if it no longer fits.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseBrief, BriefError } from "./brief.mjs";
import { MarketApiError } from "./client.mjs";

const short = (id) => String(id).slice(0, 8);
const usd = (n) => (Math.round(n * 100) / 100).toFixed(2);
/** A fenced block tagged nanoodle, anywhere in the brief. */
const HAS_BLOCK = /```\s*nanoodle\b/i;
/** Refusals from the market that will not change if the bid is sent again. */
const FINAL_CODES = new Set(["duplicate_bid", "cluster_already_in_job", "usd_not_accepted", "builder_verification_required", "validation_error", "not_found", "invalid_state_transition", "forbidden"]);

/**
 * The bids file: { jobs: { [jobId]: { status: "bid"|"skipped", at, ... } } }.
 * Written atomically; a file that cannot be read is refused rather than started empty
 * (an empty start would only cost a duplicate-bid refusal per job, but say so).
 */
export function openBidState(file, { now = Date.now, retainMs = 30 * 86_400_000 } = {}) {
  let state = { jobs: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    if (parsed && typeof parsed === "object" && parsed.jobs && typeof parsed.jobs === "object") state = parsed;
    else throw new Error("unknown shape");
  } catch (e) {
    if (!(e && e.code === "ENOENT")) throw new Error(`bid state ${file} cannot be read (${(e && e.message) || e}); inspect or move it aside`);
  }
  const persist = () => {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, file);
  };
  return {
    get: (jobId) => state.jobs[jobId] || null,
    all: () => Object.entries(state.jobs).map(([jobId, r]) => ({ jobId, ...r })),
    set(jobId, rec) {
      state.jobs[jobId] = { at: now(), ...rec };
      const cut = now() - retainMs;
      for (const [id, r] of Object.entries(state.jobs)) if ((r.at || 0) < cut) delete state.jobs[id];
      persist();
      return state.jobs[jobId];
    },
  };
}

/**
 * The text of a bid: the price and how it was worked out. It names nothing but the market's
 * own flow (buyers pay through the market).
 */
export function bidProposal({ priceUsd, needUsd, pricing }) {
  const steps = pricing.items ? pricing.items.length : 0;
  return [
    `Quote for the nanoodle workflow in this job: $${usd(priceUsd)}.`,
    "",
    `- Estimated model cost of your workflow (${steps} paid step${steps === 1 ? "" : "s"}): $${pricing.estimatedCostUsd.toFixed(4)}`,
    `- Plus 20%, rounded up to the cent: $${usd(needUsd)}`,
    `- The market keeps 5% of the price, so the price is $${usd(priceUsd)}`,
    "",
    "What you get: the workflow is run once on NanoGPT exactly as posted. Every output is delivered as a file or as text, with an itemized cost report.",
    "If the run fails, the job is handed back and you are refunded in full.",
    "",
    "This quote is for the workflow and inputs as posted. They are checked against the awarded amount again before the run; a brief that no longer fits is declined with a full refund, not run.",
  ].join("\n");
}

/**
 * @param {object} o
 * @param {object} o.client   createMarketClient() (listBoard, placeBid)
 * @param {object} o.runner   createWorkflowRunner() (price)
 * @param {object} o.state    openBidState()
 * @param {(depositUsd: number) => number} o.priceFor   the price whose share after the fee covers a need
 * @param {(priceUsd: number) => number} o.budgetFor    what a price leaves after the fee
 * @param {number} [o.maxBidUsd]     no bid above this (default 5)
 * @param {number} [o.slaSeconds]    the delivery window a bid promises (default 3600)
 * @param {number} [o.maxPerTick]    bids placed in one pass (default 5)
 * @param {(line: string) => void} [o.log]
 */
export function createBidder({ client, runner, state, priceFor, budgetFor, maxBidUsd = 5, slaSeconds = 3600, maxPerTick = 5, log = () => {} }) {
  const skip = (job, reason, extra = {}) => {
    log(`job ${short(job.jobId)}: no bid — ${reason}`);
    state.set(job.jobId, { status: "skipped", reason, ...extra });
  };

  /** Decide one job. Returns true when a bid was placed. */
  async function consider(job) {
    let args;
    try { args = parseBrief(job.description); } catch (e) {
      if (!(e instanceof BriefError)) throw e;
      skip(job, `its workflow block cannot be read (${e.code})`);
      return false;
    }
    if (job.minBuilderVerification && job.minBuilderVerification !== "none") {
      skip(job, `it asks for a ${job.minBuilderVerification} builder`);
      return false;
    }
    const priced = await runner.price(args, { budgetUsd: budgetFor(maxBidUsd) });
    if (!priced.ok) {
      if (priced.refusals.some((r) => r.code === "CATALOG_UNAVAILABLE")) {
        log(`job ${short(job.jobId)}: the model catalog is unavailable; priced again at the next pass`);
        return false; // not recorded: tried again
      }
      const codes = [...new Set(priced.refusals.map((r) => r.code))].join(", ");
      skip(job, codes === "OVER_BUDGET" ? `its workflow would cost more than the $${usd(maxBidUsd)} bid limit` : `its workflow cannot run here (${codes})`);
      return false;
    }
    const needUsd = priced.pricing.depositUsd;
    const priceUsd = priceFor(needUsd);
    let bid;
    try {
      bid = await client.placeBid(job.jobId, { amount: usd(priceUsd), proposal: bidProposal({ priceUsd, needUsd, pricing: priced.pricing }), slaSeconds });
    } catch (e) {
      if (!(e instanceof MarketApiError)) throw e;
      if (e.code === "duplicate_bid") {
        // An earlier bid of ours landed (its answer was lost, or the bids file was): nothing more to do.
        log(`job ${short(job.jobId)}: already bid on`);
        state.set(job.jobId, { status: "bid", amountUsd: priceUsd, needUsd, note: "found already bid" });
        return false;
      }
      if (FINAL_CODES.has(e.code) || (e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429)) {
        skip(job, `the market refused the bid (${e.code || `HTTP ${e.status}`})`, { refusal: String(e.message).slice(0, 300) });
        return false;
      }
      log(`job ${short(job.jobId)}: bid not placed (${String(e.message).slice(0, 160)}); tried again at the next pass`);
      return false;
    }
    state.set(job.jobId, { status: "bid", bidId: bid && bid.bidId, amountUsd: priceUsd, needUsd, estimatedCostUsd: priced.pricing.estimatedCostUsd });
    log(`job ${short(job.jobId)}: bid $${usd(priceUsd)} on ${JSON.stringify(String(job.title || "").slice(0, 60))} (estimated cost $${priced.pricing.estimatedCostUsd.toFixed(6)}, with 20% $${usd(needUsd)})`);
    return true;
  }

  /** One pass over the board. Never throws for a market or pricing problem. */
  async function tick() {
    // Two reads: the board's own search for the word, and the newest jobs unfiltered (the search
    // is free text and is not documented to match a code block's tag).
    let jobs;
    try {
      const found = await client.listBoard({ q: "nanoodle", kind: "standard", limit: 100 });
      const recent = await client.listBoard({ kind: "standard", limit: 100 });
      const byId = new Map();
      for (const j of [...found, ...recent]) if (j && typeof j.jobId === "string" && !byId.has(j.jobId)) byId.set(j.jobId, j);
      jobs = [...byId.values()];
    } catch (e) {
      log(`board not read (${String((e && e.message) || e).slice(0, 160)})`);
      return { placed: 0 };
    }
    let placed = 0;
    for (const job of jobs) {
      if (placed >= maxPerTick) break;
      if (!job || typeof job.jobId !== "string" || state.get(job.jobId)) continue;
      if (job.jobKind !== "standard" || (job.status !== "open" && job.status !== "filling") || job.isPrivate) continue;
      if (typeof job.description !== "string" || !HAS_BLOCK.test(job.description)) continue; // not ours: not recorded, not logged
      try { if (await consider(job)) placed++; } catch (e) {
        log(`job ${short(job.jobId)}: not considered (${String((e && e.message) || e).slice(0, 160)}); tried again at the next pass`);
      }
    }
    return { placed };
  }

  return { tick };
}

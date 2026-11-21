// Built-in still image and video safe-for-work checks.
import { spawn } from "node:child_process";
import { lookup as dnsLookup } from "node:dns/promises";
import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { bytesToDataUrl, sniffMime, NanoClient } from "nanoodle";
import { ParamsError, formatCostUsd } from "./tools.mjs";

export const SFW_TOOL = "sfw_check";

/** Same margin the humanize v2.8 deposit uses (PR #77). Charge mode is not that branch. */
export const DEPOSIT_MARGIN = 0.12;
/** What the charge gate keeps on top of metered cost (cost / 5). */
export const SETTLE_MARKUP = 1.2;
/** Realistic text estimate: one token per 3.5 UTF-8 bytes. */
export const BYTES_PER_TOKEN = 3.5;
/** Margin on that estimate so a slightly denser tokenization still fits the quote. */
export const TOKEN_MARGIN = 1.1;
/** Role markers and a little template overhead, per chat message. */
export const MESSAGE_TOKENS = 4;
/**
 * Tokens reserved for one fitted still. Settlement is capped at the quote, so
 * this is a real cap: a picture that would exceed the remaining budget is not sent.
 */
export const SFW_IMAGE_TOKENS = 1000;
export const SFW_QUOTE_IS_ESTIMATE = false;

export const SFW_MODEL = "perplexity/pplx-decider-v1.2";
export const SFW_FRAMES_DEFAULT = 5;
export const SFW_FRAMES_MAX = 8;
const MAX_MEDIA_BYTES = 4 * 1024 * 1024;
/** Whole video download, including every redirect hop. */
export const MEDIA_FETCH_TIMEOUT_MS = 20_000;
/** Redirects followed by hand. The next hop is not requested past this cap. */
export const MEDIA_MAX_REDIRECTS = 5;
/** ffprobe and ffmpeg are killed when a sample runs longer than this. */
export const PROC_TIMEOUT_MS = 20_000;
/** Long edge of a sampled frame. Still images are not scaled with ffmpeg. */
const FRAME_MAX_EDGE = 512;

/**
 * Process spawner for video sampling. Tests replace `spawn` to prove a still
 * image never starts ffprobe or ffmpeg.
 */
export const mediaProcs = { spawn };

export const SFW_INSTRUCTIONS = "Is this image safe for work? Yes means no nudity, no sexual content, and no graphic violence or gore. Lingerie, explicit poses, and visible injury are no.";

/** $/1M tokens. Decision models have a $0 completion price. Catalog rows override these when they parse. */
export const DECISION_RATES = Object.freeze({
  [SFW_MODEL]: [0.02, 0],
});

const SFW_KEYS = new Set(["image", "video", "frames"]);

export function ceilUsd(n) {
  if (!(n > 0) || !Number.isFinite(n)) return 0;
  // Subtract a hair so a value that is already on a 1e-8 boundary is not bumped by float noise.
  return Math.ceil(n * 1e8 - 1e-6) / 1e8;
}

export function depositFromCharge(charge) {
  if (!(charge > 0) || !Number.isFinite(charge)) throw new Error("cannot price a call with no cost");
  return ceilUsd(charge * (1 + DEPOSIT_MARGIN));
}

function pick(args, name) {
  if (!args || typeof args !== "object") return undefined;
  const key = Object.keys(args).find((k) => String(k).trim().toLowerCase() === name);
  return key == null ? undefined : args[key];
}

function rejectNsfw(args, tool) {
  if (args && Object.prototype.hasOwnProperty.call(args, "nsfw") || (args && Object.keys(args).some((k) => String(k).trim().toLowerCase() === "nsfw"))) {
    throw new ParamsError(`${tool} cannot be turned off and has no NSFW switch. Remove "nsfw" and call again; nothing was charged.`);
  }
}

function unknownKeys(args, allowed, tool) {
  rejectNsfw(args, tool);
  for (const k of Object.keys(args || {})) {
    if (!allowed.has(String(k).trim().toLowerCase())) {
      throw new ParamsError(`unknown input "${k}" for ${tool}. Nothing was charged.`);
    }
  }
}

/**
 * Chat or decision $/1M [prompt, completion]. A catalog row wins when prompt is
 * > 0. Decision rows may have a 0 completion price; chat rows need both > 0.
 */
export function chatRates(catalogs, model, fallback) {
  const rows = catalogs && catalogs.chat;
  const decision = !!(fallback && fallback[1] === 0);
  if (Array.isArray(rows)) {
    const row = rows.find((m) => m && (m.id === model || m.model === model));
    const p = row && row.pricing;
    const pin = p && Number(p.prompt);
    const pout = p && Number(p.completion);
    if (pin > 0 && (decision || pout > 0)) return [pin, decision ? (Number.isFinite(pout) && pout > 0 ? pout : 0) : pout];
  }
  if (!fallback) throw new Error(`no price for ${model}`);
  return fallback;
}

/** UTF-8 bytes of text. Token estimates convert this at BYTES_PER_TOKEN. */
export function textBytes(s) {
  return Buffer.byteLength(String(s ?? ""), "utf8");
}

/** bytes/3.5, rounded up, then the small margin. */
export function estimateTokensFromBytes(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  return Math.ceil(n / BYTES_PER_TOKEN * TOKEN_MARGIN);
}

/**
 * What the payer is charged. The quote is a cap: metered × 1.2, and never more
 * than the deposit that was quoted for this request.
 */
export function settledCharge(metered, quote) {
  const raw = (Number(metered) > 0 && Number.isFinite(Number(metered)) ? Number(metered) : 0) * SETTLE_MARKUP;
  const cap = Number(quote);
  if (!(cap > 0) || !Number.isFinite(cap)) return raw;
  return Math.min(raw, cap);
}

/** Metered total reported to the charge gate, so its +20% cannot pass the quote. */
export function meteredWithinQuote(metered, quote) {
  const m = Number(metered) > 0 && Number.isFinite(Number(metered)) ? Number(metered) : 0;
  const cap = Number(quote);
  if (!(cap > 0) || !Number.isFinite(cap)) return m;
  return Math.min(m, cap / SETTLE_MARKUP);
}

/** Remaining deposit while a run is in flight. `fits` is the pre-stage check. */
export function openBudget(quote) {
  let metered = 0;
  const cap = Number(quote) > 0 && Number.isFinite(Number(quote)) ? Number(quote) : 0;
  return {
    quote: cap,
    get metered() { return metered; },
    remaining() { return cap - metered * SETTLE_MARKUP; },
    fits(stageSettled) {
      const need = Number(stageSettled) > 0 ? Number(stageSettled) : 0;
      return need <= this.remaining() + 1e-9;
    },
    add(usd) {
      if (typeof usd === "number" && Number.isFinite(usd) && usd > 0) metered += usd;
    },
  };
}

function noulQuestionBytes(instructions) {
  return textBytes(JSON.stringify({ type: "noul", instructions: String(instructions).trim() }));
}
/**
 * Provider USD for one decision. Text is bytes/3.5 plus the margin.
 * Each image adds SFW_IMAGE_TOKENS. A $0 completion price bills no output.
 */
export function decideProviderUsd({ model, questionBytes = 0, stateBytes = 0, images = 0 }, catalogs) {
  const fallback = DECISION_RATES[model];
  const [pin, pout] = chatRates(catalogs, model, fallback);
  const inTok = estimateTokensFromBytes(questionBytes + stateBytes) + MESSAGE_TOKENS + (images > 0 ? images * SFW_IMAGE_TOKENS : 0);
  const outTok = pout > 0 ? 32 : 0;
  return (inTok * pin + outTok * pout) / 1e6;
}

export function sfwChargeUsd({ images = 0, frames = 0 }, catalogs) {
  const n = images + frames;
  if (!(n > 0)) throw new Error("nothing to check");
  const one = decideProviderUsd({
    model: SFW_MODEL, questionBytes: noulQuestionBytes(SFW_INSTRUCTIONS), images: 1,
  }, catalogs);
  return one * n * SETTLE_MARKUP;
}

function requireArgs(args, tool) {
  if (args == null || typeof args !== "object" || Array.isArray(args)) {
    throw new ParamsError(`${tool} arguments must be an object. Nothing was charged.`);
  }
}

export function parseSfw(args, { hosted = false, remote = false } = {}) {
  requireArgs(args, SFW_TOOL);
  unknownKeys(args, SFW_KEYS, SFW_TOOL);
  // `remote` is the HTTP transport. `hosted` is billing. Either one is a
  // process that must not read the server's own disk; only stdio does.
  const noLocal = remote || hosted;
  const image = checkMedia(pick(args, "image"), "image", { remote: noLocal });
  const video = checkMedia(pick(args, "video"), "video", { remote: noLocal });
  if (!image && !video) throw new ParamsError(`${SFW_TOOL} needs an image, a video, or both. Nothing was charged.`);
  let frames = 0;
  if (video) {
    const raw = pick(args, "frames");
    if (raw == null || raw === "") frames = SFW_FRAMES_DEFAULT;
    else frames = parseFrameCount(raw);
  } else if (pick(args, "frames") != null && pick(args, "frames") !== "") {
    parseFrameCount(pick(args, "frames")); // still reject a bad value on an image-only call
  }
  return { image, video, frames, images: image ? 1 : 0 };
}

function parseFrameCount(raw) {
  const n = typeof raw === "number" ? raw : (typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN);
  if (!Number.isInteger(n) || n < 1 || n > SFW_FRAMES_MAX) {
    throw new ParamsError(`frames must be an integer from 1 to ${SFW_FRAMES_MAX}. Nothing was charged.`);
  }
  return n;
}

function checkMedia(value, label, { remote = false } = {}) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new ParamsError(`${label} must be a file path, an https URL, or a data URL. Nothing was charged.`);
  const v = value.trim();
  if (/^data:/i.test(v)) {
    const n = dataUrlSize(v);
    if (!(n >= 0)) throw new ParamsError(`${label} data URL is not valid. Nothing was charged.`);
    if (n > MAX_MEDIA_BYTES) throw new ParamsError(`${label} is over 4 MB. Nothing was charged.`);
    return v;
  }
  if (/^https?:\/\//i.test(v)) {
    let url;
    try { url = new URL(v); } catch {
      throw new ParamsError(`${label} URL is not valid. Nothing was charged.`);
    }
    if (url.username || url.password) {
      throw new ParamsError(`${label} URL must not include credentials. Nothing was charged.`);
    }
    const host = url.hostname.replace(/^\[|\]$/g, "").replace(/%.*/, "");
    if (isIP(host) && isBlockedIp(host)) {
      throw new ParamsError(`${label} URL is not a public address. Nothing was charged.`);
    }
    return v;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) {
    throw new ParamsError(`${label} must be a file path, an https URL, or a data URL. Nothing was charged.`);
  }
  // An HTTP listener is a remote caller even when it does not charge. A
  // filesystem path would read the server's own disk. Checked before stat
  // so a missing path and a real one return the same error.
  if (remote) {
    throw new ParamsError(`${label} must be an https URL or a data URL. A hosted server does not read local files. Nothing was charged.`);
  }
  if (!existsSync(v)) throw new ParamsError(`${label} file was not found. Nothing was charged.`);
  const st = statSync(v);
  if (!st.isFile()) throw new ParamsError(`${label} is not a file. Nothing was charged.`);
  if (st.size > MAX_MEDIA_BYTES) throw new ParamsError(`${label} is over 4 MB. Nothing was charged.`);
  return v;
}

function dataUrlSize(url) {
  const m = /^data:([^,]*),([\s\S]*)$/i.exec(url);
  if (!m) return -1;
  try {
    if (/;base64/i.test(m[1])) return Buffer.from(m[2], "base64").length;
    return Buffer.byteLength(decodeURIComponent(m[2]));
  } catch {
    return -1;
  }
}

function stepFail(step, e) {
  const err = new Error(`${step} failed: ${e && e.message ? e.message : e}`);
  err.cause = e;
  return err;
}

function takeCost() {
  const box = { usd: null };
  box.onCost = (c) => {
    const usd = c && typeof c === "object" ? c.usd : c;
    if (typeof usd === "number" && Number.isFinite(usd)) box.usd = (box.usd || 0) + usd;
  };
  return box;
}

function clientFor(ctx) {
  return new NanoClient({
    apiKey: ctx.apiKey || undefined,
    payment: ctx.apiKey ? null : (ctx.payment || null),
    baseUrl: ctx.baseUrl || undefined,
    fetch: ctx.fetch || globalThis.fetch,
  });
}

async function loadDecide() {
  return import(new URL("./decide.mjs", import.meta.resolve("nanoodle")));
}

async function runSfw(args, ctx) {
  const remote = !!(ctx.remote || ctx.hosted);
  const parsed = parseSfw(args, { remote });
  const { decideRun, DECIDE_IMG_FALLBACK } = await loadDecide();
  const client = clientFor(ctx);
  const fit = ctx.fit || fitStillImage;
  const sample = ctx.sampleFrames || sampleVideoFrames;
  const media = {
    remote,
    lookup: ctx.lookup,
    request: ctx.request,
    timeoutMs: ctx.mediaTimeoutMs,
  };
  const pictures = [];
  if (parsed.image) pictures.push({ source: "image", index: 0, url: parsed.image });
  if (parsed.video) {
    let frames;
    try {
      frames = await sample(parsed.video, parsed.frames, media);
    } catch (e) {
      throw stepFail("video", e);
    }
    if (!Array.isArray(frames) || frames.length !== parsed.frames) {
      throw new Error(`video sampling returned ${Array.isArray(frames) ? frames.length : 0} frame(s); expected ${parsed.frames}`);
    }
    frames.forEach((url, index) => pictures.push({ source: "video", index, url }));
  }
  const one = sfwChargeUsd({ images: 1 }, ctx.catalogs);
  const quote = depositFromCharge(sfwChargeUsd({ images: parsed.images, frames: parsed.frames }, ctx.catalogs));
  const spend = openBudget(quote);
  const outFrames = [];
  for (const pic of pictures) {
    if (!spend.fits(one)) {
      return finishResult({
        sfw: false,
        partial: true,
        stopped: "picture",
        verdict: "unchecked",
        frames: outFrames,
      }, outFrames, spend.quote);
    }
    try {
      const cost = { usd: null };
      const out = await decideRun(
        { mode: "yesno", question: SFW_INSTRUCTIONS },
        SFW_MODEL,
        "",
        [pic.url],
        DECIDE_IMG_FALLBACK,
        async (body) => {
          const box = takeCost();
          const j = await client.decide(body, { onCost: box.onCost });
          cost.usd = box.usd;
          return j;
        },
        (url, maxDim, byteBudget) => fit(url, maxDim, byteBudget, media),
      );
      const yes = out.decision.yes;
      outFrames.push({
        source: pic.source,
        index: pic.index,
        verdict: yes >= 0.5 ? "yes" : "no",
        yes,
        usd: cost.usd,
      });
      spend.add(cost.usd);
    } catch (e) {
      throw stepFail(`${pic.source} ${pic.index}`, e);
    }
  }
  const sfw = outFrames.length === pictures.length && outFrames.every((f) => f.verdict === "yes");
  return finishResult({
    sfw,
    verdict: sfw ? "yes" : "no",
    frames: outFrames,
  }, outFrames, spend.quote);
}

/**
 * Real provider cost stays on `providerUsd` with an honest `providerExact`.
 * `billedUsd` is what the customer pays: min(provider × 1.2, the deposit).
 * `costUsd` is the metered base the charge gate already settles, clamped so
 * that min(costUsd × 1.2, deposit) cannot pass the quote. That base is not
 * labeled exact when it is lower than the provider cost.
 */
export function finishResult(payload, parts, quote) {
  let usd = 0;
  let any = false;
  let exact = true;
  for (const p of parts) {
    if (p && typeof p.usd === "number" && Number.isFinite(p.usd)) { usd += p.usd; any = true; }
    else if (p) exact = false;
    if (p && p.exact === false) exact = false;
  }
  const metered = any ? usd : (payload && payload.partial ? 0 : null);
  const providerUsd = metered;
  const providerExact = exact && metered != null;
  const billedUsd = metered == null ? null : settledCharge(metered, quote);
  const costUsd = metered == null ? null : meteredWithinQuote(metered, quote);
  const clamped = providerUsd != null && costUsd != null && providerUsd - costUsd > 1e-9;
  const costExact = providerExact && !clamped;
  const content = [{ type: "text", text: JSON.stringify(payload) }];
  if (providerUsd != null) {
    const bound = providerExact ? "" : " (a lower bound — some calls did not report a price, so the actual cost may be higher)";
    const bill = clamped ? `; billed $${formatCostUsd(billedUsd)} (capped at the deposit)` : "";
    content.push({ type: "text", text: `cost: $${formatCostUsd(providerUsd)}${bound}${bill}` });
  }
  return { content, costUsd, costExact, providerUsd, providerExact, billedUsd, textOutput: true };
}

function ipv4ToInt(ip) {
  const p = String(ip).split(".");
  if (p.length !== 4) return null;
  const n = p.map((x) => Number(x));
  if (n.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
  return ((n[0] << 24) | (n[1] << 16) | (n[2] << 8) | n[3]) >>> 0;
}

/** Private, loopback, link-local, CGNAT, multicast, and IPv4-mapped forms of those. */
function ipv4Blocked(ip) {
  const n = ipv4ToInt(ip);
  if (n == null) return true;
  const a = n >>> 24;
  const b = (n >>> 16) & 255;
  const c = (n >>> 8) & 255;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local, including 169.254.169.254
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // 192.0.0.0/24, 192.0.2.0/24
  if (a === 192 && b === 88 && c === 99) return true; // 192.88.99.0/24 6to4 anycast
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24
  if (n >= 0xE0000000) return true; // multicast 224/4, reserved 240/4, broadcast
  return false;
}

function expandIPv6(ip) {
  const bare = String(ip).split("%")[0].toLowerCase();
  let rest = bare;
  const dotted = bare.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const v4 = ipv4ToInt(dotted[1]);
    if (v4 == null) return null;
    rest = bare.slice(0, -dotted[1].length) + (v4 >>> 16).toString(16) + ":" + (v4 & 0xffff).toString(16);
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  let head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
  } else {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    head = [...head, ...Array(missing).fill("0"), ...tail];
  }
  if (head.length !== 8) return null;
  const words = head.map((h) => (h === "" ? 0 : parseInt(h, 16)));
  if (words.some((w) => !Number.isInteger(w) || w < 0 || w > 0xffff)) return null;
  return words;
}

/** First `bits` of `words` equal the prefix words. Missing prefix words are 0. */
function prefixMatch(words, bits, ...prefix) {
  let left = bits;
  for (let i = 0; left > 0 && i < 8; i++) {
    const take = Math.min(16, left);
    const mask = take === 16 ? 0xffff : (0xffff << (16 - take)) & 0xffff;
    const expect = prefix[i] || 0;
    if ((words[i] & mask) !== (expect & mask)) return false;
    left -= take;
  }
  return true;
}

function v4FromWords(words, i) {
  return `${words[i] >> 8}.${words[i] & 255}.${words[i + 1] >> 8}.${words[i + 1] & 255}`;
}

/**
 * True unless the address is global unicast. IPv4-mapped (::ffff:0:0/96),
 * NAT64 (64:ff9b::/96), and 6to4 (2002::/16) are judged by the embedded IPv4,
 * so a private or special v4 stays blocked. Everything else outside 2000::/3
 * is blocked, including ::/128, ::1, 100::/64, ULA, link-local, site-local
 * fec0::/10, and multicast. Inside 2000::/3, documentation and the IETF
 * special block 2001::/23 are blocked too.
 */
export function isBlockedIp(ip) {
  const s = String(ip ?? "").trim().replace(/%.*/, "");
  if (!s) return true;
  const fam = isIP(s);
  if (fam === 4) return ipv4Blocked(s);
  if (fam !== 6) return true;
  const words = expandIPv6(s);
  if (!words) return true;
  if (prefixMatch(words, 96, 0, 0, 0, 0, 0, 0xffff)) return ipv4Blocked(v4FromWords(words, 6));
  if (prefixMatch(words, 96, 0x64, 0xff9b)) return ipv4Blocked(v4FromWords(words, 6));
  if (prefixMatch(words, 16, 0x2002)) return ipv4Blocked(v4FromWords(words, 1));
  if (!prefixMatch(words, 3, 0x2000)) return true;
  if (prefixMatch(words, 23, 0x2001, 0)) return true; // 2001::/23 special
  if (prefixMatch(words, 32, 0x2001, 0xdb8)) return true; // 2001:db8::/32 documentation
  if (prefixMatch(words, 20, 0x3fff, 0)) return true; // 3fff::/20 documentation
  return false;
}

function bareHost(hostname) {
  return String(hostname).replace(/^\[|\]$/g, "").replace(/%.*/, "");
}

function defaultLookup(hostname) {
  const host = bareHost(hostname);
  if (isIP(host)) return Promise.resolve([{ address: host, family: isIP(host) }]);
  return dnsLookup(host, { all: true, verbatim: true });
}

async function resolvePublic(hostname, lookup) {
  const host = bareHost(hostname);
  let addrs;
  try { addrs = await lookup(host); }
  catch { throw new Error(`refusing ${host}: address is not public`); }
  const list = (Array.isArray(addrs) ? addrs : [addrs]).map((a) => (typeof a === "string" ? a : a && a.address)).filter(Boolean);
  if (!list.length) throw new Error(`refusing ${host}: address is not public`);
  for (const addr of list) {
    if (isBlockedIp(addr)) throw new Error(`refusing ${host}: address is not public`);
  }
  return list[0];
}

function destroyStream(res) {
  const stream = res && (res.stream || res);
  try { if (stream && typeof stream.destroy === "function") stream.destroy(); } catch { /* already closed */ }
  try { if (res && res.req && typeof res.req.destroy === "function") res.req.destroy(); } catch { /* already closed */ }
}

/** Drop the socket as well as the request. req.destroy() does not always run the socket's own destroy. */
function destroyReq(req) {
  if (!req) return;
  try { if (typeof req.destroy === "function") req.destroy(); } catch { /* already closed */ }
  try { if (req.socket && typeof req.socket.destroy === "function") req.socket.destroy(); } catch { /* already closed */ }
}

function requestOnce(url, ip, { timeoutMs, register }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const family = isIP(ip) === 6 ? 6 : 4;
    const req = lib.request({
      host: ip,
      servername: bareHost(url.hostname),
      port: url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80),
      method: "GET",
      path: `${url.pathname}${url.search}`,
      headers: { host: url.host, accept: "*/*" },
      family,
      timeout: timeoutMs,
    }, (res) => resolve({ status: res.statusCode, headers: res.headers, stream: res, req }));
    if (register) register(req);
    if (req.destroyed) {
      destroyReq(req);
      reject(new Error("media download timed out"));
      return;
    }
    const fail = (e) => { destroyReq(req); reject(e instanceof Error ? e : new Error("media download timed out")); };
    req.on("error", fail);
    req.on("timeout", () => fail(new Error("media download timed out")));
    req.end();
  });
}

async function readCapped(res, byteCap, deadline, overMsg) {
  const stream = res.stream || res;
    const chunks = [];
    let total = 0;
    let timer;
    try {
      const body = await new Promise((resolve, reject) => {
        let settled = false;
        const remaining = Math.max(1, deadline - Date.now());
        timer = setTimeout(() => {
          destroyStream(res);
          if (settled) return;
          settled = true;
          reject(new Error("media download timed out"));
        }, remaining);
        const done = (fn, val) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(val);
        };
        stream.on("data", (chunk) => {
        if (Date.now() > deadline) {
          destroyStream(res);
          done(reject, new Error("media download timed out"));
          return;
        }
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buf.length;
        if (total > byteCap) {
          destroyStream(res);
          done(reject, new Error(overMsg));
          return;
        }
        chunks.push(buf);
      });
      stream.on("end", () => done(resolve, Buffer.concat(chunks)));
      stream.on("error", (e) => done(reject, e));
    });
    return body;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * GET an http(s) URL. One deadline covers DNS, every redirect, the request,
 * and the body. A lookup that resolves after the deadline does not send.
 * Each hop is rejected unless every address is public, then the socket is
 * opened to that address (not the name). Redirects are manual. The body is
 * counted as it arrives and destroyed once it passes `byteCap`.
 */
export function fetchPublicBytes(rawUrl, {
  lookup = defaultLookup,
  request = requestOnce,
  byteCap = MAX_MEDIA_BYTES,
  timeoutMs = MEDIA_FETCH_TIMEOUT_MS,
  maxRedirects = MEDIA_MAX_REDIRECTS,
  overMsg = "video is over 4 MB",
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let timedOut = false;
  let inflight = null;
  let settled = false;
  const drop = () => {
    const cur = inflight;
    inflight = null;
    if (!cur) return;
    try { cur.destroy(); } catch { /* already closed */ }
  };
  const past = () => timedOut || Date.now() >= deadline;
  return new Promise((resolve, reject) => {
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      drop();
      fn(val);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      finish(reject, new Error("media download timed out"));
    }, timeoutMs);
    const track = (req) => {
      inflight = { destroy: () => destroyReq(req) };
      if (past()) drop();
    };
    (async () => {
      let current;
      try { current = new URL(rawUrl); } catch { throw new Error("media URL is not valid"); }
      for (let hop = 0; hop <= maxRedirects; hop++) {
        if (past()) throw new Error("media download timed out");
        if (current.protocol !== "http:" && current.protocol !== "https:") throw new Error("media URL must be http or https");
        if (current.username || current.password) throw new Error("media URL must not include credentials");
        const ip = await resolvePublic(current.hostname, lookup);
        if (past()) throw new Error("media download timed out");
        const res = await request(current, ip, {
          timeoutMs: Math.max(1, deadline - Date.now()),
          register: track,
        });
        inflight = { destroy: () => destroyStream(res) };
        if (past()) throw new Error("media download timed out");
        const status = res.status;
        if (status >= 300 && status < 400) {
          const loc = res.headers && (res.headers.location || res.headers.Location);
          destroyStream(res);
          inflight = null;
          if (!loc) throw new Error(`redirect missing location (HTTP ${status})`);
          if (hop === maxRedirects) throw new Error("too many redirects");
          try { current = new URL(loc, current); } catch { throw new Error("redirect location is not a valid URL"); }
          continue;
        }
        if (status < 200 || status >= 300) {
          destroyStream(res);
          inflight = null;
          throw new Error(`could not fetch video (HTTP ${status})`);
        }
        const len = Number(res.headers && (res.headers["content-length"] ?? res.headers["Content-Length"]));
        if (Number.isFinite(len) && len > byteCap) {
          destroyStream(res);
          inflight = null;
          throw new Error(overMsg);
        }
        const body = await readCapped(res, byteCap, deadline, overMsg);
        inflight = null;
        return body;
      }
      throw new Error("too many redirects");
    })().then((v) => finish(resolve, v), (e) => finish(reject, e));
  });
}

function dataBytes(source, label, byteCap) {
  const m = /^data:([^,]*),([\s\S]*)$/i.exec(source);
  if (!m) throw new Error(`${label} data URL is not valid`);
  if (!/;base64/i.test(m[1])) throw new Error(`${label} data URL must be base64`);
  if (m[2].length > Math.ceil(byteCap * 4 / 3) + 8) throw new Error(`${label} is over 4 MB`);
  const buf = Buffer.from(m[2], "base64");
  if (buf.length > byteCap) throw new Error(`${label} is over 4 MB`);
  return buf;
}

async function loadMediaBytes(source, { hosted = false, remote = false, label = "media", byteCap = MAX_MEDIA_BYTES, lookup, request, timeoutMs } = {}) {
  if (/^data:/i.test(source)) return dataBytes(source, label, byteCap);
  if (/^https?:\/\//i.test(source)) {
    return fetchPublicBytes(source, {
      lookup, request, byteCap, timeoutMs,
      overMsg: `${label} is over 4 MB`,
    });
  }
  if (remote || hosted) throw new Error("a hosted server does not read local files");
  const buf = await readFile(source);
  if (buf.length > byteCap) throw new Error(`${label} is over 4 MB`);
  return buf;
}

/** Width and height from a PNG, JPEG, or GIF header. Null when the format is something else. */
export function imageDimensions(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b.length >= 24 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 8 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        if (i + 8 >= b.length) return null;
        return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      }
      if (len < 2) break;
      i += 2 + len;
    }
    return null;
  }
  if (b.length >= 10 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) {
    return { w: b.readUInt16LE(6), h: b.readUInt16LE(8) };
  }
  return null;
}

/**
 * Still images are not passed to ffprobe or ffmpeg. A picture that already
 * fits the decision model's long edge and encoded budget is sent as-is.
 */
export async function fitStillImage(url, maxDim, budget, opts = {}) {
  const bytes = await loadMediaBytes(url, { ...opts, label: "image" });
  const mime = sniffMime(bytes);
  const dataUrl = bytesToDataUrl(bytes, /^image\//.test(mime) ? mime : "application/octet-stream");
  if (dataUrl.length > budget) {
    throw new Error("image is over the decision model's size. Still images are not resized with ffmpeg.");
  }
  const dims = imageDimensions(bytes);
  if (dims && maxDim > 0 && Math.max(dims.w, dims.h) > maxDim) {
    throw new Error(`image is ${dims.w}×${dims.h}, over the ${maxDim}px limit. Still images are not resized with ffmpeg.`);
  }
  return dataUrl;
}

export function runProc(cmd, args, { timeoutMs = PROC_TIMEOUT_MS, input = null } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };
    const child = mediaProcs.spawn(cmd, args, {
      stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
    });
    const kill = () => {
      if (child.pid) {
        try { process.kill(-child.pid, "SIGKILL"); return; } catch { /* not a group leader */ }
      }
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    };
    const timer = setTimeout(() => {
      kill();
      finish(reject, new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (input != null && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(Buffer.isBuffer(input) ? input : Buffer.from(input));
    }
    const chunks = [];
    let err = "";
    child.stdout.on("data", (d) => chunks.push(d));
    child.stderr.on("data", (d) => { if (err.length < 240) err += String(d); });
    child.on("error", (e) => {
      kill();
      if (e && (e.code === "ENOENT" || e.code === "ENOTDIR")) {
        finish(reject, new Error(`${cmd} is not on PATH. Video checks need ffmpeg; image checks do not.`));
      } else finish(reject, e);
    });
    child.on("close", (code) => {
      if (settled) return;
      if (code !== 0) finish(reject, new Error(err.trim().slice(0, 200) || `${cmd} failed`));
      else finish(resolve, Buffer.concat(chunks));
    });
  });
}

/**
 * mp4, mov, webm, or matroska. Anything else (a DASH/HLS manifest, for one)
 * is refused so ffmpeg is never asked to open a playlist.
 */
export function videoContainer(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (b.length >= 12 && b.toString("ascii", 4, 8) === "ftyp") {
    return b.toString("ascii", 8, 12) === "qt  " ? "mov" : "mp4";
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    const head = b.subarray(0, Math.min(b.length, 4096)).toString("latin1");
    if (head.includes("webm")) return "webm";
    if (head.includes("matroska")) return "matroska";
  }
  return null;
}

/** Evenly spaced JPEG data URLs. The library's extractVideoFrames clusters at one end, which is the wrong sample for an SFW check. */
export async function sampleVideoFrames(source, count, opts = {}) {
  const bytesIn = await loadMediaBytes(source, { ...opts, label: "video" });
  const format = videoContainer(bytesIn);
  if (!format) throw new Error("video must be mp4, mov, webm, or matroska");
  const timeoutMs = opts.timeoutMs;
  // pipe + a forced demuxer: a playlist cannot open a file: or network URL,
  // and the only protocol ffmpeg is allowed is the stdin we just handed it.
  const locked = ["-protocol_whitelist", "pipe", "-f", format];
  const probe = await runProc("ffprobe", [
    "-v", "error", ...locked,
    "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", "pipe:0",
  ], { timeoutMs, input: bytesIn });
  const dur = Number(String(probe).trim());
  if (!(dur > 0)) throw new Error("could not read the video duration");
  const frames = [];
  for (let i = 0; i < count; i++) {
    const t = Math.min(Math.max(0, dur - 0.05), Math.max(0, dur * (i + 0.5) / count));
    const jpg = await runProc("ffmpeg", [
      "-hide_banner", "-loglevel", "error", ...locked,
      "-i", "pipe:0",
      "-ss", t.toFixed(3),
      "-frames:v", "1",
      "-vf", `scale=${FRAME_MAX_EDGE}:${FRAME_MAX_EDGE}:force_original_aspect_ratio=decrease`,
      "-q:v", "5",
      "-f", "mjpeg",
      "pipe:1",
    ], { timeoutMs, input: bytesIn });
    frames.push(`data:image/jpeg;base64,${jpg.toString("base64")}`);
  }
  return frames;
}

const SFW_NOTE = "a deposit is quoted for each request from how many pictures it checks and is a cap on the charge; it settles at the metered cost plus 20% or the quote, whichever is less, and a picture that would exceed the remaining budget is not checked; the difference is returned";

function spendLine(spendSource) {
  return `Runs on NanoGPT — every call spends real credit from ${spendSource}.`;
}

// The registry offers this built-in only when at least one graph loads.
export function createSfwTool({ spendSource, hosted = false, remote = false }) {
  const noLocal = remote || hosted;
  const sfw = {
    name: SFW_TOOL,
    builtin: true,
    pricedPerRequest: true,
    depositNote: SFW_NOTE,
    ffmpegFor: "video",
    file: "(built-in)",
    dir: "",
    deps: {},
    x402: { usd: 0 },
    card: {
      intent: "Say whether an image, or evenly sampled frames of a video, is safe for work.",
      steps: [
        { kind: "decide", label: "sfw", n: 1 },
      ],
      sample: null,
    },
    description:
      "Say whether an image, or evenly sampled frames of a video, is safe for work. One yes/no decision per picture " +
      `(${SFW_MODEL}). The check passes only when every picture is yes. Video sampling needs ffmpeg on the server; a still image does not. ` +
      `There is no switch to skip this check. ${spendLine(spendSource)}`,
    inputSchema: {
      type: "object",
      properties: {
        image: {
          type: "string",
          description: noLocal
            ? "optional; still image — https URL or data URL. At most 4 MB. A hosted server does not read local files. Does not use ffmpeg."
            : "optional; still image — file path, https URL, or data URL. At most 4 MB. Does not use ffmpeg.",
        },
        video: {
          type: "string",
          description: noLocal
            ? "optional; video — https URL or data URL. Frames are sampled evenly. At most 4 MB. Needs ffmpeg. A hosted server does not read local files."
            : "optional; video — file path, https URL, or data URL. Frames are sampled evenly. At most 4 MB. Needs ffmpeg.",
        },
        frames: { type: "integer", minimum: 1, maximum: SFW_FRAMES_MAX, description: `optional; how many video frames to check (1–${SFW_FRAMES_MAX}, default ${SFW_FRAMES_DEFAULT}). Ignored when there is no video.` },
      },
    },
    quote(args, ctx) {
      const parsed = parseSfw(args, { remote: noLocal });
      return depositFromCharge(sfwChargeUsd({ images: parsed.images, frames: parsed.frames }, ctx && ctx.catalogs));
    },
    coldDeposit(ctx) {
      return depositFromCharge(sfwChargeUsd({ images: 1, frames: SFW_FRAMES_MAX }, ctx && ctx.catalogs));
    },
    prepare(args) {
      parseSfw(args, { remote: noLocal });
    },
    run(args, ctx) {
      return runSfw(args, {
        ...ctx,
        remote: noLocal,
        fit: ctx.fit || this.deps.fit,
        sampleFrames: ctx.sampleFrames || this.deps.sampleFrames,
      });
    },
  };
  sfw.x402 = { usd: sfw.coldDeposit({}) };

  return sfw;
}

/** After a catalog refresh, re-pin each built-in's cold ceiling so a failed per-request quote still covers catalog prices. */
export function refreshBuiltinDeposits(registry) {
  for (const t of registry.tools) {
    if (typeof t.coldDeposit !== "function") continue;
    try {
      const usd = t.coldDeposit({ catalogs: registry.catalogs });
      if (Number.isFinite(usd) && usd > 0) t.x402 = { ...(t.x402 || {}), usd };
    } catch { /* keep the deposit pinned when the tool was built */ }
  }
}

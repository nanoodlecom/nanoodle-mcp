// VENDORED from `nanoodle` (nanoodle-js src/estimate.mjs, exported as
// estimateGraphCost/graphModelKinds from v0.7.0). Kept as a local copy so this
// paid server is self-contained and can ship ahead of an npm release of the
// library — the box deploys via `npm ci`, which can't resolve an unpublished
// dep. Once package.json pins nanoodle >= 0.7.0, delete this file and import
// { estimateGraphCost, graphModelKinds } from "nanoodle" instead. Keep the two
// copies in sync; nanoodle-js's offline test suite is the canonical coverage.
//
// Up-front run-cost estimate for a graph — a USD forecast computed from the
// public NanoGPT catalog BEFORE anything runs. Pure: it never fetches. The
// caller supplies the raw catalog arrays (the same ones the /api/v1/*-models
// endpoints return); this module walks the graph's billable nodes, prices each
// against its chosen model, and sums.
//
// This is the twin of the editor/play "~$X to run" chip (index.html /
// play.html): the resolver math is ported node-for-node so a hosted server and
// the app forecast the same number. Image is exact; chat/video/audio are
// estimates (marked `exact:false`) because their true cost depends on how many
// tokens/seconds the run actually produces. `unpriced` counts billable nodes we
// could not price (model missing from the catalog, or a pricing shape we don't
// recognise) — a nonzero count means the sum is a LOWER bound.
//
// Cost is only ever KNOWN after a run (the API reports it); this is the forecast
// that lets a paid server quote a deposit that actually covers the call on the
// very first request, instead of a flat guess.

const REF_PORT_RE = /^ref\d+$/; // tvideo reference-image ports — mirrors nanoodle's graph.mjs

// node type → pricing "kind" == which catalog it's priced from + which unit fn.
// Mirrors the app's SETTING_MODEL_KIND. This set is exactly the billable
// (network) node types; a type absent here is a free local node and costs $0.
const PRICE_KIND = {
  llm: "chat", vision: "chat", draw: "chat",
  image: "image", edit: "image", inpaint: "image",
  tvideo: "video", ivideo: "video", vedit: "video", lipsync: "video",
  music: "audio", remix: "audio", tts: "audio", transcribe: "audio",
};

// Fallback assumptions when a run's real quantity isn't knowable up front.
const EST = { llmInTokens: 1000, llmOutTokens: 500, ttsChars: 600, audioSeconds: 30, sttMinutes: 1, videoFps: 30 };

const _num = (x) => (x != null && isFinite(+x)) ? +x : null;

function pickByRes(map, reqRes, defRes) {
  if (!map || typeof map !== "object") return null;
  if (reqRes != null && _num(map[reqRes]) != null) return _num(map[reqRes]);
  if (defRes != null && _num(map[defRes]) != null) return _num(map[defRes]);
  const vals = Object.values(map).map(_num).filter((v) => v != null);
  return vals.length ? vals[0] : null;
}
function pickObjByRes(map, reqRes, defRes) {
  if (!map || typeof map !== "object") return null;
  if (reqRes != null && map[reqRes] && typeof map[reqRes] === "object") return map[reqRes];
  if (defRes != null && map[defRes] && typeof map[defRes] === "object") return map[defRes];
  const objs = Object.values(map).filter((v) => v && typeof v === "object");
  return objs.length ? objs[0] : null;
}
function pickDur(p, raw, fields) {
  const f = parseFloat(fields && fields.duration);
  if (isFinite(f) && f > 0) return f;
  const d = _num(p.default_duration) ?? _num(raw.defaultDuration);
  if (d != null && d > 0) return d;
  if (p.per_duration) { const k = Object.keys(p.per_duration)[0]; if (k && isFinite(+k)) return +k; }
  if (Array.isArray(p.supported_durations) && p.supported_durations.length) return +p.supported_durations[0];
  if (p.fixed_duration_seconds != null) return _num(p.fixed_duration_seconds) || 5;
  return 5;
}

// A video run bills a HIGHER tier when reference images are wired or the model's
// audio switch is on. refWired comes from the graph wiring; the audio switch /
// reference mode ride in fields.modelOpts.
function videoUnitUsd(pricing, fields, refWired) {
  const p = pricing || {};
  const f = fields || {};
  const opts = (f.modelOpts && typeof f.modelOpts === "object") ? f.modelOpts : {};
  let audioOn = false;
  for (const k in opts) { if (/audio/i.test(k) && !/^(no|disable|without|mute)/i.test(k)) { const val = opts[k]; if (val === true || val === "true" || val === 1 || val === "1" || val === "on" || val === "yes") { audioOn = true; break; } } }
  const refOn = !!refWired || /reference/i.test(String(opts.mode || ""));
  const usd = videoBaseUsd(p, f, audioOn, refOn);
  if (usd != null && isFinite(usd) && audioOn && p.audio_multiplier != null) return usd * (_num(p.audio_multiplier) ?? 1);
  return usd;
}
function videoBaseUsd(pricing, fields, audioOn, refOn) {
  const p = pricing || {}, raw = (p.raw && typeof p.raw === "object") ? p.raw : {};
  const f = fields || {};
  const res = f.resolution, defRes = p.default_resolution ?? raw.defaultResolution;
  const dur = pickDur(p, raw, f);
  const rp = (m) => pickByRes(m, res, defRes);
  let v;
  if ((v = rp(p.per_second_by_resolution)) != null) return v * dur;
  if ((v = rp(p.standard_prices_per_second)) != null) return v * dur;
  if (p.per_second_by_mode) {
    const mm = p.per_second_by_mode;
    v = refOn ? (_num(mm.reference_to_video_image) ?? _num(mm.reference_to_video_video)) : null;
    if (v == null) v = _num(mm.text_to_video) ?? pickByRes(mm);
    if (v != null) return v * dur;
  }
  if (audioOn) {
    for (const k of ["text_image_with_audio_per_second", "image_to_video_with_audio_per_second", "text_to_video_with_audio_per_second"]) {
      if (p[k] != null) { v = (typeof p[k] === "object") ? rp(p[k]) : _num(p[k]); if (v != null) return v * dur; }
    }
  }
  for (const k of ["text_to_video_per_second", "text_image_without_audio_per_second", "image_to_video_without_audio_per_second"]) {
    if (p[k] != null) { v = (typeof p[k] === "object") ? rp(p[k]) : _num(p[k]); if (v != null) return v * dur; }
  }
  if (p.base_price_per_second != null) { const m = p.resolution_multipliers ? (rp(p.resolution_multipliers) ?? 1) : 1; v = _num(p.base_price_per_second); if (v != null) return v * dur * m; }
  if (p.per_second != null) { v = _num(p.per_second); if (v != null) return v * dur; }
  if (p.per_duration) { const dk = String(Math.round(dur)); v = _num(p.per_duration[dk]) ?? _num(p.per_duration[String(dur)]) ?? pickByRes(p.per_duration); if (v != null) return v; }
  if (p.without_audio != null || p.with_audio != null) { v = audioOn ? (_num(p.with_audio) ?? _num(p.without_audio)) : (_num(p.without_audio) ?? _num(p.with_audio)); if (v != null) return v; }
  if (p.base_prices_by_resolution) {
    const dk = String(Math.round(dur));
    if (p.duration_overrides && p.duration_overrides[dk]) { v = rp(p.duration_overrides[dk]); if (v != null) return v; }
    const base = rp(p.base_prices_by_resolution);
    let mult = 1;
    if (p.duration_multiplier != null) mult = _num(p.duration_multiplier) ?? 1;
    else if (p.duration_multipliers) mult = _num(p.duration_multipliers[dk]) ?? pickByRes(p.duration_multipliers) ?? 1;
    if (base != null) return base * mult;
  }
  if ((v = rp(p.per_resolution)) != null) return v;
  if (p.base_price != null && p.per_extra_second != null) { const bd = _num(p.base_duration) || 0; return _num(p.base_price) + Math.max(0, dur - bd) * _num(p.per_extra_second); }
  if (p.per_video != null) { v = _num(p.per_video); if (v != null) return v; }
  if (p.per_target_megapixel_second != null) { const mp = _num(p.default_target_megapixels) || 1; v = _num(p.per_target_megapixel_second) * mp * dur; return Math.max(v, _num(p.minimum_price) || 0); }
  if (p.per_frame_unit != null) { const fpu = _num(p.frames_per_unit) || 1; return (dur * EST.videoFps / fpu) * _num(p.per_frame_unit); }
  if (p.base_price != null) { v = _num(p.base_price); if (v != null) return v; }
  if (Object.keys(raw).length) {
    if (refOn) {
      if (raw.referenceToVideoPrices) { const inner = pickObjByRes(raw.referenceToVideoPrices, res, defRes); if (inner) { const dk = String(Math.round(dur)); v = _num(inner[dk]) ?? pickByRes(inner); if (v != null) return v; } }
      for (const k of ["textToVideoWithReferenceVideoPricesPerSecond", "standardTextToVideoWithReferenceVideoPricesPerSecond", "turboTextToVideoWithReferenceVideoPricesPerSecond",
        "standardReferenceVideoPricesPerSecond", "fastReferenceVideoPricesPerSecond"]) {
        if (raw[k]) { v = pickByRes(raw[k], res, defRes); if (v != null) return v * dur; }
      }
    }
    if (audioOn) {
      if (raw.withAudioPricesPerSecond) { v = pickByRes(raw.withAudioPricesPerSecond, res, defRes); if (v != null) return v * dur; }
      if (raw.withAudioPrices) { const inner = pickObjByRes(raw.withAudioPrices, res, defRes); if (inner) { const dk = String(Math.round(dur)); v = _num(inner[dk]) ?? pickByRes(inner); if (v != null) return v; } }
    }
    for (const k of ["pricesPerSecond", "textToVideoPricesPerSecond", "withoutAudioPricesPerSecond",
      "standardPricesPerSecond", "standardTextToVideoPricesPerSecond", "outputPricesPerSecond", "fastPricesPerSecond"]) {
      if (raw[k]) { v = pickByRes(raw[k], res, defRes); if (v != null) return v * dur; }
    }
    for (const k of ["withoutAudioPrices", "withAudioPrices", "referenceToVideoPrices"]) {
      if (raw[k]) { const inner = pickObjByRes(raw[k], res, defRes); if (inner) { const dk = String(Math.round(dur)); v = _num(inner[dk]) ?? pickByRes(inner); if (v != null) return v; } }
    }
    if (raw.pricePerMegapixel != null && raw.megapixelsByResolution) {
      const mp = _num(raw.megapixelsByResolution[res]) ?? _num(raw.megapixelsByResolution[defRes]) ?? pickByRes(raw.megapixelsByResolution);
      const nf = _num(raw.defaultNumFrames) || (dur * (_num(raw.defaultFramesPerSecond) || 24));
      if (mp != null) return _num(raw.pricePerMegapixel) * mp * nf;
    }
  }
  return genericScanUsd(p, dur);
}
// Last resort so a never-seen pricing shape estimates SOMETHING rather than
// blanking: the smallest per-second number scaled by duration, else the
// smallest flat number.
function genericScanUsd(p, dur) {
  let perSec = null, flat = null;
  (function walk(o, key) {
    if (o == null) return;
    if (typeof o === "number") { if (o > 0 && o < 500) { if (/second|persec/i.test(key)) perSec = Math.min(perSec ?? Infinity, o); else flat = Math.min(flat ?? Infinity, o); } return; }
    if (typeof o === "object") for (const k of Object.keys(o)) walk(o[k], k);
  })(p, "");
  if (perSec != null) return perSec * dur;
  if (flat != null) return flat;
  return null;
}
function chatUnitUsd(pricing, inTok, outTok) {
  if (!pricing) return null;
  const pin = _num(pricing.prompt), pout = _num(pricing.completion);   // $ per 1M tokens
  if (pin == null && pout == null) return null;                        // omni "varies_by_modality" → unknown
  return ((pin || 0) * (inTok ?? EST.llmInTokens) + (pout || 0) * (outTok ?? EST.llmOutTokens)) / 1e6;
}
function audioUnitUsd(pricing, chars, seconds) {
  const p = pricing || {}, c = chars ?? EST.ttsChars;
  const secs = (seconds != null && isFinite(seconds)) ? seconds : EST.audioSeconds;
  if (p.per_thousand_chars != null) { let cost = _num(p.per_thousand_chars) * (c / 1000); if (p.per_generation != null) cost += _num(p.per_generation); return Math.max(cost, _num(p.minimum) || 0); }
  if (p.per_prompt_char_block != null) { const bs = _num(p.prompt_char_block_size) || 1; return Math.max(Math.ceil(c / bs) * _num(p.per_prompt_char_block), _num(p.minimum) || 0); }
  if (p.per_generation != null) return _num(p.per_generation);
  if (p.per_second != null) return Math.max(_num(p.per_second) * secs, _num(p.minimum) || 0);
  if (p.per_minute != null) return _num(p.per_minute) * EST.sttMinutes;
  return null;
}
// Seconds a per_second audio model is billed for: the node's duration clamped to
// the model's advertised min/max_duration. null → audioUnitUsd uses EST.audioSeconds.
function audioBilledSeconds(sp, fields) {
  const p = sp || {};
  if (p.min_duration == null || p.max_duration == null) return null;
  const d = parseFloat(fields && fields.duration);
  if (!isFinite(d)) return null;
  const lo = _num(p.min_duration), hi = _num(p.max_duration);
  return Math.min(hi != null ? hi : d, Math.max(lo != null ? lo : d, d));
}
function imageUsd(pricing, size, count) {
  const per = (pricing && pricing.per_image) || {};
  const v = per[size] ?? per.square ?? per.square_hd ?? Object.values(per)[0];
  return (v != null && isFinite(+v)) ? +v * (count || 1) : null;
}

/** Which pricing kinds a graph touches — so a caller fetches only the catalogs it needs. */
export function graphModelKinds(graph) {
  const kinds = new Set();
  for (const n of (graph && graph.nodes) || []) { const k = PRICE_KIND[n.type]; if (k) kinds.add(k); }
  return kinds;
}

// One node's USD/run from its chosen model + settings. `catItem` is the raw
// catalog entry for node.fields.model (null → unpriceable). `graph` is needed
// only to detect wired reference-image ports (video ref tier).
function nodeUnitUsd(node, catItem, graph) {
  const kind = PRICE_KIND[node.type]; if (!kind) return null;
  const id = node.fields && node.fields.model; if (!id) return null;
  const m = catItem; if (!m) return null;
  const pricing = m.pricing, f = node.fields || {};
  if (kind === "image") {
    const sp = m.supported_parameters || {}, maxOut = sp.max_output_images || 1, fixed = sp.fixed_image_count || 0;
    const count = fixed > 0 ? fixed : Math.min(maxOut, Math.max(1, parseInt(f.variations, 10) || 1));
    return imageUsd(pricing, f.size, count);
  }
  if (kind === "video") {
    const sp = m.supported_parameters || {}, pp = sp.parameters || sp;
    const modelHasRefs = ["reference_images", "reference_image_urls", "referenceImages"].some((k) => k in pp);
    const refWired = !!(modelHasRefs && graph && Array.isArray(graph.links) &&
      graph.links.some((l) => l.to && l.to.node === node.id && REF_PORT_RE.test(l.to.port)));
    const u = videoUnitUsd(pricing, f, refWired);
    return (u != null && isFinite(u)) ? u : null;
  }
  if (kind === "chat") {
    const inTok = Math.max(200, Math.round(((f.system || "").length + (f.prompt || "").length) / 4) + 200);
    const outTok = f.maxTokens ? +f.maxTokens : EST.llmOutTokens;
    return chatUnitUsd(pricing, inTok, outTok);
  }
  if (kind === "audio") {
    const chars = node.type === "transcribe" ? undefined : ((f.prompt || "").length || EST.ttsChars);
    const secs = audioBilledSeconds(m.supported_parameters, f);
    const u = audioUnitUsd(pricing, chars, secs);
    return (u != null && isFinite(u)) ? u : null;   // one track — the sent song count is clamped to 1 at run
  }
  return null;
}

/**
 * Forecast a graph's per-run cost from the public catalog.
 *
 * @param {{nodes:Array, links?:Array}} graph  a materialized graph (Workflow#graph)
 * @param {{chat?:Array, image?:Array, video?:Array, audio?:Array}} catalogs
 *        raw catalog arrays (as /api/v1/*-models return them, `.data`), indexed here by model id
 * @returns {{usd:number, exact:boolean, priced:number, unpriced:number}}
 *          usd = sum over priced billable nodes; exact = every priced node was image
 *          (deterministic); priced/unpriced = billable node counts. unpriced>0 ⇒ usd is a lower bound.
 */
export function estimateGraphCost(graph, catalogs = {}) {
  const nodes = (graph && Array.isArray(graph.nodes)) ? graph.nodes : [];
  const byKind = {};
  for (const kind of ["chat", "image", "video", "audio"]) {
    const arr = Array.isArray(catalogs[kind]) ? catalogs[kind] : [];
    const map = new Map();
    for (const m of arr) if (m && m.id != null) map.set(String(m.id), m);
    byKind[kind] = map;
  }
  let usd = 0, priced = 0, unpriced = 0, exact = true;
  for (const n of nodes) {
    const kind = PRICE_KIND[n.type]; if (!kind) continue;   // free/local node
    const id = n.fields && n.fields.model;
    const m = id != null ? byKind[kind].get(String(id)) : null;
    const u = m ? nodeUnitUsd(n, m, graph) : null;
    if (u == null || !isFinite(u)) { unpriced++; continue; }
    usd += u; priced++;
    if (kind !== "image") exact = false;
  }
  return { usd, exact, priced, unpriced };
}

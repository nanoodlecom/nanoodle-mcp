/**
 * Startup guard for local-media tools.
 *
 * Some node types (resize/vframes/combine/soundtrack/trim/extractaudio) try a
 * pure-JS path first but fall back to `ffmpeg`/`ffprobe` on PATH for formats the
 * pure path can't handle — JPEG/WebP resize, video frame extraction, compressed
 * audio, mismatched-resolution combine. On a server without ffmpeg those runs
 * fail mid-execution (and, in charge mode, auto-refund). That's a confusing
 * per-call surprise; this turns it into a loud, one-time deploy-time signal that
 * names exactly which tools will degrade.
 *
 * The executor shells out with bare names (`spawn("ffprobe", …)`), so a faithful
 * check is a PATH scan for an executable of that name — no process is spawned.
 */
import { access, constants } from "node:fs/promises";
import { join, delimiter } from "node:path";

/**
 * Node types whose runner can fall back to ffmpeg/ffprobe. Kept in sync with
 * nanoodle-js src/nodes.mjs handlers that call into local-media.mjs.
 */
export const LOCAL_MEDIA_TYPES = new Set([
  "resize",       // JPEG/WebP/other (PNG is pure-JS)
  "vframes",      // always — no pure video decoder
  "combine",      // mismatched streams (matching streams remux pure via MP4CAT)
  "soundtrack",   // non-PCM/compressed audio
  "trim",         // non-PCM/compressed audio
  "extractaudio", // always — pulls an audio track out of video
]);

/** True if `name` resolves to an executable somewhere on PATH (mirrors spawn's lookup). */
async function onPath(name) {
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  for (const dir of dirs) {
    try {
      await access(join(dir, name), constants.X_OK);
      return true;
    } catch { /* keep scanning */ }
  }
  return false;
}

/** Resolve which of ffprobe/ffmpeg are present. */
export async function detectFfmpeg() {
  const [ffprobe, ffmpeg] = await Promise.all([onPath("ffprobe"), onPath("ffmpeg")]);
  return { ffprobe, ffmpeg, ok: ffprobe && ffmpeg };
}

const DECIDE_IMG_PORT = /^img\d+$/;

/**
 * A Decide node that receives images always downsizes them through ffprobe and
 * ffmpeg (fitImageJpeg) before the decision call. Text-only Decide does not.
 */
function decideSeesImages(graph, node) {
  if (!node || node.type !== "decide") return false;
  return (graph.links || []).some((l) => l.to && l.to.node === node.id && DECIDE_IMG_PORT.test(l.to.port));
}

function graphNeedsFfmpeg(graph) {
  if (!graph) return false;
  const nodes = graph.nodes || [];
  if (nodes.some((n) => LOCAL_MEDIA_TYPES.has(n.type))) return true;
  return nodes.some((n) => decideSeesImages(graph, n));
}

/** Names of tools whose graph needs ffprobe/ffmpeg (local-media, or Decide with images). */
export function toolsNeedingFfmpeg(tools) {
  const names = [];
  for (const t of tools) {
    if (graphNeedsFfmpeg(t?.wf?.graph)) names.push(t.name);
  }
  return names;
}

/**
 * Emit a startup warning if local-media tools are loaded but ffmpeg/ffprobe is
 * missing. Returns the list of at-risk tool names (empty if all clear).
 * `log` defaults to stderr so it rides the server's existing "nanoodle-mcp: …"
 * boot log without touching stdio the MCP transport uses.
 */
export async function warnIfFfmpegMissing(tools, log = (m) => console.error(m)) {
  const at = toolsNeedingFfmpeg(tools);
  if (!at.length) return [];
  const { ffprobe, ffmpeg } = await detectFfmpeg();
  if (ffprobe && ffmpeg) return [];
  const missing = [!ffprobe && "ffprobe", !ffmpeg && "ffmpeg"].filter(Boolean).join(" and ");
  log(
    `nanoodle-mcp: warning — ${missing} not on PATH. ${at.length} tool(s) need ffmpeg ` +
    `(local-media nodes, or a Decide node that judges images) and will fail without it: ` +
    `${at.join(", ")}. Install ffmpeg (e.g. \`apt install ffmpeg\`) to enable them; pure ` +
    `image/LLM/vision tools and text-only Decide are unaffected.`
  );
  return at;
}

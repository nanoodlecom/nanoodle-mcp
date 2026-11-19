// A short initialization grace, never a substitute for the full readiness check.
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { createProbeFetch } from "./probe-http.mjs";

function appStart() {
  const text = execFileSync("/usr/bin/systemctl", ["show", "--timestamp=unix", "nanoodle-mcp.service",
    "-p", "ActiveState", "-p", "MainPID", "-p", "ExecMainStartTimestamp"],
  { encoding: "utf8", timeout: 3000, env: { PATH: "/usr/bin:/bin", LC_ALL: "C", TZ: "UTC" } });
  return Object.fromEntries(text.trim().split("\n").map(line => {
    const at = line.indexOf("="); return [line.slice(0, at), line.slice(at + 1)];
  }));
}

export async function waitForRecentAppStart({ site, nanoSite, readStart = appStart,
  now = Date.now, monotonic = () => performance.now(), delay = sleep, fetch = globalThis.fetch,
  graceMs = 45_000 } = {}) {
  let state;
  try { state = readStart(); } catch { return { attempts: 0, ready: false }; }
  const stamp = /^@(\d+(?:\.\d+)?)$/.exec(state.ExecMainStartTimestamp || "");
  const age = stamp ? now() - Number(stamp[1]) * 1000 : NaN;
  // Missing/dead/old service observations go straight to the normal check.
  if (state.ActiveState !== "active" || !(Number(state.MainPID) > 0)
    || !Number.isFinite(age) || age < 0 || age >= 60_000) return { attempts: 0, ready: false };
  const deadline = monotonic() + Math.min(graceMs, 60_000 - age);
  const request = createProbeFetch({ fetch, timeoutMs: 2000, maxBytes: 64 * 1024 });
  let attempts = 0;
  do {
    const left = deadline - monotonic();
    if (left <= 0) break;
    attempts++;
    const signal = AbortSignal.timeout(Math.max(1, Math.ceil(left)));
    const probes = await Promise.allSettled([
      (async () => { const r = await request(nanoSite + "/rates", { signal }); return r.ok; })(),
      (async () => {
        const r = await request(site + "/near/health", { signal });
        if (!r.ok) return false;
        const h = await r.json();
        return h.active === true && h.watcher?.listening === true && h.funding?.enforced === true && h.funding.ok === true;
      })(),
    ]);
    if (probes.every(p => p.status === "fulfilled" && p.value === true)) return { attempts, ready: true };
    const remaining = deadline - monotonic();
    if (remaining <= 0) break;
    await delay(Math.min(500, remaining));
  } while (monotonic() < deadline);
  // The caller still runs every real probe and alerts if the failure persists.
  return { attempts, ready: false };
}

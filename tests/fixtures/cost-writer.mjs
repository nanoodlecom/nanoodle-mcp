import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { loadTools } from "../../src/tools.mjs";

const [dir, outDir, mode] = process.argv.slice(2);
const costsPath = join(outDir, "costs.json");
const released = Promise.withResolvers();
const pause = () => { process.send({ event: "paused" }); return released.promise; };
if (mode === "before-lock") {
  const mkdir = fs.mkdir;
  fs.mkdir = async (path, options) => {
    if (path === outDir) await pause();
    return mkdir(path, options);
  };
} else if (mode === "before-rename") {
  const rename = fs.rename;
  fs.rename = async (from, to) => {
    if (to === costsPath) await pause();
    return rename(from, to);
  };
} else if (mode === "report-busy") {
  const { DatabaseSync } = await import("node:sqlite");
  const exec = DatabaseSync.prototype.exec;
  let reported = false;
  DatabaseSync.prototype.exec = function (sql) {
    try { return exec.call(this, sql); }
    catch (error) {
      if (!reported && sql === "BEGIN IMMEDIATE" && error.errcode === 5) {
        reported = true;
        process.send({ event: "busy" });
      }
      throw error;
    }
  };
}
syncBuiltinESMExports();

const registry = await loadTools({ dirs: [dir], outDir });
process.on("message", async ({ name, usd, exact, release }) => {
  if (release) { released.resolve(); return; }
  const tool = registry.tools.find(tool => tool.name === name);
  tool.wf.run = async () => ({ costUsd: usd, costExact: exact, outputs: {}, nodes: {} });
  await registry.callTool({ name, arguments: {} });
  process.send({ event: "done", costs: registry.costs, description: tool.description });
});
process.send({ event: "ready" });

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { stopServerChild } from "../scripts/near-simulate.mjs";

test("test-server cleanup resolves after a child already exited", { timeout: 3_000 }, async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await once(child, "exit");
  assert.equal(child.exitCode, 0);
  await stopServerChild(child);
  await stopServerChild(child);
});

test("test-server cleanup handles a running child and repeated shutdown", { timeout: 3_000 }, async () => {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  await stopServerChild(child);
  assert.equal(child.signalCode, "SIGKILL");
  await stopServerChild(child);
});

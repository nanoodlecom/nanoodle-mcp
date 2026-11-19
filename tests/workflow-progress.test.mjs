import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkflowProgress, layoutWorkflow } from "../src/workflow-progress.mjs";
import { displayAmount } from "../src/workflow-view.mjs";

const graph = { nodes: [
  { id: "idea", type: "text", name: "Idea", fields: { text: "PRIVATE INPUT" } },
  { id: "a", type: "image", name: "Reference A" }, { id: "b", type: "image", name: "Reference B" },
  { id: "join", type: "image", name: "Combine" }, { id: "note", type: "comment" },
], links: [["idea", "a"], ["idea", "b"], ["a", "join"], ["b", "join"]]
  .map(([from, to]) => ({ from: { node: from, port: "image" }, to: { node: to, port: "image" } })) };

test("one execution snapshot supports arbitrary branches/joins and excludes payloads", () => {
  let clock = 1000; const snapshots = [];
  const progress = createWorkflowProgress(graph, { publish: s => snapshots.push(s), now: () => clock++ });
  progress.event({ type: "node-start", nodeId: "idea" });
  progress.event({ type: "node-done", nodeId: "idea", ms: 3, output: "PRIVATE OUTPUT" });
  progress.event({ type: "node-start", nodeId: "a" }); progress.event({ type: "node-start", nodeId: "b" });
  progress.event({ type: "poll", nodeId: "a", status: "queued", queuePosition: 2, runId: "PRIVATE JOB" });
  progress.event({ type: "poll", nodeId: "b", status: "PRIVATE RESPONSE" });
  const running = progress.snapshot();
  assert.deepEqual(running.nodes.filter(n => n.status === "running").map(n => n.id), ["a", "b"]);
  assert.equal(running.nodes.find(n => n.id === "a").queuePosition, 2);
  assert.equal(running.nodes.find(n => n.id === "b").detail, "working");
  assert.equal(snapshots[0].nodes[0].status, "pending", "published snapshots cannot change retroactively");
  const layout = layoutWorkflow(running), nodes = new Map(layout.nodes.map(n => [n.id, n]));
  assert.equal(nodes.get("a").y, nodes.get("b").y);
  assert.notEqual(nodes.get("a").x, nodes.get("b").x);
  assert.ok(nodes.get("join").y > nodes.get("a").y);
  assert.equal(layout.nodes.length, 4, "comments are not executable steps");
  assert.doesNotMatch(JSON.stringify(snapshots), /PRIVATE|fields|runId|output/);
  const final = progress.finish({ nodes: { idea: { status: "done" }, a: { status: "gated" }, b: { status: "done" }, join: { status: "skipped" } } });
  assert.equal(final.status, "succeeded", "a closed gate is a successful decision, not a failure");
  assert.equal(final.nodes.find(n => n.id === "join").status, "skipped");
  progress.event({ type: "node-start", nodeId: "join" });
  assert.deepEqual(progress.snapshot(), final, "late callbacks cannot reopen terminal nodes");
});

test("execution failures settle unfinished nodes and observer failures never kill execution", () => {
  const p = createWorkflowProgress(graph, { publish() { throw Error("UI disconnected"); } });
  p.event({ type: "node-start", nodeId: "a" });
  p.event({ type: "node-error", nodeId: "a", error: "PRIVATE ERROR" });
  const result = p.finish(null, Error("PRIVATE ERROR"));
  assert.equal(result.status, "failed"); assert.ok(result.nodes.every(n => n.status === "error"));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE ERROR/);
});

test("receipt display rounds for reading without changing exact payment values", () => {
  const exact = "0.076987623931623931623932";
  assert.equal(displayAmount(exact), "≈ 0.076988");
  assert.equal(displayAmount("0.080532376068376068376068"), "≈ 0.080532");
  assert.equal(displayAmount("0.080595"), "0.080595");
  assert.equal(displayAmount("0.9999999"), "≈ 1");
  assert.equal(displayAmount("0.000000000001"), "<0.000001");
  assert.equal(exact, "0.076987623931623931623932");
});

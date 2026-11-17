import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../assets/creator-site.js", import.meta.url), "utf8");
const comment = text => ({ id: "comment", type: "comment", fields: { text } });
const graph = (text = "First description", extra = {}) => ({
  nodes: [comment(text), { id: "input", type: "text", name: "Idea", fields: { text: "" } }], links: [], ...extra,
});
function page(initial = {}) {
  const events = new Map(), elements = new Map(), requests = [];
  const make = () => ({ value: "", textContent: "", files: [], children: [], hidden: true,
    reportValidity: () => true, append(n) { this.children.push(n); }, replaceChildren() { this.children = []; },
    addEventListener(type, fn) { events.set(`${this.id}:${type}`, fn); } });
  for (const id of ["creator-form", "creator-file", "creator-graph", "creator-name", "creator-description", "creator-inputs", "creator-error", "creator-preview", "creator-check", "creator-host"]) elements.set(id, { ...make(), id });
  elements.get("creator-name").maxLength = 80; elements.get("creator-description").maxLength = 2000;
  for (const [id, value] of Object.entries(initial)) elements.get(id).value = value;
  vm.runInNewContext(source, {
    document: { getElementById: id => elements.get(id), createElement: make },
    fetch: async (path, init) => { requests.push({ path, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ schema: { properties: { Idea: {} } }, estimatedCostUsd: 0, author: "test" }) }; },
  });
  const input = (id, value) => { elements.get(id).value = value; events.get(`${id}:input`)?.(); };
  return { elements, requests, input,
    values: () => [elements.get("creator-name").value, elements.get("creator-description").value],
    paste: value => input("creator-graph", typeof value === "string" ? value : JSON.stringify(value)),
    file(file) { elements.get("creator-file").files = file ? [file] : []; return events.get("creator-file:change")(); },
    async check() { events.get("creator-check:click")(); await new Promise(resolve => setImmediate(resolve)); },
  };
}
const file = (name, value, extra = {}) => ({ name, size: 100, text: async () => typeof value === "string" ? value : JSON.stringify(value), ...extra });
const pending = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test("file defaults use base filename and the first meaningful native comment in saved order", async () => {
  const p = page(), g = graph("  \n ");
  g.nodes.splice(1, 0, { ...comment(42), id: "number" }, { ...comment("  First\nmeaningful comment  "), id: "first", x: 500 }, { ...comment("Later comment"), id: "later", x: 0 });
  g.name = "Embedded name must not override the filename";
  await p.file(file("C:\\fakepath\\My workflow.noodle-graph.JSON", g));
  assert.deepEqual(p.values(), ["My workflow", "First\nmeaningful comment"]);
  await p.file(file("other.name.json", graph("Replacement")));
  assert.deepEqual(p.values(), ["other.name", "Replacement"]);
  await p.check();
  assert.equal(p.requests.length, 1);
  assert.equal(p.requests[0].body.name, "other.name"); assert.equal(p.requests[0].body.description, "Replacement");
  assert.equal(p.requests[0].body.inputName, undefined);
});

test("manual values and intentionally cleared fields survive file replacement and pasted graphs", async () => {
  for (const values of [["Manual name", "Manual description"], ["", ""]]) {
    const p = page(); await p.file(file("first.json", graph()));
    p.input("creator-name", values[0]); p.input("creator-description", values[1]);
    await p.file(file("second.json", graph("New default")));
    p.paste(graph("Pasted default", { name: "Embedded name" }));
    assert.deepEqual(p.values(), values);
    p.paste(""); assert.deepEqual(p.values(), values);
  }
});

test("editing one metadata field leaves the other automatic; prefilled/autofilled values are retained", async () => {
  const p = page(); await p.file(file("first.json", graph()));
  p.input("creator-name", "My title");
  await p.file(file("second.json", graph("New comment")));
  assert.deepEqual(p.values(), ["My title", "New comment"]);
  const restored = page({ "creator-name": "Restored name", "creator-description": "Restored description" });
  restored.paste(graph()); assert.deepEqual(restored.values(), ["Restored name", "Restored description"]);
  const autofilled = page(); autofilled.elements.get("creator-description").value = "Autofilled";
  autofilled.paste(graph()); assert.deepEqual(autofilled.values(), ["", "Autofilled"]);
});

test("paste drops any old automatic filename, uses only explicit graph name and comment, and clears stale defaults", async () => {
  const p = page(); await p.file(file("old.json", graph("Old description")));
  p.paste(graph("Paste comment")); assert.deepEqual(p.values(), ["", "Paste comment"]);
  p.paste(graph("", { name: "Explicit graph name" })); assert.deepEqual(p.values(), ["Explicit graph name", ""]);
  p.paste(""); assert.deepEqual(p.values(), ["", ""]);
  p.paste(graph("Again")); p.paste("broken JSON");
  assert.deepEqual(p.values(), ["", ""]); assert.match(p.elements.get("creator-error").textContent, /not valid JSON/);
});

test("blank and unsupported files do not populate metadata; comment-only native saves use their actual comment", async () => {
  const p = page();
  for (const g of ["", "   ", {}, { nodes: [], links: [] }, { last_node_id: 1, nodes: [], links: [] },
    { nodes: [{ id: "bad", type: "UnknownPluginNode", fields: {} }], links: [] }]) {
    await p.file(file("wrong.json", g)); assert.deepEqual(p.values(), ["", ""]);
  }
  await p.file(file("notes.json", { nodes: [comment("Only a native comment")], links: [] }));
  assert.deepEqual(p.values(), ["notes", "Only a native comment"]);
  p.paste({ nodes: [comment(" \n ")], links: [] }); assert.deepEqual(p.values(), ["", ""]);
  await p.file(null); assert.deepEqual(p.values(), ["", ""]);
  await p.file(file("huge.json", graph(), { size: 256 * 1024 + 1 }));
  assert.deepEqual(p.values(), ["", ""]); assert.match(p.elements.get("creator-error").textContent, /256 KiB/);
});

test("latest file selection wins even when earlier reads resolve or fail later", async () => {
  const p = page(), slow = pending(), fast = pending();
  const first = p.file(file("slow.json", null, { text: () => slow.promise }));
  const second = p.file(file("fast.json", null, { text: () => fast.promise }));
  fast.resolve(JSON.stringify(graph("Newest"))); await second;
  slow.resolve(JSON.stringify(graph("Stale"))); await first;
  assert.deepEqual(p.values(), ["fast", "Newest"]);
  assert.equal(JSON.parse(p.elements.get("creator-graph").value).nodes[0].fields.text, "Newest");
  const rejected = pending(), old = p.file(file("failed.json", null, { text: () => rejected.promise }));
  await p.file(file("last.json", graph("Last"))); rejected.reject(new Error("read failed")); await old;
  assert.deepEqual(p.values(), ["last", "Last"]); assert.equal(p.elements.get("creator-error").textContent, "");
});

test("paste, blanking the graph and file deselection cancel pending reads; edits during reads survive", async () => {
  for (const replacement of [graph("Pasted"), ""]) {
    const p = page(), slow = pending(), loading = p.file(file("stale.json", null, { text: () => slow.promise }));
    p.paste(replacement); slow.resolve(JSON.stringify(graph("Stale"))); await loading;
    assert.deepEqual(p.values(), ["", replacement ? "Pasted" : ""]);
  }
  const p = page(), slow = pending(), loading = p.file(file("stale.json", null, { text: () => slow.promise }));
  await p.file(null); slow.resolve(JSON.stringify(graph())); await loading; assert.deepEqual(p.values(), ["", ""]);
  const edited = page(), pendingRead = pending(), read = edited.file(file("new.json", null, { text: () => pendingRead.promise }));
  edited.input("creator-name", "Typed while loading"); edited.input("creator-description", "");
  pendingRead.resolve(JSON.stringify(graph())); await read; assert.deepEqual(edited.values(), ["Typed while loading", ""]);
  await edited.file(file("failed.json", null, { text: async () => { throw new Error("fail"); } }));
  assert.match(edited.elements.get("creator-error").textContent, /Could not read/);
});

test("untrusted metadata remains literal text and automatic defaults respect editable field limits", async () => {
  const p = page(), attack = '<img src=x onerror="alert(1)">';
  await p.file(file(attack + ".json", graph(attack)));
  assert.deepEqual(p.values(), [attack, attack]);
  assert.equal(p.elements.get("creator-name").children.length, 0); assert.equal(p.elements.get("creator-description").children.length, 0);
  await p.file(file("a".repeat(79) + "😀.json", graph("b".repeat(1999) + "😀")));
  assert.equal(p.values()[0], "a".repeat(79)); assert.equal(p.values()[1], "b".repeat(1999));
});

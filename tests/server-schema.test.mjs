/**
 * server.json against the REAL MCP Registry schema — offline, vendored copy.
 *
 * The schema is fetched verbatim from
 *   https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json
 * and vendored at tests/fixtures/mcp-server.schema.json (22,090 bytes,
 * $id "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
 * fetched 2026-11-19). Vendoring keeps `npm test` offline like the rest of the
 * suite; the drift guard below fails if server.json's $schema URL ever stops
 * matching the vendored copy's $id, which is the cue to re-fetch.
 *
 * The validator is a deliberately small draft-07 subset — only the keywords
 * this schema actually uses ($ref, type, required, properties,
 * additionalProperties, pattern, format:"uri", enum, minLength, maxLength,
 * allOf, anyOf, items). It is self-tested with negative cases so a validator
 * that silently passes everything cannot sneak in.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));

const schema = readJson("tests/fixtures/mcp-server.schema.json");
const server = readJson("server.json");

function resolveRef(ref, doc) {
  assert.ok(ref.startsWith("#/"), `only local refs supported, got ${ref}`);
  return ref
    .slice(2)
    .split("/")
    .reduce((node, key) => node?.[key.replace(/~1/g, "/").replace(/~0/g, "~")], doc);
}

function typeOf(v) {
  if (Array.isArray(v)) return "array";
  if (v === null) return "null";
  return typeof v;
}

/** Returns a list of human-readable violations (empty = valid). */
export function validate(value, sch, doc, path = "$") {
  if (sch === true || sch == null) return [];
  if (sch === false) return [`${path}: schema is false`];
  const errors = [];
  if (sch.$ref) errors.push(...validate(value, resolveRef(sch.$ref, doc), doc, path));
  if (sch.allOf) for (const sub of sch.allOf) errors.push(...validate(value, sub, doc, path));
  if (sch.anyOf) {
    if (!sch.anyOf.some((sub) => validate(value, sub, doc, path).length === 0)) {
      errors.push(`${path}: matches none of the anyOf alternatives`);
    }
  }
  if (sch.oneOf) {
    const hits = sch.oneOf.filter((sub) => validate(value, sub, doc, path).length === 0).length;
    if (hits !== 1) errors.push(`${path}: matches ${hits} oneOf alternatives, want exactly 1`);
  }
  if (sch.enum && !sch.enum.includes(value)) {
    errors.push(`${path}: ${JSON.stringify(value)} is not one of ${JSON.stringify(sch.enum)}`);
  }
  if (sch.const !== undefined && value !== sch.const) {
    errors.push(`${path}: want const ${JSON.stringify(sch.const)}`);
  }
  if (sch.type) {
    const want = Array.isArray(sch.type) ? sch.type : [sch.type];
    if (!want.includes(typeOf(value))) {
      errors.push(`${path}: type is ${typeOf(value)}, want ${want.join("|")}`);
      return errors; // deeper checks would only add noise
    }
  }
  if (typeof value === "string") {
    if (sch.minLength !== undefined && value.length < sch.minLength) {
      errors.push(`${path}: shorter than minLength ${sch.minLength}`);
    }
    if (sch.maxLength !== undefined && value.length > sch.maxLength) {
      errors.push(`${path}: ${value.length} chars exceeds maxLength ${sch.maxLength}`);
    }
    if (sch.pattern && !new RegExp(sch.pattern).test(value)) {
      errors.push(`${path}: ${JSON.stringify(value)} does not match /${sch.pattern}/`);
    }
    if (sch.format === "uri") {
      try {
        new URL(value);
      } catch {
        errors.push(`${path}: ${JSON.stringify(value)} is not a valid URI`);
      }
    }
  }
  if (typeOf(value) === "object") {
    for (const key of sch.required || []) {
      if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
    }
    const props = sch.properties || {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) errors.push(...validate(value[key], sub, doc, `${path}.${key}`));
    }
    if (sch.additionalProperties !== undefined) {
      for (const key of Object.keys(value)) {
        if (key in props) continue;
        if (sch.additionalProperties === false) {
          errors.push(`${path}: additional property "${key}" is not allowed`);
        } else if (typeof sch.additionalProperties === "object") {
          errors.push(...validate(value[key], sch.additionalProperties, doc, `${path}.${key}`));
        }
      }
    }
  }
  if (Array.isArray(value) && sch.items && !Array.isArray(sch.items)) {
    value.forEach((item, i) => errors.push(...validate(item, sch.items, doc, `${path}[${i}]`)));
  }
  return errors;
}

test("server.json validates against the official MCP registry schema", () => {
  const errors = validate(server, schema, schema);
  assert.deepEqual(errors, [], `server.json schema violations:\n${errors.join("\n")}`);
});

test("vendored schema is the one server.json declares (drift guard)", () => {
  assert.equal(server.$schema, schema.$id);
});

test("validator actually bites (negative cases)", () => {
  const noName = { ...server };
  delete noName.name;
  assert.ok(validate(noName, schema, schema).length > 0, "missing name must fail");

  const badName = { ...server, name: "nanoodle-mcp" }; // must be namespaced reverse-DNS
  assert.ok(validate(badName, schema, schema).length > 0, "unnamespaced name must fail");

  const longDesc = { ...server, description: "x".repeat(101) };
  assert.ok(validate(longDesc, schema, schema).length > 0, "description >100 chars must fail");

  const badTransport = structuredClone(server);
  badTransport.remotes = [{ type: "carrier-pigeon", url: "https://mcp.nanoodle.com/mcp" }];
  assert.ok(validate(badTransport, schema, schema).length > 0, "unknown transport type must fail");
});

/**
 * Agent identity bundle guards — offline.
 *
 * server.json is the single source of truth. agent-card.json (A2A) and
 * agent-registration.json (ERC-8004 / Solana 8004) are generated from it by
 * scripts/build-identity.mjs. These tests regenerate both documents in memory
 * and fail on any drift, then check the cross-file agreements and the safety
 * rails a generator alone cannot promise:
 *
 *  - name / description / version / endpoints agree across all three files;
 *  - payment destinations are either the one verified live identifier
 *    (nanoodle.near) or an explicit REPLACE_WITH_* placeholder — never an
 *    invented address (anything shaped like an EVM or Solana address fails);
 *  - no secret-shaped material anywhere in the bundle;
 *  - the A2A card does not claim a live A2A task interface.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AGENT_CARD_URL,
  NEAR_MERCHANT,
  PLACEHOLDER_PREFIX,
  buildIdentity,
} from "../scripts/build-identity.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readText = (rel) => readFileSync(join(root, rel), "utf8");
const readJson = (rel) => JSON.parse(readText(rel));

const server = readJson("server.json");
const card = readJson("agent-card.json");
const registration = readJson("agent-registration.json");
const mcpUrl = server.remotes.find((r) => r.type === "streamable-http").url;

test("checked-in identity files match a fresh regeneration from server.json", () => {
  for (const [file, doc] of Object.entries(buildIdentity(server))) {
    assert.equal(
      readText(file),
      `${JSON.stringify(doc, null, 2)}\n`,
      `${file} has drifted from server.json — run: npm run build:identity`,
    );
  }
});

test("name, description and version agree across server.json, agent card and registration", () => {
  for (const doc of [card, registration]) {
    assert.equal(doc.name, server.title);
    assert.equal(doc.description, server.description);
  }
  assert.equal(card.version, server.version);
  const mcpService = registration.services.find((s) => s.name === "MCP");
  assert.equal(mcpService.version, server.version);
});

test("endpoints agree across the bundle", () => {
  assert.equal(card.supportedInterfaces[0].url, mcpUrl);
  assert.equal(registration.services.find((s) => s.name === "MCP").endpoint, mcpUrl);
  assert.equal(registration.services.find((s) => s.name === "A2A").endpoint, AGENT_CARD_URL);
  assert.equal(registration.services.find((s) => s.name === "web").endpoint, server.websiteUrl);
  assert.equal(card.provider.url, server.websiteUrl);
});

test("agent card carries the A2A v1.0 required shape", () => {
  for (const key of [
    "name",
    "description",
    "version",
    "supportedInterfaces",
    "capabilities",
    "defaultInputModes",
    "defaultOutputModes",
    "skills",
  ]) {
    assert.ok(key in card, `agent card missing required field "${key}"`);
  }
  assert.ok(!("protocolVersion" in card), "A2A v1.0 has no top-level protocolVersion (0.3-era shape)");
  for (const skill of card.skills) {
    for (const key of ["id", "name", "description", "tags"]) {
      assert.ok(key in skill, `skill ${skill.id || "?"} missing "${key}"`);
    }
  }
});

test("agent card does not claim a live A2A task interface", () => {
  const ext = card.capabilities.extensions.find((e) => e.uri.endsWith("/live-transport"));
  assert.ok(ext, "live-transport honesty extension must stay on the card");
  assert.equal(ext.params.a2aTaskInterface, "not-live");
  assert.equal(ext.params.liveTransport, "mcp-streamable-http");
});

test("registration file is an unregistered, active ERC-8004 document", () => {
  assert.equal(registration.type, "https://eips.ethereum.org/EIPS/eip-8004#registration-v1");
  assert.equal(registration.x402Support, true);
  assert.equal(registration.active, true);
  assert.deepEqual(
    registration.registrations,
    [],
    "registrations must stay empty until a human registers on-chain and fills in the real agentId/agentRegistry",
  );
});

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

test("payTo values are the verified NEAR account or explicit placeholders — never invented addresses", () => {
  for (const rail of registration.payments) {
    if (rail.payTo === NEAR_MERCHANT) continue;
    assert.ok(
      rail.payTo.startsWith(PLACEHOLDER_PREFIX),
      `rail ${rail.rail}: payTo "${rail.payTo}" is neither ${NEAR_MERCHANT} nor a ${PLACEHOLDER_PREFIX}* placeholder`,
    );
    assert.ok(!EVM_ADDRESS.test(rail.payTo), `rail ${rail.rail}: placeholder must not be EVM-address-shaped`);
    assert.ok(!SOLANA_ADDRESS.test(rail.payTo), `rail ${rail.rail}: placeholder must not be Solana-address-shaped`);
  }
  const near = registration.payments.find((r) => r.rail === "near");
  assert.equal(near.payTo, NEAR_MERCHANT);
});

test("no secret-shaped material in the identity bundle", () => {
  const secretShapes = [
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
    /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{8,}/,
    /\bghp_[A-Za-z0-9]{20,}/,
    /\bseed\s*[:=]\s*["'][0-9a-f]{32,}["']/i,
  ];
  for (const file of ["server.json", "agent-card.json", "agent-registration.json"]) {
    const text = readText(file);
    for (const shape of secretShapes) {
      assert.ok(!shape.test(text), `${file} matches secret shape ${shape}`);
    }
  }
});

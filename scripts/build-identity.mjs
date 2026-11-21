#!/usr/bin/env node
/**
 * Agent identity bundle — ONE source of truth, three surfaces.
 *
 * server.json (the official MCP Registry manifest) is the source of truth for
 * name, description, version and the hosted MCP endpoint. This script derives
 * the other two identity documents from it:
 *
 *   agent-card.json         A2A (Agent2Agent) Agent Card, spec v1.0.0 shape.
 *                           Serve at https://mcp.nanoodle.com/.well-known/agent-card.json
 *   agent-registration.json ERC-8004 / Solana 8004 registration file (registration-v1).
 *                           Serve at https://mcp.nanoodle.com/.well-known/agent-registration.json
 *                           and use as the agentURI when registering on-chain.
 *
 * Both outputs are CHECKED IN and generated deterministically — edit
 * server.json (or the extras below), run `npm run build:identity`, commit the
 * result. tests/identity.test.mjs regenerates them in memory and fails on any
 * drift, so the three files cannot silently disagree.
 *
 * HONESTY NOTES (do not "fix" these away):
 * - The A2A card is an identity/discovery document. The hosted server's live
 *   wire protocol today is MCP (streamable HTTP); an A2A task interface is
 *   NOT live yet, and the card says so in its capabilities extension instead
 *   of pretending otherwise.
 * - Payment destinations that are not yet configured are explicit
 *   REPLACE_WITH_* placeholders. tests/identity.test.mjs fails if a
 *   placeholder is replaced by anything that is not a real, reviewed value
 *   being added deliberately — and nothing in this repo invents an address.
 * - The only real payment identifier stated here is the NEAR merchant
 *   account `nanoodle.near`, live since the 2026-11-13 mainnet run.
 *
 * Usage:
 *   node scripts/build-identity.mjs           # regenerate both files
 *   node scripts/build-identity.mjs --check   # exit 1 if checked-in files drift
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

export const MCP_ENDPOINT_FALLBACK = "https://mcp.nanoodle.com/mcp";
export const AGENT_CARD_URL = "https://mcp.nanoodle.com/.well-known/agent-card.json";
export const AGENT_REGISTRATION_URL = "https://mcp.nanoodle.com/.well-known/agent-registration.json";
export const AGENT_IMAGE = "https://nanoodle.com/icon-512.png";
export const NEAR_MERCHANT = "nanoodle.near";
export const PLACEHOLDER_PREFIX = "REPLACE_WITH_";

/** Payment rails nanoodle sells workflow runs on. Placeholders stay placeholders until a human fills them. */
export const PAYMENT_RAILS = [
  {
    rail: "nano-x402",
    status: "live",
    note: "Hosted server charges per call in Nano over x402; the payTo address is held in the hosted server's wallet configuration, not published here.",
    payTo: `${PLACEHOLDER_PREFIX}NANO_PAYTO_ADDRESS`,
  },
  {
    rail: "near",
    status: "live",
    note: "Native NEAR deposit-minus-actual-cost with on-chain refund, including agent-composed custom workflows.",
    payTo: NEAR_MERCHANT,
  },
  {
    rail: "base-usdc-x402",
    status: "pending",
    note: "Base USDC x402 ingress is qualified offline only; it goes live with the durable payment-authority work, and only then does this payTo get filled.",
    network: "eip155:8453",
    asset: "USDC",
    payTo: `${PLACEHOLDER_PREFIX}BASE_USDC_PAYTO_ADDRESS`,
  },
  {
    rail: "solana-usdc-x402",
    status: "pending",
    note: "Solana USDC x402 ingress is qualified offline only, same gate as Base.",
    network: "solana:mainnet",
    asset: "USDC",
    payTo: `${PLACEHOLDER_PREFIX}SOLANA_USDC_PAYTO_ADDRESS`,
  },
];

export const SKILLS = [
  {
    id: "run-saved-workflow",
    name: "Run a saved nanoodle workflow",
    description:
      "Run a workflow graph saved from the nanoodle.com editor (or a nanoodle.com share link) as a single tool call: multi-model text, image, video, audio and 3D pipelines executed end to end, with the result returned to the caller.",
    tags: ["mcp", "workflow", "image", "video", "audio", "3d", "multimodal"],
    examples: [
      "Run this nanoodle share link with the prompt 'a lighthouse at dusk, painterly'",
      "Run my saved 'product-shot' workflow on this photo",
    ],
  },
  {
    id: "compose-custom-workflow",
    name: "Compose and run a custom workflow",
    description:
      "Compose a workflow graph inline (text → image → video chains and branches over the NanoGPT model catalog), get a free itemized price, pay per run, and receive the result. Custom composition is a NEAR-rail feature.",
    tags: ["mcp", "workflow", "custom", "near", "pricing"],
    examples: [
      "Build a workflow that turns this paragraph into an illustration, then a 5-second clip",
      "Price a custom graph before I commit to running it",
    ],
  },
  {
    id: "price-workflow",
    name: "Price a workflow before running it",
    description:
      "Free, itemized per-node quote for a saved or composed workflow, with a 30-minute validity window on the NEAR rail. No payment is taken for a quote.",
    tags: ["pricing", "quote", "free"],
    examples: ["What would this workflow cost to run?", "Give me an itemized price for this graph"],
  },
];

export function mcpEndpoint(server) {
  const remote = (server.remotes || []).find((r) => r.type === "streamable-http");
  return remote?.url || MCP_ENDPOINT_FALLBACK;
}

/** A2A Agent Card (spec v1.0.0 shape: supportedInterfaces, no top-level protocolVersion). */
export function buildAgentCard(server) {
  return {
    name: server.title,
    description: server.description,
    version: server.version,
    documentationUrl: "https://github.com/nanoodlecom/nanoodle-mcp#readme",
    iconUrl: AGENT_IMAGE,
    provider: { organization: "nanoodle", url: server.websiteUrl },
    supportedInterfaces: [
      { url: mcpEndpoint(server), protocolBinding: "JSONRPC", protocolVersion: "1.0.0" },
    ],
    capabilities: {
      streaming: false,
      pushNotifications: false,
      extendedAgentCard: false,
      extensions: [
        {
          uri: "https://nanoodle.com/identity/live-transport",
          description:
            "Live wire protocol at the declared interface is MCP (streamable HTTP, JSON-RPC). This card is published for discovery; an A2A task-submission interface is not live yet and is not claimed here.",
          required: false,
          params: { liveTransport: "mcp-streamable-http", a2aTaskInterface: "not-live" },
        },
      ],
    },
    defaultInputModes: ["text/plain", "application/json"],
    defaultOutputModes: ["text/plain", "application/json", "image/*", "video/*", "audio/*"],
    skills: SKILLS,
    "x-payment-rails": PAYMENT_RAILS.map(({ rail, status }) => ({ rail, status })),
  };
}

/** ERC-8004 registration-v1 file (the same document shape Solana 8004 consumes). */
export function buildRegistration(server) {
  return {
    type: "https://eips.ethereum.org/EIPS/eip-8004#registration-v1",
    name: server.title,
    description: server.description,
    image: AGENT_IMAGE,
    services: [
      { name: "web", endpoint: server.websiteUrl },
      { name: "MCP", endpoint: mcpEndpoint(server), version: server.version },
      { name: "A2A", endpoint: AGENT_CARD_URL, version: "1.0.0" },
    ],
    x402Support: true,
    active: true,
    // Not yet registered on any chain: registrations stay empty until a human
    // runs register(agentURI) and the returned agentId/agentRegistry pair is
    // filled in. An empty array is the honest state, not a TODO someone hid.
    registrations: [],
    supportedTrust: [],
    // Non-spec extension, ignored by ERC-8004 explorers: where each rail
    // settles. Placeholders are deliberate — see PAYMENT_RAILS notes.
    payments: PAYMENT_RAILS,
  };
}

export function buildIdentity(server) {
  return {
    "agent-card.json": buildAgentCard(server),
    "agent-registration.json": buildRegistration(server),
  };
}

const serialize = (doc) => `${JSON.stringify(doc, null, 2)}\n`;

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = JSON.parse(readFileSync(join(root, "server.json"), "utf8"));
  const docs = buildIdentity(server);
  const check = process.argv.includes("--check");
  let drift = false;
  for (const [file, doc] of Object.entries(docs)) {
    const want = serialize(doc);
    if (check) {
      const have = readFileSync(join(root, file), "utf8");
      if (have !== want) {
        console.error(`DRIFT  ${file} does not match server.json — run: npm run build:identity`);
        drift = true;
      } else {
        console.log(`ok     ${file} matches server.json`);
      }
    } else {
      writeFileSync(join(root, file), want);
      console.log(`wrote  ${file}`);
    }
  }
  if (drift) process.exit(1);
}

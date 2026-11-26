/** Agent-facing discovery. Do not treat documentation as dispatch or payment policy. */
import { workflowExample } from "./workflow-examples.mjs";

const SOURCE = "https://github.com/nanoodlecom/nanoodle-mcp";
const GUIDE = "noodle_guide", PRICE = "price_noodle", RUN = "run_noodle";
const COMPOSITION = new Set([GUIDE, PRICE, RUN]);
const ASSETS = { nano: "Nano (XNO)", near: "NEAR", usdc: "USDC on NEAR", nanusd: "NanoUSD (NANUSD)" };
const FEATURED = {
  "image-model-arena": "Compare four image models on the same brief.",
  "mix-the-references": "Compose one image from four reference roles.",
  "photo-to-video": "Generate a still from a brief and animate it.",
  sing: "Turn a song idea into a performed track.",
  "idea-to-3d-model": "Turn one object idea into a textured GLB.",
};
const OFFICIAL_HOSTS = new Set(["mcp.nanoodle.com", "nano.nanoodle.com", "near.nanoodle.com", "mcp-near.nanoodle.com", "nanusd.nanoodle.com"]);
const code = name => '`' + name + '`';

function paymentLabel(tool, { charged, near, usdc, nanusd }) {
  if (tool.name === GUIDE || tool.name === PRICE) return "free; no model execution or quote";
  const rails = tool.inputSchema?.properties?._pay_with?.enum;
  if (rails?.length) return "quotes: " + rails.map(r => ASSETS[r] || r).join(", ");
  if (charged) return "quotes: Nano (XNO)";
  if (near) return usdc ? "quotes: NEAR, USDC on NEAR" : "quotes: NEAR";
  if (nanusd) return "quotes: NanoUSD (NANUSD)";
  return "runs on the operator’s balance";
}

export function endpointDiscovery({
  name, tools, publicBase, charged = false, toolInfo = [], near = false,
  usdc = false, nanusd = false, network = "mainnet", creatorHosting = false, template = null,
}) {
  const names = new Set(tools.map(tool => tool.name));
  const infoByName = new Map(toolInfo.map(info => [info.name, info]));
  const official = OFFICIAL_HOSTS.has(new URL(publicBase).hostname);
  const endpoint = publicBase + "/mcp";
  const runMode = charged
    ? "Nano (XNO) is the default." + (near ? " Eligible tools also support NEAR" + (usdc ? " and Circle-issued USDC on NEAR." : ".") : "")
    : near
    ? "This endpoint takes " + (usdc ? "NEAR or Circle-issued USDC" : "native NEAR") + " on NEAR " + network + ", not Nano (XNO)."
    : nanusd
    ? "This endpoint takes NanoUSD (NANUSD) on the NanUSD network — a separate Nano-protocol network whose accounts start with usd_ — not Nano (XNO) and not USDC on NEAR. NanoUSD is issued by Nanswap and backed 1:1 by USDC reserves."
    : "This endpoint does not collect payment from callers; live runs draw from the operator’s balance. Connect only if authorized.";
  const lines = [
    "# " + name,
    "",
    "> Run ready-made AI workflows as MCP tools." + (names.has(GUIDE) && names.has(RUN) ? " Compose a supported graph when no ready-made tool fits." : ""),
    "",
    "MCP endpoint: " + endpoint + " (Streamable HTTP). Use MCP initialize to negotiate the protocol and read the payment procedure. Use tools/list here for exact tools and input schemas; discovery never runs models.",
    "",
    runMode,
    "",
    "## Start here",
    "- [MCP connection guide](" + SOURCE + "#serve-mode--host-your-noodles-as-a-service---serve): e.g. " + code("claude mcp add --transport http noodles " + endpoint) + " or " + code("grok mcp add --transport http noodles " + endpoint) + ".",
  ];
  if (official) {
    for (const [tool, intent] of Object.entries(FEATURED)) {
      if (names.has(tool)) lines.push("- " + code(tool) + ": " + intent);
    }
  }
  if (names.has(GUIDE) && names.has(PRICE) && names.has(RUN)) {
    lines.push(
      "- [Custom graph rules](" + SOURCE + "#what-a-paid-server-will-run): call free " + code(GUIDE) + " for supported node, port and model metadata (optional node_type, kind, search and limit filters; format_only skips model lookup); call free " + code(PRICE) + " with your graph and inputs to validate and estimate; then use " + code(RUN) + " to request a run. Hosted paid composition accepts a priced subset, not arbitrary endpoints, caller media, or local files.",
    );
  }
  if (template && names.has(RUN)) {
    lines.push("- [3D graph template](" + publicBase + "/examples/" + encodeURIComponent(template) + ".json): submit this graph to " + code(PRICE) + " and " + code(RUN) + "; it is not a separately callable tool on this endpoint.");
  }
  if (creatorHosting) lines.push("- [Host a fixed recipe](" + publicBase + "/creators): Nanoodle stores an immutable uploaded graph, exposes its named inputs, and gives it its own run page and MCP endpoint. Anyone with the link may quote or pay to run it; link-only access is not authentication. The recipe is not published to callers. A Nano payout address is optional.");
  lines.push("", "## Tools on this endpoint");
  for (const tool of tools) {
    const info = infoByName.get(tool.name);
    const category = COMPOSITION.has(tool.name) ? "custom graph" : info?.rawText ? "mounted graph" : "server tool";
    const graph = info?.rawText ? "; [graph JSON](" + publicBase + "/graph/" + encodeURIComponent(tool.name) + ".json)" : "";
    const example = official ? workflowExample(tool.name) : null;
    const evidence = example ? "; [" + example.title + "](" + example.play + ")" : "";
    const skill = example?.skill ? "; [local skill](" + example.skill + ")" : "";
    lines.push("- " + code(tool.name) + ": " + category + "; " + paymentLabel(tool, { charged, near, usdc, nanusd }) + graph + evidence + skill + ".");
  }
  lines.push("", "## Costs and data");
  if (charged || near || nanusd) {
    lines.push("- Paid tools do not require a Nanoodle login or a NanoGPT API key from the caller. A quote is not permission to spend. Use an authorized wallet or show the checkout link for approval. After confirmed payment, resume the same tool and arguments with the original " + code("_payment_id") + "; do not pay a replacement quote to retry. Keep status/watch URLs and payment IDs private.");
    lines.push("- The deposit caps the charge. Successful calls settle at metered model cost plus a 20% markup up to that cap. Unused funds are returned to the payer; failed workflows refund the deposit. A graph can assign the available markup to its author, capped by what the deposit has left after cost; otherwise the operator keeps the markup.");
    if (charged) lines.push("- [Nano payment guide](" + SOURCE + "#charging-per-call---charge-usd): Nano quotes, monitoring and resuming an existing result.");
    if (near) lines.push("- [NEAR payment guide](" + SOURCE + "/blob/main/docs/near-payments.md): asset-specific transfers, receipts, same-asset refunds and recovery.");
    if (nanusd) lines.push("- [NanoUSD payment guide](" + SOURCE + "/blob/main/docs/nanusd-payments.md): asset transfers, receipts, same-asset refunds and recovery.");
  }
  lines.push(
    "- [Runtime privacy and retention](" + SOURCE + "#privacy--what-your-server-keeps): inputs pass through this server to [NanoGPT](https://nano-gpt.com/privacy). For ordinary invocations the server does not persist prompts or input media; paid runs retain payment and receipt records. HTTP results return text and temporary media URLs (sometimes inline images), not client-side file paths. HTTP media retention is 24 hours by default; a self-host operator can set it. Keep media result URLs private.",
    "",
    "## Source and local installs",
    "- [Server source and licensing](" + SOURCE + "#licensing): server code, installed dependencies and served graphs have distinct license terms.",
    "- [Install or self-host](" + SOURCE + "#install): " + code("nanoodle-mcp --graphs ./noodles") + " mounts your own saved graphs as typed tools. Stdio uses your NanoGPT key or configured Nano wallet and returns local file paths; free HTTP serving spends the operator’s balance. Secure access before exposing your server, and mount only graphs safe to publish.",
    "- [Browser editor and SDKs](https://nanoodle.com/llms.txt): run a graph or app on your own NanoGPT balance without sending it to this MCP service.",
  );
  if (official) lines.push("- [Reviewed outputs](https://nanoodle.com/examples/gallery/): examples, full briefs and observed costs. Published samples are not quotes.");
  return lines.join("\n") + "\n";
}

export function creatorDiscovery(hosted, tools) {
  const run = tools.find(tool => tool.name === "run_workflow");
  const rails = run?.inputSchema?.properties?._pay_with?.enum ?? [];
  // List public parameter keys, not arbitrary publisher text, embedded defaults
  // or the recipe itself. Clients read the full contract from tools/list.
  const properties = run?.inputSchema?.properties ?? {};
  const required = new Set(run?.inputSchema?.required ?? []);
  const fields = Object.keys(properties).filter(key => !key.startsWith("_"));
  return [
    "# Creator-hosted Nanoodle recipe",
    "",
    "> An immutable creator-submitted recipe hosted by Nanoodle. The graph stays server-side; anyone with this link can quote and pay to run it. This is not a private, authenticated endpoint or a Nanoodle-curated workflow.",
    "",
    "MCP endpoint: " + hosted.mcpUrl + ". Use tools/list for the exact input schema.",
    "",
    "## Tools on this endpoint",
    "- `price_workflow`: free estimate; no models run and no payment is created.",
    "- `run_workflow`: quote, then run with the same inputs and original `_payment_id` when payment is confirmed. Accepted assets: " + rails.map(r => ASSETS[r] || r).join(", ") + ".",
    "",
    "Caller inputs:",
    ...fields.map(key => "- " + code(key) + (required.has(key) ? " (required)" : " (optional)")),
    "",
    "Quote and authorize payment separately. Resume the same run after payment rather than paying twice. Inputs are sent to the host and NanoGPT, and generated media is available via temporary URLs. The submitted recipe is retained. " + (hosted.author ? "The graph has a Nano creator payout address." : "No creator payout is configured."),
    "",
    "## More information",
    "- [Human run page](" + hosted.url + "): use the same hosted recipe from a browser.",
    "- [Hosted MCP payment and privacy](" + new URL("/llms.txt", hosted.mcpUrl) + "): payment recovery, data and retention.",
    "",
  ].join("\n");
}

/**
 * Front door for nanusd.nanoodle.com — sibling of src/near-site.mjs.
 * Follows the Base page's honesty pattern (what is live / what is not,
 * plainly) and the NEAR door's shape. The page must never imply NanoUSD
 * payments are live before the rail opens, and never imply NanoUSD is
 * Nano: it is a USD-pegged asset on its own network, issued by Nanswap
 * against USDC reserves — a custodial claim, stated up front.
 */
export function nanusdSitePage({ publicBase = "https://nanusd.nanoodle.com" } = {}) {
  const origin = String(publicBase).replace(/\/+$/, "");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nanoodle — Give your agents new abilities, paid in NanoUSD</title>
<meta name="description" content="Open-source AI workflows for agents, paid per run in NanoUSD: a feeless, USD-pegged stablecoin on its own Nano-protocol network.">
<link rel="canonical" href="${origin}/">
</head><body>
<header><a href="/">nanoodle</a><nav>
<a href="https://nanoodle.com">Editor ↗</a>
<a href="https://nano.nanoodle.com/">Pay in Nano ↗</a>
<a href="https://near.nanoodle.com/">Pay in NEAR / USDC ↗</a>
<a href="https://github.com/nanoodlecom/nanoodle-mcp">Source ↗</a>
</nav></header>
<main>
<p>Open-source workflows for agents</p>
<h1>Give your agents new abilities.</h1>
<p>Make images, clips, songs and 3D models. Nanoodle turns AI workflows into tools your agent can discover, pay for and run. On this door, your agent pays in <strong>NanoUSD</strong>.</p>
<p><strong>Status: in preparation — NanoUSD payments are not live yet.</strong> Nothing on this page can take your NanoUSD today. The quote, settlement and refund logic is built and proven offline; the rail opens only after a live-node check and an explicit launch decision. Today, pay in <a href="https://nano.nanoodle.com/">Nano</a> or <a href="https://near.nanoodle.com/">NEAR / USDC on NEAR</a>.</p>
<h2>Connect your agent</h2>
<pre>claude mcp add --transport http nanoodle ${origin}/mcp</pre>
<p>Works with Claude Code, Grok, Cursor and any MCP client.</p>
<h2>Why NanoUSD?</h2>
<ul>
<li><strong>USD in, USD out.</strong> NanoUSD is pegged 1:1 to the US dollar, so a quote needs no exchange-rate oracle and its dollar value cannot drift while you pay.</li>
<li><strong>Feeless, sub-second.</strong> The NanUSD network charges no transaction fees and confirms in under a second.</li>
<li><strong>Know what it is.</strong> NanoUSD is issued by <a href="https://nanusd.com/">Nanswap</a> and backed 1:1 by <a href="https://nanusd.com/">public USDC reserves</a>. It is a custodial claim on that reserve — a different trust shape from Nano (XNO) or NEAR, and we say so up front. NanoUSD is not Nano: it runs on its own network, and its accounts start with <code>usd_</code>.</li>
</ul>
<h2>Pay per run</h2>
<p>Quote first. Pay for one run. Get your change. No provider API keys.</p>
<p><strong>Model cost + 20%.</strong> The quote includes the service fee. Your deposit is the most you can be charged. Unused funds return to the paying wallet in NanoUSD. A failed run refunds the whole deposit, in NanoUSD.</p>
<h2>Build your own workflow</h2>
<p>Build a graph in the <a href="https://nanoodle.com">visual editor</a>, or let your agent compose one with <code>run_noodle</code>. <code>price_noodle</code> and <code>noodle_guide</code> are free.</p>
<h2>Get NanoUSD</h2>
<p>Swap on <a href="https://nanswap.com">Nanswap</a>, hold and send it with <a href="https://nanchat.com">NanChat</a>, and inspect transfers on <a href="https://nanexplorer.com/nanusd">Nanexplorer</a>.</p>
</main>
<footer><a href="/llms.txt">Agent instructions</a> · <a href="https://nanoodle.com">nanoodle.com</a> · Generation runs through <a href="https://nano-gpt.com">NanoGPT</a></footer>
</body></html>`;
}

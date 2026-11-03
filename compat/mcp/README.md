# Opt-in MCP client compatibility qualification

Noodle's merged server implements its own MCP 2025 transport. This private,
checkout-only package adds an SDK v2 façade around the existing **paid** registry,
plus offline SDK qualification. It changes no production CLI, dependency, endpoint,
registry listing, or payment implementation. It does not add a payment network.

## Verified upstream and scope

Checked 2026-11-03 against the official sources:

- [SDK repository](https://github.com/modelcontextprotocol/typescript-sdk): v2 is the
  stable split `@modelcontextprotocol/server` / `client` line; v1 remains maintained
  for at least six months after the 2026-07-27 release.
- [July 2026 release](https://blog.modelcontextprotocol.io/posts/2026-07-28/):
  `server/discover` is optional, initialize/session IDs are removed from the modern
  core, each request carries identity/capabilities, and HTTP uses routing headers.
- [Official serving entry](https://ts.sdk.modelcontextprotocol.io/v2/): use the
  SDK's era-selecting `serveStdio(factory)` entry. A hand-connected low-level Server
  does not perform the modern serving-entry setup.

Pinned SDK server/client **2.4.0**, legacy SDK **1.32.2**, Node **24.22.1**. These are
actual downloaded SDK packages, not hand-written wire stubs. The façade offers
2026-07-28 and the SDK-supported 2025-11-25 / 2025-06-18 / 2025-03-26 / 2024-11-05
revisions. The tests exercise modern 2026-07-28 and legacy 2025-11-25; offering an
older revision is not evidence of validation in every old application.

## Install and run offline tests

From repository root, using a Node version allowed by the root package:

```sh
npm ci --ignore-scripts
npm ci --prefix compat/mcp --ignore-scripts
npm test --prefix compat/mcp
```

Dependency installation needs the npm registry. Test execution uses linked
in-memory SDK transports and a scripted Nano RPC with a static exchange rate;
it cannot pay, fund a wallet, call NanoGPT, submit a directory entry or deploy.
The explicit `node checks.mjs` command uses `node:test` and returns nonzero for a
failed assertion. It is separate from the root's automatic `node --test` discovery.
Run this separate command in CI when opting into the façade. This PR does not
change the existing production regression job or automatically install the SDK
qualification dependencies in it.

## Integration boundary

Operator wiring (library example, not a runnable payment-enabled launcher):

```js
import { serveCompatibility } from './compat/mcp/server.mjs';

// These are the existing operator-owned instances, constructed by trusted code.
// canonicalChargeGate is createChargeGate(...) with the established stateFile,
// wallet ops and validation; workflowRegistry is the canonical loaded registry.
const paidRegistry = canonicalChargeGate.wrapRegistry(workflowRegistry);
const handle = serveCompatibility({
  paidRegistry,
  version: packageVersion,
  revision: sourceCommitSha, // full 40-character commit SHA
  timeoutMs: 30_000,
});
// On shutdown: await handle.close();
```

The façade calls only the actual `{listTools, callTool}` boundary already used by
`bin/nanoodle-mcp.mjs`. The charge gate owns quote allocation, argument binding,
reservation (`q.running`), dispatch, receipt creation, refunds/change and replay.
No extra payment ledger, wallet, conversion path or settlement mechanism exists
here. Nano x402 downstream execution is unchanged. No dependency on NEAR's
unmerged `src/payments` modules exists; those modules are absent on this PR's main
base. A catalog shape guard rejects accidental free-registry injection, but it
cannot authenticate a deliberately dishonest injected implementation.

Use one SDK Server per connection. Share the canonical gate/registry only.
The public `serveCompatibility` entry owns the era decision. The lower-level
`createCompatibilityServer` factory is for that SDK entry and boundary tests;
do not connect its Server directly to a modern transport.

The catalogue is deterministically sorted, has no read-only/idempotent hints for
paid calls, uses private zero-TTL list caching, and advertises only tools. No
resources, prompts, sampling, logging, subscriptions, elicitation, or tasks are
claimed. Modern SDK clients avoid unsupported resource requests; legacy requests
receive method-not-found. No server URL, OAuth principal or client `_meta` value
is treated as proof of payment.

## Paid call and uncertain outcomes

1. Call a listed tool to get the **canonical** `structuredContent.x402` quote.
   This allocates a quote; it never pays or executes the workflow.
2. Show the human the quote's payUrl. The agent watches its watchUrl until the
   canonical watch closes paid. No adapter auto-payment exists.
3. Resubmit identical arguments and `_payment_id` to retrieve the result. The
   canonical gate binds that payment ID to tool/arguments and shares execution
   across connections. The normal output and gate-authored receipt remain intact.

All returned results include `_meta['com.nanoodle/mcp-compat']` with adapter
version, package version, full source revision and the payment ID when supplied.
This is source provenance, **not proof of chain settlement**. The canonical
payment receipt is separate; the adapter never invents a transaction hash.

A timeout, abort, disconnect or tool failure is conservative `outcome_unknown`
with `automaticRetry:false`. Before-dispatch cancellation dispatches nothing;
after dispatch the canonical gate may continue running. The gate currently does
not consume the façade's cancellation signal during paid execution. Neither an
abort signal nor tool completion establishes a confirmed refund/change transfer.
Thrown upstream error messages and failed-result detail are replaced by fixed
safe text; the operator must reconcile authoritative gate/ledger/chain state.
Do not create replacement quotes or pay again automatically. A known payment ID
can be reconciled with the same arguments and its existing gate state. If the
quote call itself timed out without returning an ID, consult the operator first.

**Restart limitation inherited from main:** this is not durable exactly-once
execution. The canonical gate deliberately omits private text output from disk;
after restart it may rerun that workflow to regenerate output while avoiding
repeated settlement. In-process shared-gate replay is covered; durable dispatch
journaling and restart-safe provider execution are outside this compatibility PR.
Its canonical receipt can also precede confirmation of queued outgoing transfers.
The façade does not strengthen these guarantees or claim settlement is final.

## Coverage and limits

Nine offline checks cover actual SDK discovery/envelopes and legacy initialize;
tools/schema/error/resource semantics; real canonical quote/pay/run/receipt flow;
two concurrent connections with one canonical dispatch; mismatched-argument
rejection; paid timeout then same-ID recovery; SDK cancellation then recovery;
secret-safe failure; uncertain outgoing refund; pre-dispatch abort; rejection of an ungated registry; and a
v2 auto-negotiating client falling back to the unchanged canonical dispatcher.
A simulated payment is a fixture, not a network compatibility receipt.

There is no live Claude, Codex, Cursor, Gemini, ChatGPT, registry, OAuth, HTTP
routing-header, reverse-proxy, stdio child-process, or marketplace qualification.
This façade uses the SDK's stdio serving entry with in-memory transports; exposing
it via HTTP needs the official HTTP entry, authorization/routing tests and a
separate decision. Existing production endpoints remain on their existing path.

## Onboarding and distribution drafts

`client-configs.draft.json` contains conventional stdio and remote configuration
examples plus adapter metadata. They are **drafts**, not directory submissions or
assertions that every named client accepts that JSON shape. Use the client's own
configuration format. No persistent client configuration was changed.

- Existing remote MCP clients: one URL and a Nano-capable payer/wallet; no Noodle
  account required by the existing paid gate. User pays per quote. UI friction is
  showing payUrl, keeping watchUrl agent-only and retaining `_payment_id`.
- Local canonical stdio: install supported Node, choose graph/output directories,
  and inject either BYOK credentials or a dedicated limited Nano wallet using the
  established environment/env-file flow. No credentials belong in argv or this
  draft. `--max-usd` caps downstream wallet invoices; it is not a total-session
  budget. Do not call the configured tools just to test connectivity: they spend.
- New v2 façade: operator must opt in from a checkout, install this private package,
  inject the canonical paid registry, and maintain one gate owner/stateFile.
  There is no `npx nanoodle-mcp-compatibility` package or new CLI flag.

## Unit economics

MCP itself adds no payment rail fee and this adapter charges no fee. SDK operation
adds CPU/memory and operational support cost; no throughput or revenue is measured.
The existing gate quotes a deposit, then charges metered model cost plus 20%,
subject to canonical caps/change rules. At $0.0100 metered provider cost, a normal
$0.0120 customer charge has $0.0020 gross markup before hosting, errors, RPC/
work services, conversion/spread or other operator costs. If an author address is
configured, that markup goes to the author, leaving **zero operator markup**
before those costs. Provider cost, customer deposit, final charge, author payout
and operator net margin must remain separate. A larger deposit is not revenue.
Nano has no protocol transaction fee, but RPC/work service charges and operational
costs may exist; no free hosted infrastructure or economic margin is promised.
On a failed run the hosted payment refund does not reverse provider spend already
incurred. Adoption, conversion rate, latency and paying customer demand remain
unmeasured; this PR proves an integration surface only.

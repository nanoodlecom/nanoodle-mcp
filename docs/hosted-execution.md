# Hosted execution deadlines

HTTP tool calls, paid Nano and NEAR/USDC runs, and Agent Market workflow runners
have a 30-minute execution limit by default. Saved graphs, custom graphs,
humanizer retries and built-in tools share one deadline. A nested tool does not
start another clock. Graph fields and MCP arguments cannot raise this limit.
The same scope covers engine execution and downloading its finished outputs.

Operators can set `NANOODLE_RUN_TIMEOUT_MS` to a positive integer, up to
86400000 (24 hours), then restart the service. Invalid values prevent hosted
startup. Pick a limit that includes the whole graph: a 3D model can take
25 minutes and sequential model steps add time. Ordinary stdio use keeps its
existing behavior; this setting does not impose a deadline on local tools.

The shared helper passes an abort signal into the existing engine and runtime
transport. This stops video polling even though the library's video timeout
defaults to infinity. Stalled headers and response bodies are bounded, including
media downloads after the model finishes. Late callbacks cannot start another
HTTP request after a scope closes. The wrapper preserves streaming responses,
cost headers and final response URLs used for provider media resolution.

Cancellation waits for the engine's nodes and any already queued payment
publication/reconciliation to settle. It does not race the entire workflow and
release its financial reservation while background nodes keep spending. A
transaction already being published may need additional time to reconcile;
never replace it merely because a model deadline expired. A provider may finish
an already accepted job after local cancellation. Its costs remain the
operator's, subject to the run's prepayment budget.

The existing failure path refunds a direct customer's hosted deposit. Replaying
that failed payment returns the stored outcome without paying another provider
invoice. Market failures follow the existing decline/refund process. No timeout
automatically submits another model run. This deadline does not establish safe
restart recovery for every ambiguous legacy payment; the durable journal and
single-writer audit remain separate requirements.

The private funding snapshot reports the configured limit. The five-minute
no-inference readiness check flags a scope older than that limit plus 15 minutes
for reconciliation. It observes work and sends an alert; it never retries or
executes a workflow. Snapshots from the preceding deployment, without the new
field, retain the old 45-minute stuck threshold during rollout.

Offline failure tests exercise stalled headers/bodies, indefinite video polling,
late callbacks, nested tools and an in-flight payment at cancellation. Actual
server fixtures test full refunds and replay without a second invoice for
Nano, NEAR and USDC. No real inference or funds are used in these tests.

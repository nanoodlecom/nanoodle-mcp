# NanoUSD payments

Status: **in preparation — the rail is not live.** The gate, adapter and
server surface are built and proven offline (tests/nanusd-gate.test.mjs);
no deployment accepts NanoUSD yet. This document describes the design
that will open, so reviewers can check it before any money moves.

## What NanoUSD is — and is not

NanoUSD (NANUSD) is a USD-pegged asset issued by
[Nanswap](https://nanusd.com/), launched 2025-10-22, claimed to be backed
1:1 by USDC reserves held at a public Polygon address
(`0x72ebfe736b58cdadfa62ab1fef95526047c437a1`, linked from nanusd.com).

It is **not** a token on the Nano (XNO) network and it is not USDC.
NanoUSD is the native asset of its own network: a Nano-protocol fork
(`yxse/nan-node`, custom genesis) whose accounts start with `usd_`, with
public peering at `peering.nanusd.com:7090`. Transfers are ordinary
Nano-protocol send/receive block pairs on that ledger — feeless, with
sub-second cementing on a small representative set. Nano mainnet RPC
cannot see them; this server reads them from a NanUSD node.

Trust shape, plainly: holding NANUSD is a custodial claim on one small
operator's reserve. That is a different risk from bearer assets like XNO
or NEAR, and the front door says so. Reserve parity (balance vs. supply)
was not independently verified at design time.

## How a payment flows

The NanoUSD gate is an instance of the shared payment route
(`src/pay/route-core.mjs`) with the NanoUSD adapter
(`src/nanusd/adapter.mjs`) — the same lifecycle as the Nano and NEAR
gates, its own route throughout:

1. `price_noodle` (free) estimates the run in USD.
2. `run_noodle` returns a quote: id `uq_…`, the merchant `usd_` account,
   an exact NANUSD deposit (estimate at the locked 1:1 rate plus a unique
   micro-unit tag — the amount is the memo), and a 30-minute expiry.
3. The payer sends that exact amount in one transfer (NanChat deep link
   or QR on the pay page for humans).
4. The gate detects the confirmed transfer on its NanUSD node, runs the
   workflow once, and settles: charged = min(actual model cost + 20%,
   deposit). No exchange-rate oracle exists on this rail — 1 NANUSD =
   1 USD at quote time, by the peg.
5. Change returns to the payer's source account **in NANUSD**; a failed
   run refunds the whole deposit in NANUSD. Refund reasons are fixed
   categories in the payments ledger, never free text.
6. The receipt has three legs: the caller's on-chain payment; the model
   payment **derived** at the locked 1:1 rate and labelled derived
   (never read off a NanoGPT invoice); and the change/refund send with
   its block hash.

Repeating a paying call replays the stored outcome. A payment reference
settles at most one quote, once.

## Recovery

- Paid after the quote expired: the deposit is refunded in full to the
  source account (late-payment path, same as the other rails).
- Paid the wrong amount: nothing runs; the operator reconciles from the
  payments ledger, which records the block hash and payer of every
  observed transfer to the merchant account.
- Server restart mid-flight: owed sends are journaled before broadcast,
  so a restart resumes the debt instead of losing it.

## What must happen before this rail opens

1. Verify the raw unit exponent (assumed 10^30, the stock Nano value)
   against a live NanUSD node with a 0.01 NANUSD self-transfer.
2. Stand up (or obtain) a NanUSD node endpoint the server can read.
3. Decide the confirmation bar for a small-representative network and
   the treasury posture for a thin custodial asset (operator decisions,
   tracked outside this document).
4. Attach `nanusd.nanoodle.com` (DNS + deployment) and flip the rail on
   explicitly. Until then every payment route on that host answers 503.

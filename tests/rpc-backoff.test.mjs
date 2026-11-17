import { test } from "node:test";
import assert from "node:assert/strict";
import { rpcRetryAfterMs, rpcPeerSetId, selectRpcCooldowns, MAX_RPC_RETRY_MS } from "../src/rpc-backoff.mjs";

test("RPC backoff reads JSON seconds and HTTP delta/date hints without retrying early", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");
  assert.equal(rpcRetryAfterMs({ body: 90, header: "120", now }), 120_000);
  assert.equal(rpcRetryAfterMs({ body: "0.0011", now }), 2);
  assert.equal(rpcRetryAfterMs({ header: "Tue, 17 Nov 2026 12:02:00 GMT", now }), 120_000);
  assert.equal(rpcRetryAfterMs({ header: "Tue, 17 Nov 2026 11:59:00 GMT", now }), 0);
  assert.equal(rpcRetryAfterMs({ body: 1e100, now }), MAX_RPC_RETRY_MS);
  for (const body of [undefined, null, false, [], [60], {}, -1, Infinity, NaN, "-1", "secret", "1e10"]) {
    assert.equal(rpcRetryAfterMs({ body, now }), null);
  }
});

test("indexed cooldown telemetry is tied to the same ordered peer configuration", () => {
  assert.equal(rpcPeerSetId([" https://one/ ", "https://two"]), rpcPeerSetId(["https://one", "https://two/"]));
  assert.notEqual(rpcPeerSetId(["https://one", "https://two"]), rpcPeerSetId(["https://two", "https://one"]));
  for (const peers of [[], ["one", "one/"], [null]]) assert.throws(() => rpcPeerSetId(peers));
});

test("cooldown selection rejects invalid peers/deadlines and never copies private extras", () => {
  const now = 1000;
  assert.deepEqual(selectRpcCooldowns([{ peer: 1, until: 2000, url: "PRIVATE_ENDPOINT" }, { peer: 0, until: 999 }], 2, now), [{ peer: 1, until: 2000 }]);
  for (const value of [null, [{ peer: false, until: 2000 }], [{ peer: 2, until: 2000 }], [{ peer: 0, until: "2000" }],
    [{ peer: 0, until: now + MAX_RPC_RETRY_MS + 30_001 }], [{ peer: 0, until: 2000 }, { peer: 0, until: 3000 }]]) {
    assert.throws(() => selectRpcCooldowns(value, 2, now));
  }
});

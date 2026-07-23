import { test } from "node:test";
import assert from "node:assert/strict";
import { redactUrl } from "../src/redact.mjs";

test("redactUrl masks credential query params, keeps the rest", () => {
  assert.equal(
    redactUrl("wss://nodes.nanswap.com/ws/?ticker=XNO&api_key=SECRET123"),
    "wss://nodes.nanswap.com/ws/?ticker=XNO&api_key=***",
  );
  // work URL with a key
  assert.equal(
    redactUrl("https://nodes.nanswap.com/XNO?api_key=abcDEF"),
    "https://nodes.nanswap.com/XNO?api_key=***",
  );
  // no secret param → untouched
  assert.equal(redactUrl("https://rpc.nano.to"), "https://rpc.nano.to");
});

test("redactUrl handles a comma-separated list, redacting only keyed entries", () => {
  const out = redactUrl("http://100.90.104.57:7076,https://rpc.nano.to,https://nodes.nanswap.com/XNO?api_key=zzz");
  assert.equal(out, "http://100.90.104.57:7076,https://rpc.nano.to,https://nodes.nanswap.com/XNO?api_key=***");
  assert.doesNotMatch(out, /zzz/);
});

test("redactUrl scrubs even unparseable input rather than leak a key", () => {
  const out = redactUrl("not-a-url?token=hunter2&foo=bar");
  assert.doesNotMatch(out, /hunter2/);
  assert.match(out, /foo=bar/); // non-secret survives
});

test("redactUrl passes through empty/nullish", () => {
  assert.equal(redactUrl(""), "");
  assert.equal(redactUrl(null), null);
  assert.equal(redactUrl(undefined), undefined);
});

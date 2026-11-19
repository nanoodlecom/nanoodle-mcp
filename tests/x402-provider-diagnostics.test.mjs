import assert from "node:assert/strict";
import test from "node:test";
import { NanoClient } from "nanoodle";

test("paid NanoGPT HTTP failures identify completion and replay", async () => {
  for (const stage of ["completion", "replay"]) {
    let paid = 0;
    let replayed = 0;
    const rejected = () => Response.json(
      { error: "Insufficient balance for private prompt" },
      { status: 500, headers: { "x-request-id": "req_x402-test" } },
    );
    const client = new NanoClient({
      payment: async () => { paid++; },
      fetch: async (url, init) => {
        if (url.includes("/complete/")) {
          return stage === "completion" ? rejected() : Response.json({ status: "completed" });
        }
        if (init.headers["x-x402-payment-id"]) {
          replayed++;
          return rejected();
        }
        return Response.json({
          payment: {
            paymentId: "pay_test",
            accepted: [{ scheme: "nano", network: "nano-mainnet",
              payTo: "nano_3arg3asgtigae3xckabaaewkxuzx88g4wrzux4a47fcac8ygk9arsqqabwck",
              amount: "100000000000000000000000000" }],
          },
        }, { status: 402 });
      },
    });
    await assert.rejects(client.chat([{ role: "user", content: "hello" }], "liquid/lfm-2.5-2.6b"), error => {
      assert.deepEqual([error.code, error.stage, error.status, error.requestId], ["x402", stage, 500, "req_x402-test"]);
      assert.doesNotMatch(error.message, /balance|top up|private prompt/i);
      return true;
    });
    assert.equal(paid, 1);
    assert.equal(replayed, Number(stage === "replay"));
  }
});

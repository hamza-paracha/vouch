import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { it } from "node:test";
import type { BrowserContext } from "playwright";
import { assertJson } from "../src/verify/assertions.ts";
import { VerificationStop } from "../src/verify/routing.ts";

for (const scenario of ["retry deadline", "no observation", "caller cancellation", "invalid JSON"] as const) {
  it(`persisted-state polling preserves evidence and errors: ${scenario}`, async () => {
    const controller = new AbortController();
    let reads = 0;
    const server = createServer((_req, res) => {
      reads++;
      if (scenario === "no observation") return;
      if (reads === 1) { res.end('{"name":"Original"}'); return; }
      if (scenario === "caller cancellation") controller.abort(new Error("Caller cancelled"));
      if (scenario === "invalid JSON") res.end("not JSON");
      // Otherwise leave the retry pending until the assertion deadline.
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const context = { cookies: async () => [] } as unknown as BrowserContext;
    try {
      await assert.rejects(assertJson(context,
        { kind: "assertJson", path: "/state", field: ["name"], equals: "Ada" },
        `http://127.0.0.1:${address.port}/state`, 1000, controller.signal, {}), (error: unknown) => {
        if (scenario === "retry deadline") {
          assert.ok(error instanceof VerificationStop);
          assert.equal(error.status, "failed");
          assert.match(error.message, /last observed "Original"/);
          assert.ok(reads >= 2, "The retry must have reached the server");
        } else if (scenario === "caller cancellation") {
          assert.equal(error, controller.signal.reason);
        } else if (scenario === "invalid JSON") {
          assert.ok(error instanceof SyntaxError);
        } else {
          assert.ok(error instanceof Error && error.name === "AbortError");
          assert.ok(!(error instanceof VerificationStop));
        }
        return true;
      });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
}

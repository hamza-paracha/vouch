import { createServer, request, type ClientRequest, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { sameOrigin } from "./schema.ts";

export type BlockedRequest = { method: string; url: string; reason: string };

function forwardingHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  const connectionHeaders = String(headers.connection ?? "").split(",").map((h) => h.trim().toLowerCase());
  for (const h of [...connectionHeaders, "connection", "proxy-connection", "proxy-authorization", "proxy-authenticate", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]) delete result[h];
  return result;
}

/** A streaming, exact-origin HTTP proxy checks EVERY hop, including browser redirects.
 * Playwright routes alone cannot enforce redirect destination and method policy. */
export async function createOriginProxy(options: {
  origin: string; allowedWritePaths: string[]; onBlocked: (request: BlockedRequest) => void;
}) {
  const pending = new Set<ClientRequest>();
  const server = createServer((incoming, outgoing) => {
    const raw = incoming.url ?? "";
    const method = incoming.method ?? "GET";
    const reject = (reason: string) => {
      options.onBlocked({ method, url: raw, reason });
      outgoing.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
      outgoing.end("Request blocked by verification policy");
    };
    if (!sameOrigin(raw, options.origin)) { reject("off-origin"); return; }
    const url = new URL(raw);
    if (!["GET", "HEAD", "OPTIONS"].includes(method) && !options.allowedWritePaths.includes(url.pathname)) {
      reject("write-blocked"); return;
    }
    const headers = forwardingHeaders(incoming.headers);
    headers.host = url.host;
    const upstream = request(url, { method, headers, agent: false }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, forwardingHeaders(response.headers));
      response.on("error", () => outgoing.destroy());
      response.pipe(outgoing);
    });
    pending.add(upstream);
    upstream.on("close", () => pending.delete(upstream));
    upstream.on("error", () => {
      if (!outgoing.headersSent && !outgoing.destroyed) {
        options.onBlocked({ method, url: raw, reason: "request-error" });
        outgoing.writeHead(502); outgoing.end("Local target unavailable");
      } else outgoing.destroy();
    });
    incoming.on("aborted", () => upstream.destroy());
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on("connect", (req, socket) => {
    options.onBlocked({ method: "CONNECT", url: req.url ?? "", reason: "https-unsupported" });
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  server.on("upgrade", (req, socket) => {
    options.onBlocked({ method: "WEBSOCKET", url: req.url ?? "", reason: "websockets-unsupported" });
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
  });
  server.on("clientError", (_error, socket) => socket.destroy());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to start origin proxy");
  return {
    server: `http://127.0.0.1:${address.port}`,
    // Chromium implicitly bypasses proxies for loopback unless this subtractive rule is set.
    bypass: "<-loopback>",
    async close() {
      for (const req of pending) req.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

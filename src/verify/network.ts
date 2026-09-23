import { createServer, request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type RequestListener } from "node:http";
import { createServer as createTLSServer, request as httpsRequest } from "node:https";
import type { Duplex } from "node:stream";
import { once } from "node:events";
import { localTarget, sameOrigin } from "./schema.ts";
import { interceptionCertificate } from "./tls.ts";

export type BlockedRequest = { method: string; url: string; reason: string };

function forwardingHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  const connectionHeaders = String(headers.connection ?? "").split(",").map((h) => h.trim().toLowerCase());
  for (const h of [...connectionHeaders, "connection", "proxy-connection", "proxy-authorization", "proxy-authenticate", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade"]) delete result[h];
  return result;
}

/** Every HTTP request, including those inside HTTPS CONNECT, passes through the same policy.
 * CONNECT is terminated locally: it is never an unrestricted tunnel to the application. */
export async function createOriginProxy(options: {
  origin: string; allowedWritePaths: string[]; onBlocked: (request: BlockedRequest) => void;
  allowInsecureTLS?: boolean; tlsCA?: string;
}) {
  const target = localTarget(options.origin);
  const pending = new Set<ClientRequest>();
  const sockets = new Set<Duplex>();
  const active = new Set<object>();
  let lastActivity = Date.now();
  const forward = (encrypted: boolean): RequestListener => (incoming, outgoing) => {
    lastActivity = Date.now();
    const method = incoming.method ?? "GET";
    let raw = incoming.url ?? "";
    // Inside TLS the browser uses origin-form URLs. Reject Host/authority mismatches too.
    if (encrypted && raw.startsWith("/") && !raw.startsWith("//")) raw = `${target.origin}${raw}`;
    const reject = (reason: string) => {
      options.onBlocked({ method, url: raw, reason });
      outgoing.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
      outgoing.end("Request blocked by verification policy");
    };
    if (!sameOrigin(raw, options.origin) || (encrypted && incoming.headers.host !== target.host)
      || (encrypted !== (target.protocol === "https:"))) { reject("off-origin"); return; }
    const url = new URL(raw);
    if (!["GET", "HEAD", "OPTIONS"].includes(method) && !options.allowedWritePaths.includes(url.pathname)) {
      reject("write-blocked"); return;
    }
    active.add(incoming);
    const finish = () => { if (active.delete(incoming)) lastActivity = Date.now(); };
    outgoing.once("finish", finish); outgoing.once("close", finish);
    const headers = forwardingHeaders(incoming.headers);
    headers.host = url.host;
    const request = encrypted ? httpsRequest : httpRequest;
    const upstream = request(url, { method, headers, agent: false,
      ...(encrypted ? { rejectUnauthorized: !options.allowInsecureTLS, ...(options.tlsCA ? { ca: options.tlsCA } : {}) } : {}),
    }, (response) => {
      outgoing.writeHead(response.statusCode ?? 502, forwardingHeaders(response.headers));
      response.on("error", () => {
        options.onBlocked({ method, url: raw, reason: "response-error" }); outgoing.destroy();
      });
      response.pipe(outgoing);
    });
    pending.add(upstream);
    upstream.on("close", () => pending.delete(upstream));
    upstream.on("error", () => {
      options.onBlocked({ method, url: raw, reason: "request-error" });
      if (!outgoing.headersSent && !outgoing.destroyed) {
        outgoing.writeHead(502); outgoing.end("Local target unavailable or TLS certificate rejected");
      } else outgoing.destroy();
    });
    incoming.on("aborted", () => upstream.destroy());
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  };
  const server = createServer(forward(false));
  const tlsServer = target.protocol === "https:" ? createTLSServer(await interceptionCertificate(), forward(true)) : undefined;
  const track = (socket: Duplex) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); };
  server.on("connection", track);
  tlsServer?.on("secureConnection", track);
  for (const listener of [server, ...(tlsServer ? [tlsServer] : [])]) {
    listener.on("upgrade", (req, socket) => {
      options.onBlocked({ method: "WEBSOCKET", url: req.url ?? "", reason: "websockets-unsupported" });
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    });
    listener.on("clientError", (_error, socket) => socket.destroy());
  }
  tlsServer?.on("tlsClientError", (_error, socket) => socket.destroy());
  server.on("connect", (req, socket, head) => {
    if (!tlsServer || req.url !== target.host) {
      options.onBlocked({ method: "CONNECT", url: req.url ?? "", reason: "off-origin" });
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"); return;
    }
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (head.length) socket.unshift(head);
    tlsServer.emit("connection", socket);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to start origin proxy");
  return {
    server: `http://127.0.0.1:${address.port}`, bypass: "<-loopback>",
    // Trust only the ephemeral browser-to-proxy leg. Upstream TLS validation remains independent.
    browserTLS: !!tlsServer,
    networkQuietFor: () => active.size ? 0 : Date.now() - lastActivity,
    async close() {
      for (const req of pending) req.destroy();
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections(); tlsServer?.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

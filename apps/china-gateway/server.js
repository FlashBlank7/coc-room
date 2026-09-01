// Dependency-free reverse proxy for testers who cannot reach workers.dev.
// Runs on any plain Node host (Azure App Service); forwards every HTTP
// request and WebSocket upgrade to the Cloudflare worker, adding
// X-Forwarded-Host so room invites point back at this gateway.
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");

const TARGET = process.env.COC_ROOM_UPSTREAM ?? "coc-room-relay.coc-room-relay.workers.dev";
const PORT = Number(process.env.PORT ?? 8080);

const HOP_BY_HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade", "host",
]);

function forwardHeaders(request) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) headers[name] = value;
  }
  headers.host = TARGET;
  headers["x-forwarded-host"] = request.headers.host ?? "";
  headers["x-forwarded-proto"] = "https";
  return headers;
}

const server = http.createServer((request, response) => {
  const upstream = https.request({
    hostname: TARGET,
    port: 443,
    path: request.url,
    method: request.method,
    headers: forwardHeaders(request),
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    response.end("gateway upstream error");
  });
  request.pipe(upstream);
});

// WebSocket upgrades: replay the handshake against the worker over TLS and
// then splice the sockets; the tunnel is protocol-agnostic after 101.
server.on("upgrade", (request, socket) => {
  const upstream = tls.connect({ host: TARGET, port: 443, servername: TARGET }, () => {
    const lines = [`GET ${request.url} HTTP/1.1`];
    const headers = forwardHeaders(request);
    headers.connection = "Upgrade";
    headers.upgrade = request.headers.upgrade ?? "websocket";
    for (const [name, value] of Object.entries(headers)) {
      for (const item of Array.isArray(value) ? value : [value]) lines.push(`${name}: ${item}`);
    }
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const drop = () => {
    upstream.destroy();
    socket.destroy();
  };
  upstream.on("error", drop);
  socket.on("error", drop);
});

server.listen(PORT, () => {
  console.log(`coc-room gateway listening on :${PORT}, upstream https://${TARGET}`);
});

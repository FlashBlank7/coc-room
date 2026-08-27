# CoC Room Relay

Cloudflare Worker + SQLite-backed Durable Object for CoC Room's WebRTC signaling and fallback WebSocket relay. The room host is the only authority and all network routes form a star: host-to-player or player-to-host.

## Privacy and persistence

The Durable Object persists only one `room_metadata` row containing the room ID, the reserved host peer ID, creation time, and SHA-256 digests of the host and join tokens. It never creates a chat, event, signal, or relay-payload table. Online peer metadata lives in hibernatable WebSocket attachments and disappears when each socket closes. The source contains no payload logging, and Wrangler observability is disabled by default.

This is not end-to-end encryption. Cloudflare and the operator can technically inspect frames while they are being relayed. Do not put tokens in URLs or logs.

## Run locally

Node.js 22 or newer and pnpm 9 are required by the current Wrangler and Cloudflare Vitest integration.

From the repository root:

```powershell
pnpm install
pnpm --filter @coc-room/relay dev
```

Wrangler uses `http://127.0.0.1:8787` by default. Store this HTTP(S) origin as the desktop client's relay base URL. Generate the host peer ID locally first, then reserve it when creating the room:

```powershell
Invoke-RestMethod -Method Post `
  -ContentType 'application/json' `
  -Body '{"hostPeerId":"host-peer"}' `
  http://127.0.0.1:8787/v1/rooms
```

The response contains secrets and uses `Cache-Control: no-store`:

```json
{
  "protocolVersion": 1,
  "roomId": "generated-room-id",
  "hostPeerId": "host-peer",
  "hostToken": "private-host-token",
  "joinToken": "shared-player-token",
  "websocketUrl": "ws://127.0.0.1:8787/v1/rooms/generated-room-id/ws"
}
```

`websocketUrl` is the complete room URL, not a base URL. A production HTTPS request returns a corresponding `wss://` URL. Connect to it and send the `join` frame below after the socket opens.

The first WebSocket text frame must be a `join` message. An upgraded socket has
15 seconds to authenticate; its deadline is stored in the hibernatable socket
attachment, and the Durable Object alarm closes it if the deadline expires.
Stale pending sockets are also swept whenever a connection or message arrives,
so they cannot permanently consume the pending-connection allowance.

```json
{
  "kind": "join",
  "protocolVersion": 1,
  "roomId": "the returned roomId",
  "token": "the returned hostToken or joinToken",
  "peerId": "the returned hostPeerId",
  "displayName": "Investigator",
  "role": "host"
}
```

Use the private `hostToken` only for the host and reconnect with the same reserved `hostPeerId`. A player cannot join with that peer ID, even while the host is offline. Share the `roomId` and `joinToken` with players. Tokens are sent in the first WebSocket frame, never in a query string. Subsequent client message types are:

- `presence`: `{ "kind": "presence", "status": "online" | "away" }`
- `signal`: `{ "kind": "signal", "targetPeerId": "peer-id", "data": ... }`
- `relay`: `{ "kind": "relay", "targetPeerId": "peer-id", "payload": ... }`
- `leave`: `{ "kind": "leave" }`

The first server message is `ready`; later messages are `presence`, `signal`, `relay`, or `error`. `signal` and `relay` identify their sender with `fromPeerId`. A disconnect is a `presence` event with `action: "left"`.

Only UTF-8 JSON text frames are accepted. A frame is at most 65,536 bytes. A routed message may need slightly smaller chunks because the server adds its envelope. The room permits one host and seven players. Literal `ping` frames receive `pong` without waking a hibernated object.

## Test and deploy

```powershell
pnpm --filter @coc-room/relay check
pnpm --filter @coc-room/relay test
pnpm --filter @coc-room/relay build
pnpm --filter @coc-room/relay smoke
```

`smoke` 默认连接本机 `http://127.0.0.1:8787`，会创建一个临时房间，以真实 WebSocket 分别加入房主和玩家，并验证双向中继。验收部署后的节点时传入 HTTPS 根地址：

```powershell
pnpm --filter @coc-room/relay smoke -- https://your-worker.your-subdomain.workers.dev
```

Tests use Cloudflare's Vitest plugin and the local `workerd` runtime. WebSocket tests run with one worker and shared storage because isolated per-file storage does not support Durable Object WebSockets.

To self-host:

1. Create a Cloudflare account and authenticate once with `pnpm --filter @coc-room/relay exec wrangler login`.
2. Change `name` in `wrangler.jsonc` if the default Worker name is unavailable.
3. Run `pnpm --filter @coc-room/relay deploy`.
4. Configure the desktop client's relay base URL to the deployed `https://<worker>.<subdomain>.workers.dev` origin.

The `v1` Wrangler migration creates `RelayRoom` with the SQLite storage backend. Keep that migration entry when renaming the Worker. If the Durable Object class itself is renamed later, add a new Wrangler rename migration rather than editing the deployed `v1` tag.

For a public deployment, add Cloudflare rate limiting to `POST /v1/rooms` and the WebSocket route. The application deliberately has no account system and no server-side transcript recovery.

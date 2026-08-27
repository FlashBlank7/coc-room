# @coc-room/protocol

Shared, runtime-validated protocol primitives for CoC Room. The package is
environment-neutral and can be used by the Tauri webview, Cloudflare Workers,
and Node-based tooling.

```ts
import {
  EventReplica,
  HostEventSequencer,
  commandToEventDraft,
  exportEventsToHtml,
  roomCommandSchema,
} from "@coc-room/protocol";

const command = roomCommandSchema.parse(untrustedWireValue);
const hostLog = new HostEventSequencer(command.roomId);
const { event } = hostLog.commit(commandToEventDraft(command));

const replica = new EventReplica(event.roomId);
replica.apply(event);
const html = exportEventsToHtml(replica.orderedEvents());
```

The public entry point also exports:

- Zod schemas and inferred types for `RoomEventV1`, `RoomCommandV1`, relay
  envelopes, CoC 7e character sheets, and `ModulePackageV1`.
- Secure, injectable dice helpers (`rollDice`, `rollPercentile`,
  `resolveCheck`).
- Byte-bounded UTF-8 synchronization chunks and an out-of-order collector.
- Markdown and script-free, self-contained HTML transcript exporters.

All wire values must be parsed at the trust boundary. The host is the only
authority that assigns event IDs, timestamps, and monotonically increasing
sequence numbers.

## Development

```sh
pnpm check
pnpm test
pnpm build
```

Licensed under the MIT License.

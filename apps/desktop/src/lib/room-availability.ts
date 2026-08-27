import type { ParticipantV1 } from "@coc-room/protocol";
import type { RoomRecord } from "../data/repository";
import type { ConnectionPath } from "../network/RoomTransport";

/**
 * A host never depends on its own relay presence entry. Players, however, may
 * only issue authoritative commands while the declared host is present.
 */
export function isRoomHostAvailable(
  room: RoomRecord,
  participants: readonly ParticipantV1[],
  hostPath?: ConnectionPath,
): boolean {
  if (room.localRole === "host") return true;
  if (hostPath === "offline") return false;
  return participants.some(
    (participant) => participant.peerId === room.hostPeerId && participant.role === "host",
  );
}

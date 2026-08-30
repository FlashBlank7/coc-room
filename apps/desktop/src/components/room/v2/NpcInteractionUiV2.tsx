import { useEffect, useMemo, useState } from "react";
import {
  isAudienceMemberV2,
  type AudienceV2,
  type Coc7Character,
  type NpcSessionMessageV2,
  type RoomEntityV2,
  type SeatV2,
} from "@coc-room/protocol";

import { Button } from "../../ui/Button";

export interface NpcSessionStartDialogV2Props {
  readonly npc: RoomEntityV2;
  readonly seats: readonly SeatV2[];
  readonly busy?: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: (audience: AudienceV2) => void;
}

/**
 * Makes the irreversible recipient choice explicit before the first panel
 * event is published. A session may be narrower than its NPC, but never
 * broader: seats that cannot see the NPC are not offered here.
 */
export function NpcSessionStartDialogV2({
  npc,
  seats,
  busy = false,
  onCancel,
  onConfirm,
}: NpcSessionStartDialogV2Props) {
  const eligiblePlayers = useMemo(() => seats.filter((seat) =>
    seat.role === "player" && isAudienceMemberV2(npc.audience, seat),
  ), [npc.audience, seats]);
  const canUseRoomAudience = npc.audience.kind === "room";
  const [mode, setMode] = useState<"room" | "seats">(canUseRoomAudience ? "room" : "seats");
  const [selectedSeatIds, setSelectedSeatIds] = useState<string[]>(() =>
    canUseRoomAudience ? [] : eligiblePlayers.map(({ seatId }) => seatId),
  );

  useEffect(() => {
    setMode(canUseRoomAudience ? "room" : "seats");
    setSelectedSeatIds(canUseRoomAudience ? [] : eligiblePlayers.map(({ seatId }) => seatId));
  }, [canUseRoomAudience, eligiblePlayers, npc.entityId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || busy) return;
      event.preventDefault();
      onCancel();
    };
    globalThis.addEventListener("keydown", handleKeyDown);
    return () => globalThis.removeEventListener("keydown", handleKeyDown);
  }, [busy, onCancel]);

  const toggleSeat = (seatId: string) => {
    setSelectedSeatIds((current) => current.includes(seatId)
      ? current.filter((candidate) => candidate !== seatId)
      : [...current, seatId]);
  };
  const selectedPlayers = eligiblePlayers.filter(({ seatId }) => selectedSeatIds.includes(seatId));
  const canConfirm = !busy && (mode === "room" ? canUseRoomAudience : selectedPlayers.length > 0);

  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/75 p-4" role="presentation">
    <section
      role="dialog"
      aria-modal="true"
      aria-labelledby="npc-session-start-title"
      aria-describedby="npc-session-start-help"
      className="w-full max-w-lg rounded-2xl border border-zinc-700 bg-zinc-950 p-5 shadow-2xl"
    >
      <h2 id="npc-session-start-title" className="font-serif text-xl text-ink">开始与 {npc.name} 交谈</h2>
      <p id="npc-session-start-help" className="mt-2 text-xs leading-5 text-zinc-400">
        先决定谁能进入这段交谈。面板消息、NPC 回复和状态记录只会发给这里选中的席位与 KP；创建后不能从已收到记录的玩家手里撤回。
      </p>

      <fieldset className="mt-4 grid gap-2">
        <legend className="mb-1 text-xs font-semibold text-zinc-300">这段交谈对谁开放？</legend>
        <label className={`flex items-start gap-3 rounded-lg border p-3 ${canUseRoomAudience ? "cursor-pointer border-zinc-700" : "cursor-not-allowed border-zinc-900 opacity-50"}`}>
          <input
            type="radio"
            name="npc-session-audience"
            value="room"
            checked={mode === "room"}
            disabled={!canUseRoomAudience || busy}
            onChange={() => setMode("room")}
          />
          <span>
            <strong className="block text-sm text-zinc-100">房间公开交谈</strong>
            <span className="mt-1 block text-xs leading-5 text-zinc-500">所有已认证席位都能进入并看到这里的后续消息。</span>
          </span>
        </label>
        <label className={`flex items-start gap-3 rounded-lg border p-3 ${eligiblePlayers.length > 0 ? "cursor-pointer border-zinc-700" : "cursor-not-allowed border-zinc-900 opacity-50"}`}>
          <input
            type="radio"
            name="npc-session-audience"
            value="seats"
            checked={mode === "seats"}
            disabled={eligiblePlayers.length === 0 || busy}
            onChange={() => setMode("seats")}
          />
          <span>
            <strong className="block text-sm text-zinc-100">定向交谈</strong>
            <span className="mt-1 block text-xs leading-5 text-zinc-500">只有选中的调查员席位与 KP 能收到正文，其他席位只保留无内容的顺序占位。</span>
          </span>
        </label>
      </fieldset>

      {mode === "seats" && <fieldset className="mt-3 rounded-lg bg-zinc-900/60 p-3">
        <legend className="px-1 text-xs font-semibold text-zinc-300">邀请哪些调查员？</legend>
        {eligiblePlayers.length === 0
          ? <p className="text-xs leading-5 text-amber-300">当前没有既能看见这位 NPC、又可加入交谈的调查员席位。</p>
          : <div className="grid gap-2">{eligiblePlayers.map((seat) => <label key={seat.seatId} className="flex items-center gap-2 text-sm text-zinc-200">
              <input
                type="checkbox"
                aria-label={`邀请 ${seat.displayName} 加入交谈`}
                checked={selectedSeatIds.includes(seat.seatId)}
                disabled={busy}
                onChange={() => toggleSeat(seat.seatId)}
              />
              <span>{seat.displayName}</span>
              <span className="text-[10px] text-zinc-600">{seat.peerId ? "在线" : "离线，可稍后进入"}</span>
            </label>)}</div>}
      </fieldset>}

      <p role="status" aria-label="NPC 交谈可见范围摘要" className="mt-4 rounded-lg bg-zinc-900/60 px-3 py-2 text-xs leading-5 text-zinc-400">
        {mode === "room"
          ? "将公开给房间所有人，KP 也在其中。"
          : selectedPlayers.length > 0
            ? `仅 KP、${selectedPlayers.map(({ displayName }) => displayName).join("、")}可以进入。`
            : "至少选择一位调查员后才能创建定向交谈。"}
      </p>
      {!canUseRoomAudience && <p className="mt-2 text-[11px] leading-5 text-amber-300">这位 NPC 本身不是全房间可见，因此不能从这里建立公开交谈。</p>}

      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>取消</Button>
        <Button
          type="button"
          disabled={!canConfirm}
          onClick={() => onConfirm(mode === "room"
            ? { kind: "room" }
            : { kind: "seats", seatIds: selectedPlayers.map(({ seatId }) => seatId) })}
        >
          {busy ? "正在创建…" : mode === "room" ? "创建公开交谈" : "创建定向交谈"}
        </Button>
      </div>
    </section>
  </div>;
}

export function npcSessionAudienceLabelV2(audience: AudienceV2, seats: readonly SeatV2[]): string {
  if (audience.kind === "room") return "房间所有人可见";
  if (audience.kind === "host") return "仅 KP 可见";
  const displayNames = audience.seatIds.flatMap((seatId) => {
    const displayName = seats.find((seat) => seat.seatId === seatId)?.displayName;
    return displayName ? [displayName] : [];
  });
  const unnamedCount = audience.seatIds.length - displayNames.length;
  const recipients = [
    ...displayNames,
    ...(unnamedCount > 0 ? [`${unnamedCount} 位指定调查员`] : []),
  ];
  return `仅 KP、${recipients.join("、")}可见`;
}

export function npcPanelSpeakerLabelV2(
  message: NpcSessionMessageV2,
  npcName: string | undefined,
  seats: readonly SeatV2[],
  characters: ReadonlyMap<string, Coc7Character>,
): string {
  if (message.role === "npc") return npcName ?? "NPC";
  if (message.role === "system") return "系统";

  const seatId = message.speakerSeatId;
  const seatName = message.speakerDisplayName
    ?? seats.find((seat) => seat.seatId === seatId)?.displayName;
  const ownedCharacters = [...characters.values()].filter(({ ownerPeerId }) => ownerPeerId === seatId);
  if (ownedCharacters.length === 1) {
    const characterName = ownedCharacters[0]!.name;
    return seatName && seatName !== characterName ? `${characterName}（${seatName}）` : characterName;
  }
  return seatName ?? `席位 ${shortSeatId(seatId)}`;
}

function shortSeatId(seatId: string | undefined): string {
  if (!seatId) return "未知";
  return seatId.length <= 10 ? seatId : `${seatId.slice(0, 6)}…${seatId.slice(-4)}`;
}

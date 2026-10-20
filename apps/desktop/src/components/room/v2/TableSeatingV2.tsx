import { useEffect, useRef, useState } from "react";
import type { Coc7Character, RoomEventProposalV2, RoomWorldStateV2, SeatV2, TableSeatV2 } from "@coc-room/protocol";
import type { RoomSessionV2 } from "../../../network/RoomSessionV2";
import { getRepository, type PersonalCharacterV2 } from "../../../data/repository";
import { useAppStore } from "../../../store/app-store";
import { auditCharacterCreation, characterPromptWithBriefing, currentCharacterBriefing } from "../../../lib/character-creation-guidance";
import { cardForTable, prepareGeneratedCharacter } from "../../../lib/table-seating";
import { Button } from "../../ui/Button";
import { Input } from "../../ui/Field";

export function TableSeatingV2({ session, world, participants, disabled, requestCharacterDraft, aiDraftStage }: {
  session: RoomSessionV2; world: RoomWorldStateV2; participants: readonly SeatV2[]; disabled?: boolean;
  requestCharacterDraft?: (prompt: string, playerName: string) => Promise<Coc7Character>; aiDraftStage?: string;
}) {
  const [library, setLibrary] = useState<PersonalCharacterV2[]>([]);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const inFlight = useRef(false);
  const alive = useRef(true);
  const latestWorld = useRef(world); latestWorld.current = world;
  const positions = [...(world.tableSeats?.values() ?? [])];
  const availableCards = [...new Map([
    ...[...world.latestCharacters.values()].filter((card) => card.ownerPeerId === session.localSeat.seatId && !positions.some((seat) => seat.characterId === card.id)).map((character): [string, PersonalCharacterV2] => [character.id, { characterId: character.id, revision: 1, character, privateNotes: "", createdAt: character.updatedAt, updatedAt: character.updatedAt }]),
    ...library.map((record): [string, PersonalCharacterV2] => [record.characterId, record]),
  ]).values()];
  const myPosition = positions.find((item) => item.occupantSeatId === session.localSeat.seatId);
  const briefing = currentCharacterBriefing(world);
  useEffect(() => {
    alive.current = true;
    void getRepository().then((repository) => repository.listPersonalCharactersV2()).then((cards) => { if (alive.current) setLibrary(cards); }).catch((cause) => { if (alive.current) setError(String(cause)); });
    return () => { alive.current = false; };
  }, []);
  const run = async (id: string, action: () => Promise<unknown>) => {
    if (disabled || inFlight.current) return;
    inFlight.current = true; setBusy(id); setError(undefined); setNotice(undefined);
    try { await action(); } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { inFlight.current = false; if (alive.current) setBusy(undefined); }
  };
  const submit = (proposal: RoomEventProposalV2) => session.submitConfirmed(proposal);
  const assign = async (seat: TableSeatV2, character: Coc7Character | null) => {
    const previous = seat.characterId ? latestWorld.current.latestCharacters.get(seat.characterId) : undefined;
    if (previous && previous.id !== character?.id) {
      const repository = await getRepository();
      const records = await repository.listPersonalCharactersV2();
      const existing = records.find((record) => record.characterId === previous.id);
      const now = new Date().toISOString();
      await repository.savePersonalCharacterV2({ ...existing, characterId: previous.id, revision: (existing?.revision ?? 0) + 1, character: previous, privateNotes: existing?.privateNotes ?? "", createdAt: existing?.createdAt ?? now, updatedAt: now });
      if (alive.current) setLibrary(await repository.listPersonalCharactersV2());
    }
    await submit({ type: "table.seat.character.assigned", audience: { kind: "room" }, payload: { tableSeatId: seat.tableSeatId, character } });
    if (previous && previous.id !== character?.id && alive.current) setNotice(`“${previous.name}”已存入你的角色库，可再次放回座位。`);
  };
  const generate = async (seat: TableSeatV2) => {
    if (!requestCharacterDraft || !briefing) return;
    const playerName = participants.find((item) => item.seatId === seat.occupantSeatId)?.displayName ?? session.localSeat.displayName;
    const generated = prepareGeneratedCharacter(await requestCharacterDraft(characterPromptWithBriefing(`为${seat.name}创建一名适合本团时代、公开背景和调查动机的调查员。完整填写属性、职业、技能及人物背景，供玩家认领后修改。`, briefing), playerName), briefing);
    const character = cardForTable(generated, seat, latestWorld.current, true);
    const repository = await getRepository();
    const now = new Date().toISOString();
    await repository.savePersonalCharacterV2({ characterId: character.id, revision: 1, character, privateNotes: "", createdAt: now, updatedAt: now });
    if (!alive.current) return;
    setLibrary(await repository.listPersonalCharactersV2());
    const currentSeat = latestWorld.current.tableSeats.get(seat.tableSeatId);
    if (!currentSeat || currentSeat.occupantSeatId !== seat.occupantSeatId || currentSeat.characterId !== seat.characterId) throw new Error("生成期间座位发生了变化。新卡已保存到你的角色库，请重新选择放置位置。");
    await assign(currentSeat, character);
    setNotice(`“${character.name}”已放在${seat.name}，也已存入你的角色库。可打开详细车卡调整点数与背景。`);
  };
  return <section id="room-table-seats" aria-label="调查员座位" className="mx-auto mb-5 max-w-4xl scroll-mt-4 rounded-xl border border-zinc-700 bg-zinc-950/40 p-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-serif text-lg text-ink">调查员座位</h2><p className="mt-1 text-xs leading-5 text-zinc-400">{session.isHost ? "先添加座位，可以提前放好角色卡。玩家通过邀请进房后，自行选择空位。" : "选一个空位入座。你可以修改座位上的卡，也可以从自己的角色库带入。断线会保留你的座位。"}</p></div>
      {session.isHost && <Button variant="secondary" disabled={disabled || Boolean(busy) || positions.length >= 7} onClick={() => void run("new", () => submit({ type: "table.seat.updated", audience: { kind: "room" }, payload: { tableSeatId: crypto.randomUUID(), name: `座位 ${positions.length + 1}` } }))}>添加座位</Button>}
    </div>
    {positions.length === 0 && <p className="mt-3 text-sm text-zinc-400">{session.isHost ? "还没有座位。添加后即可放卡，不用等玩家上线。" : "KP 还没有设置座位。"}</p>}
    <div className="mt-3 grid gap-3 sm:grid-cols-2">{positions.map((seat) => {
      const character = seat.characterId ? world.latestCharacters.get(seat.characterId) : undefined;
      const mine = seat.occupantSeatId === session.localSeat.seatId;
      const canManage = session.isHost || mine;
      const occupant = participants.find((item) => item.seatId === seat.occupantSeatId);
      const issues = character ? auditCharacterCreation(character, briefing).issues : [];
      return <article key={seat.tableSeatId} aria-label={seat.name} className="rounded-lg border border-zinc-800 bg-panel p-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-medium text-ink">{seat.name}</h3><span className="text-xs text-zinc-400">{mine ? "我的座位" : seat.occupantSeatId ? occupant?.displayName ?? "已被认领" : "空位 · 可认领"}</span></div>
        {session.isHost && <details className="mt-1 text-xs text-zinc-400"><summary className="cursor-pointer">修改座位名称</summary><SeatName seat={seat} disabled={disabled || Boolean(busy)} onSave={(name) => void run(seat.tableSeatId, () => submit({ type: "table.seat.updated", audience: { kind: "room" }, payload: { tableSeatId: seat.tableSeatId, name } }))} /></details>}
        <p className="mt-3 text-sm">{character ? `${character.name} · ${character.occupation || "职业待填写"}` : "尚未放置角色卡"}</p>
        {character?.background.personalDescription && <p className="mt-1 line-clamp-3 whitespace-pre-wrap text-xs text-zinc-400">{character.background.personalDescription}</p>}
        {issues.length > 0 && <p className="mt-2 text-xs text-amber-300">车卡待调整：{issues[0]}{issues.length > 1 ? `（共 ${issues.length} 项）` : ""}</p>}
        <div className="mt-3 flex flex-wrap gap-2">
          {!session.isHost && !seat.occupantSeatId && !myPosition && <Button disabled={disabled || Boolean(busy)} onClick={() => void run(seat.tableSeatId, () => submit({ type: "table.seat.claimed", audience: { kind: "room" }, payload: { tableSeatId: seat.tableSeatId } }))}>坐在这里</Button>}
          {canManage && <Button variant="secondary" disabled={disabled || Boolean(busy)} onClick={() => useAppStore.getState().openTableCharacter(world.roomId!, seat.tableSeatId)}>{character ? "查看并修改角色卡" : "详细车卡"}</Button>}
          {canManage && !character && <Button variant="secondary" disabled={disabled || Boolean(busy) || !requestCharacterDraft || !briefing} onClick={() => void run(seat.tableSeatId, () => generate(seat))}>{busy === seat.tableSeatId ? aiDraftStage || "正在生成…" : "按模组背景 AI 车卡"}</Button>}
          {canManage && seat.occupantSeatId && <Button variant="ghost" disabled={disabled || Boolean(busy)} onClick={() => void run(seat.tableSeatId, () => submit({ type: "table.seat.released", audience: { kind: "room" }, payload: { tableSeatId: seat.tableSeatId } }))}>{mine ? "离开座位" : "腾出座位"}</Button>}
        </div>
        {canManage && <LibraryPicker cards={availableCards} seat={seat} disabled={disabled || Boolean(busy)} onPlace={(card) => void run(seat.tableSeatId, () => assign(seat, cardForTable(card, seat, latestWorld.current, true)))} />}
        {canManage && !character && !briefing && <p className="mt-2 text-xs text-zinc-500">AI 车卡需要 KP 先确认本团公开背景。{session.isHost && <a href="#room-character-briefing" className="ml-1 text-brass underline" onClick={() => { const editor = document.getElementById("room-character-briefing"); if (editor instanceof HTMLDetailsElement) editor.open = true; }}>填写或采用模组车卡说明</a>}</p>}
        {canManage && character && <Button variant="ghost" className="mt-2 text-xs" disabled={disabled || Boolean(busy)} onClick={() => void run(seat.tableSeatId, () => assign(seat, null))}>从座位取下角色卡</Button>}
      </article>;
    })}</div>
    {busy && <p role="status" className="mt-3 text-xs text-brass">{aiDraftStage || "正在处理，请稍候…"}</p>}
    {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
    {notice && <p role="status" className="mt-3 text-sm text-brass">{notice}</p>}
  </section>;
}

function SeatName({ seat, disabled, onSave }: { seat: TableSeatV2; disabled?: boolean; onSave(name: string): void }) {
  const [name, setName] = useState(seat.name);
  useEffect(() => setName(seat.name), [seat.name]);
  return <div className="mt-2 flex gap-2"><Input aria-label={`${seat.name}的名称`} maxLength={80} value={name} onChange={(event) => setName(event.target.value)} disabled={disabled} /><Button variant="secondary" disabled={disabled || !name.trim() || name.trim() === seat.name} onClick={() => onSave(name.trim())}>保存名称</Button></div>;
}

function LibraryPicker({ cards, seat, disabled, onPlace }: { cards: PersonalCharacterV2[]; seat: TableSeatV2; disabled?: boolean; onPlace(card: Coc7Character): void }) {
  const [id, setId] = useState("");
  return <div className="mt-3 flex flex-wrap gap-2"><select className="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-900 p-2 text-xs" aria-label={`${seat.name}的角色库`} disabled={disabled} value={id} onChange={(event) => setId(event.target.value)}><option value="">{cards.length ? "从我的角色库选择…" : "角色库为空，可先详细车卡"}</option>{cards.map((record) => <option key={record.characterId} value={record.characterId}>{record.character.name} · {record.character.occupation}</option>)}</select><Button variant="secondary" disabled={disabled || !cards.some((record) => record.characterId === id)} onClick={() => { const card = cards.find((record) => record.characterId === id); if (card) onPlace(card.character); }}>{seat.characterId ? "换成这张卡" : "放到座位"}</Button></div>;
}

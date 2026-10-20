import { useEffect, useRef, useState } from "react";
import { getRepository } from "../../../data/repository";

/** Private room drafts survive navigation; typing never submits a room event. */
export function usePublicationDrafts(key: string, enabled: boolean) {
  const [state, setState] = useState({ key, values: {} as Record<string, string>, ready: false, error: "" });
  const current = useRef(state);
  const writes = useRef(Promise.resolve());
  current.current = state;
  useEffect(() => {
    let cancelled = false;
    if (!enabled) return;
    void (async () => {
      try {
        const saved = await (await getRepository()).getSetting(key);
        const parsed: unknown = saved ? JSON.parse(saved) : {};
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid draft");
        const values = Object.fromEntries(Object.entries(parsed).filter(([id, text]) => /^(npc|location|clue|scene|scene-name|phase):/u.test(id) && typeof text === "string" && text.length <= (id.startsWith("phase:") ? 300_000 : 100_000))) as Record<string, string>;
        if (!cancelled) setState({ key, values, ready: true, error: "" });
      } catch {
        if (!cancelled) setState({ key, values: {}, ready: true, error: "未能恢复本机公开文案草稿；已有房间内容不受影响。" });
      }
    })();
    return () => { cancelled = true; };
  }, [key, enabled]);

  const setText = (id: string, text: string) => {
    if (!enabled || current.current.key !== key || !current.current.ready) return;
    const next = { ...current.current, values: { ...current.current.values, [id]: text } };
    current.current = next;
    setState(next);
    writes.current = writes.current.then(async () => {
      await (await getRepository()).setSetting(key, JSON.stringify(next.values));
      setState((state) => state.key === key && state.error ? { ...state, error: "" } : state);
    }).catch(() => {
      setState((state) => state.key === key ? { ...state, error: "公开文案暂未保存到本机，请保留页面后重试；仍可确认发布。" } : state);
    });
  };
  return { values: state.key === key ? state.values : {}, ready: state.key === key && state.ready, error: state.key === key ? state.error : "", setText };
}

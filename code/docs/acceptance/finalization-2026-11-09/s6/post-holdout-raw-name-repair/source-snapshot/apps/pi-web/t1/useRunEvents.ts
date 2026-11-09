"use client";
import { useEffect, useState } from "react";

export interface RunEvent { seq: number; type: string; summary: string; stage: string; timestamp: string; fixture: boolean }
/** Generic SSE framing; unlike a fixed event-name list, this keeps every typed business event. */
export function useRunEvents(runId: string | null, workbench = false) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connection, setConnection] = useState("noSelectedTask");
  useEffect(() => {
    setEvents([]);
    if (!runId) { setConnection("noSelectedTask"); return; }
    const controller = new AbortController();
    let cursor = 0;
    async function connect() {
      while (!controller.signal.aborted) {
        try {
          setConnection(cursor ? "reconnecting" : "connecting");
          const response = await fetch(`/api/t1/${workbench ? "workbench/" : ""}runs/${encodeURIComponent(runId!)}/events?after=${cursor}`, { signal: controller.signal, cache: "no-store" });
          if (!response.ok || !response.body) throw new Error("stream_unavailable");
          setConnection("connected");
          const reader = response.body.getReader(), decoder = new TextDecoder();
          let pending = "";
          try {
            while (!controller.signal.aborted) {
              const { done, value } = await reader.read();
              if (done) break;
              pending += decoder.decode(value, { stream: true }).replaceAll("\r\n", "\n");
              let boundary;
              while ((boundary = pending.indexOf("\n\n")) >= 0) {
                const frame = pending.slice(0, boundary); pending = pending.slice(boundary + 2);
                const data = frame.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
                if (!data) continue;
                const value = JSON.parse(data) as RunEvent & { run_id?: string; detail?: { summary?: string; state?: string; controlled_fixture?: boolean } };
                if (value.run_id && value.run_id !== runId) continue;
                const event: RunEvent = { ...value, summary: value.summary ?? value.detail?.summary ?? value.type, stage: value.stage ?? value.detail?.state ?? "", fixture: value.fixture ?? value.detail?.controlled_fixture ?? false };
                if (!Number.isSafeInteger(event.seq) || event.seq <= cursor) continue;
                cursor = event.seq;
                setEvents(previous => [...previous.filter(item => item.seq !== event.seq), event].slice(-500));
              }
            }
          } finally { await reader.cancel().catch(() => {}); }
          if (!controller.signal.aborted) throw new Error("stream_closed");
        } catch {
          if (controller.signal.aborted) break;
          setConnection("reconnecting");
          await new Promise<void>(resolve => {
            const finish = () => { clearTimeout(timer); controller.signal.removeEventListener("abort", finish); resolve(); };
            const timer = window.setTimeout(finish, 1500);
            controller.signal.addEventListener("abort", finish, { once: true });
          });
        }
      }
    }
    void connect();
    return () => controller.abort();
  }, [runId, workbench]);
  return { events, connection };
}

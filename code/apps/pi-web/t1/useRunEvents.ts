"use client";
import { useEffect, useState } from "react";

export interface RunEvent { seq: number; type: string; summary: string; stage: string; timestamp: string; fixture: boolean }
/** Generic SSE framing; unlike a fixed event-name list, this keeps every typed business event. */
export function useRunEvents(runId: string | null) {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connection, setConnection] = useState("未选择任务");
  useEffect(() => {
    setEvents([]);
    if (!runId) { setConnection("未选择任务"); return; }
    const controller = new AbortController();
    let cursor = 0;
    async function connect() {
      while (!controller.signal.aborted) {
        try {
          setConnection(cursor ? "正在重连" : "正在连接");
          const response = await fetch(`/api/t1/runs/${encodeURIComponent(runId!)}/events?after=${cursor}`, { signal: controller.signal, cache: "no-store" });
          if (!response.ok || !response.body) throw new Error("stream_unavailable");
          setConnection("已连接");
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
                const event = JSON.parse(data) as RunEvent;
                if (!Number.isSafeInteger(event.seq) || event.seq <= cursor) continue;
                cursor = event.seq;
                setEvents(previous => [...previous.filter(item => item.seq !== event.seq), event].slice(-500));
              }
            }
          } finally { await reader.cancel().catch(() => {}); }
          if (!controller.signal.aborted) throw new Error("stream_closed");
        } catch {
          if (controller.signal.aborted) break;
          setConnection("连接中断，正在重连");
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
  }, [runId]);
  return { events, connection };
}

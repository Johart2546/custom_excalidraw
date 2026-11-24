import { useCallback, useEffect, useRef, useState } from "react";
import { Excalidraw } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import TableBuilder from "./TableBuilder.jsx";
import { attachCellText, buildGrid } from "./table.js";

const SAVE_DELAY = 900; // http fallback (no websocket)
const LIVE_DELAY = 300; // websocket push while several people edit
const ARM_DELAY = 1200; // ignore the onChange burst that follows the initial load
const SAVE_APP_STATE = ["viewBackgroundColor", "gridSize", "gridStep", "gridModeEnabled", "theme"];

function payloadFor(elements, appState, files) {
  const picked = {};
  for (const key of SAVE_APP_STATE) {
    if (appState && appState[key] !== undefined) picked[key] = appState[key];
  }
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "boards-server",
    elements,
    appState: picked,
    files: files || {},
  });
}

/**
 * Is `a` a newer revision of the same element than `b`?
 * Excalidraw bumps `version` on every edit and `versionNonce` breaks ties.
 */
function fresher(a, b) {
  const av = a?.version ?? 0;
  const bv = b?.version ?? 0;
  if (av !== bv) return av > bv;
  return ((a?.versionNonce ?? 0) >>> 0) > ((b?.versionNonce ?? 0) >>> 0);
}

/**
 * Merge two versions of the same board, element by element, so simultaneous
 * edits do not cancel each other out. Returns the merged list plus whether the
 * incoming scene actually changed anything.
 *
 * The local order is kept as the drawing order: reordering on every remote
 * update made both sides look different from each other and they would bounce
 * the same scene back and forth forever.
 */
function mergeElements(local, remote) {
  const byId = new Map(local.map((el) => [el.id, el]));
  const remoteIds = new Set(remote.map((el) => el.id));
  let changed = false;

  for (const el of remote) {
    const mine = byId.get(el.id);
    if (!mine || fresher(el, mine)) {
      byId.set(el.id, el);
      changed = true;
    }
  }

  // do we hold anything the sender does not? then our copy has to be published,
  // otherwise the next reload loses it
  const extra = local.some((el) => !remoteIds.has(el.id));
  if (!changed) return { elements: local, changed: false, extra };

  const merged = local.map((el) => byId.get(el.id));
  const placed = new Set(merged.map((el) => el.id));
  for (const el of remote) {
    if (!placed.has(el.id)) merged.push(byId.get(el.id));
  }
  return { elements: merged, changed: true, extra };
}

function readBoardId() {
  const match = window.location.pathname.match(/^\/b\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

function guestName() {
  try {
    const saved = window.localStorage.getItem("boards-name");
    if (saved) return saved;
    const name = `แขก ${Math.floor(10 + Math.random() * 90)}`;
    window.localStorage.setItem("boards-name", name);
    return name;
  } catch {
    return "แขก";
  }
}

const SCENE_EXT = ".excalidraw";

export default function App() {
  const boardId = useRef(readBoardId()).current;

  const [phase, setPhase] = useState("loading"); // loading | ready | error
  const [scene, setScene] = useState(null);
  const [fatal, setFatal] = useState(null);
  const [saveState, setSaveState] = useState("idle"); // idle | dirty | saving | saved | error
  const [panelOpen, setPanelOpen] = useState(false);
  const [selectedGrid, setSelectedGrid] = useState(null);
  const [peers, setPeers] = useState([]);
  const [live, setLive] = useState("connecting"); // connecting | open | closed
  const [copied, setCopied] = useState(false);

  const apiRef = useRef(null);
  const wsRef = useRef(null);
  const meRef = useRef(null);
  const pendingRef = useRef(null);
  const lastSavedRef = useRef(null);
  const lastSentRef = useRef(null);
  const timerRef = useRef(0);
  const armedAtRef = useRef(0);
  const remoteRef = useRef(null);
  const remoteTimerRef = useRef(0);
  const goneRef = useRef(false);

  /* ---------------------------------------------------------------- boot */

  useEffect(() => {
    let alive = true;

    (async () => {
      if (window.location.pathname === "/new") {
        const res = await fetch("/api/boards", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
        if (!res.ok) throw new Error(`สร้างกระดานไม่สำเร็จ (${res.status})`);
        const created = await res.json();
        window.location.replace(`/b/${encodeURIComponent(created.id)}`);
        return;
      }

      if (!boardId) throw new Error("ไม่มีรหัสกระดานใน URL");

      const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}`);
      if (!res.ok) throw new Error(`โหลดกระดาน ${boardId} ไม่ได้ (${res.status})`);
      const data = await res.json();
      if (!alive) return;
      armedAtRef.current = Date.now() + ARM_DELAY;
      lastSavedRef.current = payloadFor(data.elements || [], data.appState || {}, data.files || {});
      document.title = `${boardId} · Excalidraw boards`;
      setScene(data);
      setPhase("ready");
    })().catch((error) => {
      if (!alive) return;
      document.title = "ไม่พบกระดาน · Excalidraw boards";
      setFatal(error?.message || String(error));
      setPhase("error");
    });

    return () => {
      alive = false;
    };
  }, [boardId]);

  /* ---------------------------------------------------------------- saving */

  const saveOverHttp = useCallback(async () => {
    const body = pendingRef.current;
    if (!body || !boardId || goneRef.current) return;
    setSaveState("saving");
    try {
      const res = await fetch(`/api/boards/${encodeURIComponent(boardId)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      });
      if (!res.ok) throw new Error(await res.text());
      lastSavedRef.current = body;
      if (pendingRef.current === body) pendingRef.current = null;
      setSaveState("saved");
    } catch (error) {
      console.error("[save]", error);
      setSaveState("error");
    }
  }, [boardId]);

  const flush = useCallback(() => {
    const ws = wsRef.current;
    const body = pendingRef.current;
    if (!body || goneRef.current) return;
    if (ws && ws.readyState === 1) {
      lastSentRef.current = body;
      setSaveState("saving");
      ws.send(JSON.stringify({ type: "update", scene: JSON.parse(body) }));
      return;
    }
    void saveOverHttp();
  }, [saveOverHttp]);

  /** Queue a change: websocket first, plain HTTP when the socket is down. */
  const queueSave = useCallback(
    (elements, appState, files) => {
      if (!boardId || goneRef.current) return;
      const body = payloadFor(elements, appState, files);
      // Excalidraw fires onChange for cursor and selection movement too; without
      // this an identical body would re-arm the debounce forever and the save
      // would never actually happen.
      if (body === pendingRef.current) return;
      if (body === lastSavedRef.current || body === lastSentRef.current) {
        if (body === lastSavedRef.current) {
          pendingRef.current = null;
          setSaveState("saved");
        }
        return;
      }
      pendingRef.current = body;
      setSaveState("dirty");
      window.clearTimeout(timerRef.current);
      const ws = wsRef.current;
      timerRef.current = window.setTimeout(flush, ws && ws.readyState === 1 ? LIVE_DELAY : SAVE_DELAY);
    },
    [boardId, flush],
  );

  const onChange = useCallback(
    (elements, appState, files) => {
      if (Date.now() < armedAtRef.current) return;
      const selected = appState.selectedElementIds || {};
      let hit = null;
      for (const el of elements) {
        if (selected[el.id] && el.customData?.grid) {
          const g = el.customData.grid;
          const rects = elements.filter((x) => x.type === "rectangle" && x.customData?.grid === g);
          if (!rects.length) break;
          const width = Math.round(Math.max(...rects.map((x) => x.x + x.width)) - Math.min(...rects.map((x) => x.x)));
          const height = Math.round(Math.max(...rects.map((x) => x.y + x.height)) - Math.min(...rects.map((x) => x.y)));
          const first = rects[0].customData;
          hit = {
            grid: g,
            rows: Math.max(...rects.map((x) => x.customData?.r ?? 0)) + 1,
            cols: Math.max(...rects.map((x) => x.customData?.c ?? 0)) + 1,
            color: first.color,
            headerRow: first.headerRow,
            width,
            height,
          };
          break;
        }
      }
      setSelectedGrid((prev) => {
        if (!prev || !hit) return prev === hit ? prev : hit;
        const same =
          prev.grid === hit.grid &&
          prev.rows === hit.rows &&
          prev.cols === hit.cols &&
          prev.width === hit.width &&
          prev.height === hit.height;
        return same ? prev : hit;
      });
      queueSave(elements, appState, files);
    },
    [queueSave],
  );

  // flush on hide (covers tab close / switching away far more reliably than unload)
  useEffect(() => {
    const onHide = () => {
      if (document.visibilityState === "hidden") {
        window.clearTimeout(timerRef.current);
        flush();
      }
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", flush);
      window.clearTimeout(timerRef.current);
    };
  }, [flush]);

  /* ------------------------------------------------------------- realtime */

  /** Apply a scene that came from the other side of the websocket. */
  const applyRemote = useCallback((remote) => {
    const api = apiRef.current;
    if (!api || !remote) return;
    const state = api.getAppState();

    // never yank elements out from under a drag or an open text editor
    if (state.draggingElement || state.newElement || state.editingElement) {
      remoteRef.current = remote;
      window.clearTimeout(remoteTimerRef.current);
      remoteTimerRef.current = window.setTimeout(() => {
        const next = remoteRef.current;
        remoteRef.current = null;
        if (next) applyRemote(next);
      }, 250);
      return;
    }

    const local = api.getSceneElements();
    const merged = mergeElements(local, remote.elements || []);
    if (merged.changed) api.updateScene({ elements: merged.elements });

    const full = api.getSceneElements();
    const body = payloadFor(full, api.getAppState(), api.getFiles());
    window.clearTimeout(timerRef.current);
    pendingRef.current = null;

    if (merged.extra) {
      // the file on disk is the sender's scene, which lacks what we drew while
      // their update was in flight: publish ours on top of it
      lastSavedRef.current = payloadFor(remote.elements || [], api.getAppState(), api.getFiles());
      lastSentRef.current = null;
      queueSave(full, api.getAppState(), api.getFiles());
    } else {
      // nothing of ours is missing over there; treat the applied scene as saved
      // instead of bouncing it back. Excalidraw normalises elements as it
      // applies them, so both sides would otherwise look dirty forever.
      lastSavedRef.current = body;
      lastSentRef.current = body;
      setSaveState("saved");
    }
  }, [queueSave]);

  useEffect(() => {
    if (phase !== "ready" || !boardId) return undefined;

    let closed = false;
    let retry = 0;
    let reconnectTimer = 0;

    const connect = () => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${proto}//${window.location.host}/ws/board/${encodeURIComponent(boardId)}?name=${encodeURIComponent(guestName())}`;
      let ws;
      try {
        ws = new WebSocket(url);
      } catch {
        setLive("closed");
        return;
      }
      wsRef.current = ws;
      setLive("connecting");

      ws.onopen = () => {
        if (closed) return;
        retry = 0;
        setLive("open");
      };

      ws.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message.type === "welcome") {
          meRef.current = message.you;
        } else if (message.type === "presence") {
          setPeers(Array.isArray(message.peers) ? message.peers : []);
        } else if (message.type === "update") {
          applyRemote(message.scene);
        } else if (message.type === "saved") {
          if (lastSentRef.current) lastSavedRef.current = lastSentRef.current;
          pendingRef.current = null;
          setSaveState("saved");
        } else if (message.type === "save-failed") {
          setSaveState("error");
        } else if (message.type === "deleted") {
          // do not let a pending flush PUT the file straight back
          goneRef.current = true;
          window.clearTimeout(timerRef.current);
          window.clearTimeout(remoteTimerRef.current);
          pendingRef.current = null;
          setSaveState("idle");
          setFatal("กระดานนี้ถูกลบไปแล้ว");
        }
      };

      ws.onclose = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (closed) return;
        setLive("closed");
        setPeers([]);
        // whatever the socket did not confirm still has to reach the server
        if (pendingRef.current) void saveOverHttp();
        reconnectTimer = window.setTimeout(connect, Math.min(5000, 600 * 2 ** Math.min(retry, 4)));
        retry += 1;
      };

      ws.onerror = () => {};
    };

    connect();

    return () => {
      closed = true;
      window.clearTimeout(reconnectTimer);
      window.clearTimeout(remoteTimerRef.current);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) ws.close();
    };
  }, [phase, boardId, applyRemote, saveOverHttp]);

  /* grouped cells: a double-click isolates the cell inside the group instead of
     typing, so follow it with an Enter to start editing the bound text. */
  useEffect(() => {
    const onDoubleClick = () => {
      window.setTimeout(() => {
        const api = apiRef.current;
        if (!api) return;
        const state = api.getAppState();
        if (!state.editingGroupId) return;
        const ids = Object.keys(state.selectedElementIds || {});
        if (ids.length !== 1) return;
        const el = api.getSceneElements().find((item) => item.id === ids[0]);
        if (!el?.customData?.grid) return;
        const host = document.querySelector(".excalidraw") ?? document.body;
        host.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            code: "Enter",
            keyCode: 13,
            which: 13,
            bubbles: true,
            cancelable: true,
          }),
        );
      }, 60);
    };
    window.addEventListener("dblclick", onDoubleClick, true);
    return () => window.removeEventListener("dblclick", onDoubleClick, true);
  }, []);

  /* ---------------------------------------------------------------- tables */

  /* ------------------------------------------------------------- grid sizing */

  const gridElements = useCallback((gridId) => {
    const api = apiRef.current;
    if (!api) return [];
    return api.getSceneElements().filter((el) => el.customData?.grid === gridId);
  }, []);

  const applyGrid = useCallback(
    (meta, spec) => {
      const api = apiRef.current;
      if (!api) throw new Error("editor ยังไม่พร้อม");
      if (!meta?.grid) throw new Error("คลิกเลือกช่องในตารางก่อน");

      const all = api.getSceneElements();
      const mine = all.filter((el) => el.customData?.grid === meta.grid);
      if (!mine.length) throw new Error("ไม่พบตารางที่เลือก");

      const cells = mine.filter((el) => el.type === "rectangle");
      const originX = Math.min(...mine.map((el) => el.x));
      const originY = Math.min(...mine.map((el) => el.y));

      const byId = new Map(mine.map((el) => [el.id, el]));
      const cellIds = new Set(mine.filter((el) => el.type === "rectangle").map((el) => el.id));
      // a cell's text is bound by containerId, not by customData: pick up both
      // shapes so older boards (whose text lost customData) migrate cleanly
      const texts = new Map();
      for (const el of all) {
        if (el.type !== "text" || !el.text || !el.containerId) continue;
        if (!cellIds.has(el.containerId)) continue;
        const cellMeta = byId.get(el.containerId)?.customData;
        if (cellMeta) texts.set(`${cellMeta.r}:${cellMeta.c}`, el.text);
      }
      const staleText = new Set(
        all.filter((el) => el.type === "text" && el.containerId && cellIds.has(el.containerId)).map((el) => el.id),
      );

      const headEl = mine.find((el) => el.customData?.title);
      const subEl = mine.find((el) => el.customData?.subtitle);

      const { elements } = buildGrid({
        columns: spec.columns,
        rows: spec.rows,
        width: spec.width,
        height: spec.height,
        color: meta.color,
        headerRow: meta.headerRow,
        gridId: meta.grid,
        title: spec.title ?? headEl?.text ?? "",
        subtitle: spec.subtitle ?? subEl?.text ?? "",
      });

      const placed = elements.map((el) => ({ ...el, x: el.x + originX, y: el.y + originY }));
      // cells carry no text element until they hold something — restore the ones with text
      const restored = [];
      for (const el of placed) {
        if (el.type !== "rectangle" || !el.customData) continue;
        const value = texts.get(`${el.customData.r}:${el.customData.c}`);
        if (!value) continue;
        const { r, c } = el.customData;
        restored.push(
          attachCellText(el, value, {
            groupIds: el.groupIds ?? [],
            customData: { grid: meta.grid, r, c },
          }),
        );
      }
      const rebuilt = [...placed, ...restored];

      const firstCell = placed.find((el) => el.type === "rectangle");
      api.updateScene({
        elements: [
          ...all.filter((el) => el.customData?.grid !== meta.grid && !staleText.has(el.id)),
          ...rebuilt,
        ],
        appState: { selectedElementIds: firstCell ? { [firstCell.id]: true } : {} },
      });
      try {
        api.scrollToContent(rebuilt, { fitToContent: false, animate: true });
      } catch {
        /* nicety */
      }
      setSelectedGrid({ ...meta, rows: spec.rows, cols: spec.columns, width: spec.width, height: spec.height });
      queueSave(api.getSceneElements(), api.getAppState(), api.getFiles());
      return rebuilt.length;
    },
    [queueSave],
  );

  const growGrid = useCallback(
    (meta, axis) => {
      const mine = gridElements(meta?.grid);
      const cells = mine.filter((el) => el.type === "rectangle");
      if (!cells.length) throw new Error("คลิกเลือกช่องในตารางก่อน");
      const left = Math.min(...cells.map((el) => el.x));
      const top = Math.min(...cells.map((el) => el.y));
      const width = Math.max(...cells.map((el) => el.x + el.width)) - left;
      const height = Math.max(...cells.map((el) => el.y + el.height)) - top;
      const spec =
        axis === "row"
          ? { columns: meta.cols, rows: meta.rows + 1, width, height: height + height / meta.rows }
          : { columns: meta.cols + 1, rows: meta.rows, width: width + width / meta.cols, height };
      return applyGrid(meta, spec);
    },
    [applyGrid, gridElements],
  );

  const insertTable = useCallback(
    (spec) => {
      const api = apiRef.current;
      if (!api) throw new Error("editor ยังไม่พร้อม");

      const { elements: fresh } = buildGrid(spec);
      const current = api.getSceneElements();

      let right = -Infinity;
      for (const el of current) {
        if (el.isDeleted) continue;
        right = Math.max(right, el.x + (el.width || 0));
      }
      const offsetX = Number.isFinite(right) ? Math.round(right) + 120 : 0;
      const placed = fresh.map((el) => ({ ...el, x: el.x + offsetX }));

      api.updateScene({ elements: [...current, ...placed] });
      try {
        api.scrollToContent(placed, { fitToContent: false, animate: true });
      } catch {
        /* scrolling is a nicety */
      }

      queueSave(api.getSceneElements(), api.getAppState(), api.getFiles());
      return placed.length;
    },
    [queueSave],
  );

  /* ---------------------------------------------------------------- share */

  const copyLink = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      window.prompt("คัดลอกลิงก์นี้ไปให้คนอื่น", window.location.href);
    }
  }, []);

  /* ---------------------------------------------------------------- render */

  if (phase === "error") {
    return (
      <div className="fatal">
        <h1>เปิดกระดานไม่ได้</h1>
        <p>{fatal}</p>
        <a className="btn" href="/">
          ← กลับไปแกลเลอรี
        </a>
      </div>
    );
  }

  if (phase === "loading") {
    return <div className="fatal loading">กำลังโหลดกระดาน…</div>;
  }

  const others = peers.filter((p) => p.id !== meRef.current?.id);
  const liveLabel = live === "open" ? `${peers.length} คน` : live === "connecting" ? "กำลังเชื่อมต่อ…" : "ออฟไลน์";

  return (
    <div className={`shell${panelOpen ? " panel-open" : ""}`}>
      <header className="bar">
        <a className="btn ghost" href="/">
          ← Boards
        </a>
        <span className="board-id" title={boardId}>
          {boardId}
          {SCENE_EXT}
        </span>
        <span className={`save ${saveState}`}>
          {{ idle: "พร้อม", dirty: "ยังไม่บันทึก…", saving: "กำลังบันทึก…", saved: "บันทึกแล้ว ✓", error: "บันทึกไม่สำเร็จ" }[
            saveState
          ]}
        </span>

        <span
          className={`live ${live}`}
          title={others.length ? others.map((p) => p.name).join(", ") : "ยังไม่มีคนอื่นเข้ามาในกระดานนี้"}
        >
          <i style={{ background: live === "open" ? (others[0]?.color || "#3ecf8e") : "#6b6b75" }} />
          {live === "open" ? (
            <>
              {liveLabel}
              {others.length > 0 && <em>{others.map((p) => p.name).join(", ")}</em>}
            </>
          ) : (
            liveLabel
          )}
        </span>

        <span className="spacer" />
        <button className="btn ghost" type="button" onClick={copyLink}>
          {copied ? "คัดลอกแล้ว ✓" : "คัดลอกลิงก์"}
        </button>
        <a className="btn ghost" href={`/scenes/${encodeURIComponent(boardId)}.excalidraw`} download>
          ดาวน์โหลด
        </a>
        <button className={`btn${panelOpen ? " active" : ""}`} type="button" onClick={() => setPanelOpen((v) => !v)}>
          + ตาราง
        </button>
      </header>

      <div className="canvas">
        <Excalidraw
          initialData={{
            elements: scene.elements || [],
            appState: scene.appState || {},
            files: scene.files || {},
            scrollToContent: true,
          }}
          onChange={onChange}
          excalidrawAPI={(api) => {
            apiRef.current = api;
            window.__boardsApi = api; // handy for the e2e harness
          }}
        />
      </div>

      <TableBuilder
        open={panelOpen}
        onClose={() => setPanelOpen(false)}
        onInsert={insertTable}
        selected={selectedGrid}
        onUpdate={(spec) => applyGrid(selectedGrid, spec)}
        onGrow={(axis) => growGrid(selectedGrid, axis)}
      />
    </div>
  );
}

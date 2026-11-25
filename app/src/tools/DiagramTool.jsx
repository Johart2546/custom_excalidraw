import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { convertToExcalidrawElements } from "@excalidraw/excalidraw";
import { buildDiagram, measureSpec, mermaidToSpec } from "./diagram.js";

const DEFAULT_ENDPOINT = "http://aix-t-dgx-spark2.tailee5d4.ts.net:4000/v1/chat/completions";
const DEFAULT_MODEL = "coder";
const TIMEOUT_MS = 60000;

const AI_ENDPOINT = import.meta.env?.VITE_AI_ENDPOINT || DEFAULT_ENDPOINT;
const AI_MODEL = import.meta.env?.VITE_AI_MODEL || DEFAULT_MODEL;

const SYSTEM_PROMPT = [
  "You turn a short Thai or English description into a Mermaid flowchart.",
  "Answer with a single fenced code block that starts with ```mermaid and contains one `flowchart TD` diagram.",
  "Thai labels are fine. Use only A[Box], B(round), C{Decision}, A --> B and A -->|label| B syntax.",
  "No prose before or after the block, no extra code blocks, at most 12 nodes.",
].join("\n");

const ICON = { viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: 1.5, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true", focusable: "false" };

const IconDiagram = () => (
  <svg {...ICON} width={17} height={17}>
    <rect x="1.9" y="12.3" width="6.2" height="4.7" rx="1.3" />
    <rect x="11.9" y="12.3" width="6.2" height="4.7" rx="1.3" />
    <path d="M8.1 14.65h3.8" />
    <path d="M10 12.3V9.1" />
    <path d="M6.3 6.1 10 9.1l3.7-3" />
    <path d="M15.7 1.9l.5 1.4 1.4.5-1.4.5-.5 1.4-.5-1.4-1.4-.5 1.4-.5z" />
  </svg>
);

const IconClose = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true" focusable="false">
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

const STYLE = `
.ai-diagram-panel {
  position: fixed;
  left: 12px;
  top: 64px;
  bottom: 12px;
  z-index: 41;
  width: 320px;
  max-width: calc(100vw - 24px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.78), rgba(255, 255, 255, 0.56));
  backdrop-filter: var(--blur, blur(20px) saturate(155%));
  -webkit-backdrop-filter: var(--blur, blur(20px) saturate(155%));
  border: 1px solid var(--glass-line, rgba(255, 255, 255, 0.78));
  border-radius: 16px;
  box-shadow: 10px 14px 42px rgba(31, 36, 71, 0.16), var(--shadow, 0 12px 36px rgba(31, 36, 71, 0.11));
  color: var(--ink, #18181f);
  font: inherit;
}
.ai-diagram-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: none;
  height: 44px;
  padding: 0 8px 0 14px;
  border-bottom: 1px solid var(--line, rgba(24, 24, 39, 0.1));
}
.ai-diagram-title {
  font-size: 12px;
  font-weight: 600;
  letter-spacing: 0.02em;
}
.ai-diagram-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted, #64646f);
  cursor: pointer;
}
.ai-diagram-close:hover {
  background: rgba(255, 255, 255, 0.62);
  color: var(--ink, #18181f);
}
.ai-diagram-close:focus-visible {
  outline: 2px solid var(--accent, #6360d9);
  outline-offset: 1px;
}
.ai-diagram-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
  overflow-y: auto;
}
.ai-diagram-body label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11.5px;
  color: var(--muted, #64646f);
}
.ai-diagram-body textarea {
  width: 100%;
  padding: 7px 9px;
  border: 1px solid var(--line-strong, rgba(24, 24, 39, 0.16));
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.66);
  color: var(--ink, #18181f);
  font: inherit;
  font-size: 12.5px;
  line-height: 1.5;
  resize: vertical;
  min-height: 74px;
}
.ai-diagram-body textarea:focus {
  outline: none;
  border-color: var(--accent, #6360d9);
}
.ai-diagram-hint {
  margin: 0;
  font-size: 11.5px;
  line-height: 1.5;
  color: var(--muted, #64646f);
}
.ai-diagram-row {
  display: flex;
  gap: 8px;
}
.ai-diagram-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  min-height: 30px;
  padding: 0 10px;
  border: 1px solid var(--line-strong, rgba(24, 24, 39, 0.16));
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.72);
  color: var(--ink, #18181f);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
}
.ai-diagram-btn:hover:not(:disabled) {
  border-color: var(--accent, #6360d9);
  color: var(--accent, #6360d9);
}
.ai-diagram-btn:focus-visible {
  outline: 2px solid var(--accent, #6360d9);
  outline-offset: 1px;
}
.ai-diagram-btn:disabled {
  opacity: 0.55;
  cursor: default;
}
.ai-diagram-btn.primary {
  border-color: var(--accent, #6360d9);
  background: var(--accent-soft, rgba(99, 96, 217, 0.12));
  color: var(--accent, #6360d9);
  font-weight: 600;
}
.ai-diagram-status {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted, #64646f);
}
.ai-diagram-status[data-state="ok"] {
  color: var(--ok, #17915a);
}
.ai-diagram-status[data-state="bad"] {
  color: var(--bad, #cf3b3b);
}
.ai-diagram-raw {
  padding: 8px 10px;
  border: 1px solid var(--glass-line, rgba(255, 255, 255, 0.78));
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.48);
  font-size: 11.5px;
  color: var(--muted, #64646f);
}
.ai-diagram-raw summary {
  cursor: pointer;
}
.ai-diagram-raw pre {
  margin: 8px 0 0;
  max-height: 180px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px;
  line-height: 1.45;
  color: var(--ink, #18181f);
}
`;

function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : part?.text || ""))
      .join("\n");
  }
  return "";
}

function extractMermaid(raw) {
  const fenced = /```(?:mermaid)?[ \t]*\r?\n([\s\S]*?)```/i.exec(raw);
  return (fenced ? fenced[1] : raw).trim();
}

function sceneCenter(api) {
  const state = api.getAppState() || {};
  const zoom = state.zoom?.value || 1;
  const width = state.width || (typeof window === "undefined" ? 0 : window.innerWidth);
  const height = state.height || (typeof window === "undefined" ? 0 : window.innerHeight);
  const scrollX = Number.isFinite(state.scrollX) ? state.scrollX : 0;
  const scrollY = Number.isFinite(state.scrollY) ? state.scrollY : 0;
  return { x: width / (2 * zoom) - scrollX, y: height / (2 * zoom) - scrollY };
}

export default function DiagramTool({ apiRef, host, slot }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ kind: "idle", text: "" });
  const [rawText, setRawText] = useState("");
  const abortRef = useRef(null);
  const textareaRef = useRef(null);
  const panelRef = useRef(null);

  const close = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setBusy(false);
    setOpen(false);
  }, []);

  useEffect(() => {
    if (!open) return undefined;
    textareaRef.current?.focus();
    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        close();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, close]);

  useEffect(() => () => abortRef.current?.abort(), []);

  const generate = async () => {
    const api = apiRef?.current;
    if (!api) {
      setStatus({ kind: "bad", text: "กระดานยังโหลดไม่เสร็จ ลองใหม่อีกครั้ง" });
      return;
    }
    const text = prompt.trim();
    if (!text) {
      setStatus({ kind: "bad", text: "พิมพ์สิ่งที่ต้องการก่อน" });
      return;
    }

    setBusy(true);
    setRawText("");
    setStatus({ kind: "info", text: "กำลังถามโมเดลในเครื่อง…" });

    const controller = new AbortController();
    abortRef.current = controller;
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    };

    let response;
    try {
      response = await fetch(AI_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: AI_MODEL,
          temperature: 0.2,
          stream: false,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: text },
          ],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      cleanup();
      if (controller.signal.aborted) {
        setStatus({ kind: "bad", text: `โมเดลในเครื่องใช้เวลาเกิน ${TIMEOUT_MS / 1000} วินาที` });
      } else {
        setStatus({ kind: "bad", text: `ต่อโมเดลในเครื่องไม่ได้: ${error?.message || String(error)}` });
      }
      return;
    }

    let bodyText = "";
    try {
      bodyText = await response.text();
    } catch (error) {
      cleanup();
      setStatus({ kind: "bad", text: `อ่านคำตอบจากโมเดลไม่ได้: ${error?.message || String(error)}` });
      return;
    }

    if (!response.ok) {
      cleanup();
      setRawText(bodyText.trim());
      setStatus({ kind: "bad", text: `โมเดลตอบกลับผิดพลาด (HTTP ${response.status})` });
      return;
    }

    let body;
    try {
      body = JSON.parse(bodyText);
    } catch {
      cleanup();
      setRawText(bodyText.trim());
      setStatus({ kind: "bad", text: "โมเดลตอบกลับไม่ใช่ JSON — ข้อความดิบอยู่ด้านล่าง" });
      return;
    }

    const raw = messageText(body?.choices?.[0]?.message?.content).trim();
    if (!raw) {
      cleanup();
      setRawText(bodyText.trim());
      setStatus({ kind: "bad", text: "โมเดลไม่ได้ส่งคำตอบกลับมา" });
      return;
    }

    try {
      const mermaid = extractMermaid(raw);
      const spec = mermaidToSpec(mermaid);
      const bounds = measureSpec(spec);
      const center = sceneCenter(api);
      const origin = {
        x: center.x - bounds.width / 2,
        y: center.y - bounds.height / 2,
      };
      const skeletons = buildDiagram(mermaid, origin).elements;
      const elements = convertToExcalidrawElements(skeletons);
      const nodes = elements.filter((element) => element.type === "rectangle" || element.type === "diamond");
      const arrows = elements.filter((element) => element.type === "arrow");

      api.updateScene({
        elements: [...api.getSceneElements(), ...elements],
        appState: { selectedElementIds: {} },
      });
      api.scrollToContent(elements, { fitToContent: true });

      cleanup();
      setStatus({ kind: "ok", text: `แทรกไดอะแกรมแล้ว · ${nodes.length} โหนด · ${arrows.length} ลูกศร` });
    } catch (error) {
      cleanup();
      setRawText(raw);
      setStatus({ kind: "bad", text: `แปลงเป็นไดอะแกรมไม่ได้: ${error?.message || String(error)}` });
    }
  };

  const button = (
    <button
      type="button"
      className={`tools-table tools-diagram${open ? " active" : ""}`}
      onClick={() => setOpen((value) => !value)}
      aria-label="ข้อความเป็นไดอะแกรม"
      aria-pressed={open}
      title="พิมพ์สิ่งที่ต้องการ แล้วให้ AI (โมเดลในเครื่อง) วาดไดอะแกรมให้"
    >
      <IconDiagram />
    </button>
  );

  return (
    <>
      <style>{STYLE}</style>
      {host ? createPortal(button, host) : slot ? createPortal(button, slot) : null}
      {open && (
        <aside ref={panelRef} className="ai-diagram-panel" role="dialog" aria-label="ข้อความเป็นไดอะแกรม">
          <div className="ai-diagram-head">
            <span className="ai-diagram-title">ข้อความเป็นไดอะแกรม</span>
            <button type="button" className="ai-diagram-close" onClick={close} aria-label="ปิด" title="ปิด">
              <IconClose />
            </button>
          </div>
          <div className="ai-diagram-body">
            <label>
              อธิบายสิ่งที่ต้องการ
              <textarea
                ref={textareaRef}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="ขั้นตอนอนุมัติใบลา: พนักงานขอลา → หัวหน้าอนุมัติ → HR บันทึก"
                rows={4}
              />
            </label>
            <p className="ai-diagram-hint">
              AI ในเครื่องจะตอบกลับเป็น Mermaid แล้วแทรกเป็นกล่องและลูกศรตรงกลางจอ — ตรวจผลก่อนใช้เสมอ
            </p>
            <div className="ai-diagram-row">
              <button
                type="button"
                className="ai-diagram-btn primary"
                onClick={generate}
                disabled={busy || !prompt.trim()}
              >
                {busy ? "กำลังสร้าง…" : "สร้างไดอะแกรม"}
              </button>
              <button type="button" className="ai-diagram-btn" onClick={close}>
                ปิด
              </button>
            </div>
            {status.kind !== "idle" && (
              <p className="ai-diagram-status" data-state={status.kind} role="status">
                {status.text}
              </p>
            )}
            {status.kind === "bad" && rawText && (
              <details className="ai-diagram-raw">
                <summary>ข้อความดิบจากโมเดล</summary>
                <pre>{rawText}</pre>
              </details>
            )}
          </div>
        </aside>
      )}
    </>
  );
}

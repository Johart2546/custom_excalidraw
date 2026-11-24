#!/usr/bin/env node
/**
 * gallery/build.mjs — turn a folder of `.excalidraw` boards into a browsable catalog.
 *
 * Why this exists: the self-hosted Excalidraw image is a static frontend with no
 * storage of its own. Boards live as files; this script is the missing "index":
 * it scans gallery/scenes/, renders a PNG preview of each board, and writes a
 * static gallery page that nginx serves next to the app.
 *
 * Usage
 *   node gallery/build.mjs              # render missing/stale thumbnails, write site/
 *   node gallery/build.mjs --force      # re-render every thumbnail
 *   node gallery/build.mjs --no-render  # catalog only (thumbnails must exist)
 *
 * Per-scene metadata (optional)
 *   gallery/scenes/<name>.meta.json
 *     { "title": "...", "subtitle": "...", "tags": ["..."] }
 *   Without it the title is derived from the file name.
 *
 * Output (gallery/site/, mounted read-only at /site in the container)
 *   index.html            catalog page
 *   manifest.json         the same data, machine readable
 *   thumbs/<slug>.png     preview images
 *   scenes/<slug>.excalidraw   copies the app downloads / deep-links to
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(HERE, "..");
const SCENES = join(HERE, "scenes");
const SITE = join(HERE, "site");
const THUMBS = join(SITE, "thumbs");
const OUT_SCENES = join(SITE, "scenes");

const CLI = process.env.EXCALIDRAW_BIN || "excalidraw";
const FORCE = process.argv.includes("--force");
const NO_RENDER = process.argv.includes("--no-render");
const CONCURRENCY = Number(process.env.RENDER_CONCURRENCY || 2);
const THUMB_MAX_WIDTH = Number(process.env.THUMB_MAX_WIDTH || 1100);

/** Anything older than this is not a real "last edited" stamp (epoch ms). */
const MIN_PLAUSIBLE_MS = Date.UTC(2020, 0, 1);

/* --------------------------------------------------------------- utilities */

const pad = (n) => String(n).padStart(2, "0");

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** "inventory-board-2026-11-24" -> "Inventory board 2026 11 24" (readable fallback) */
function humanize(slug) {
  const words = slug.split("-").filter(Boolean);
  return words
    .map((w, i) => (i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function formatDay(ms) {
  const d = new Date(ms);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}

function formatDate(ms) {
  const d = new Date(ms);
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Read width/height straight out of a PNG's IHDR chunk. */
function pngSize(file) {
  try {
    const b = readFileSync(file);
    if (b.length < 24 || b.toString("ascii", 12, 16) !== "IHDR") return null;
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  } catch {
    return null;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* ------------------------------------------------------------------ scenes */

function collectScenes() {
  if (!existsSync(SCENES)) {
    throw new Error(`scenes folder not found: ${SCENES}`);
  }
  const names = readdirSync(SCENES);
  const scenes = names
    .filter((f) => extname(f) === ".excalidraw")
    .sort()
    .map((file) => {
      const path = join(SCENES, file);
      const slug = slugify(basename(file, ".excalidraw")) || "scene";
      const metaPath = join(SCENES, `${basename(file, ".excalidraw")}.meta.json`);
      let meta = {};
      if (existsSync(metaPath)) {
        try {
          meta = JSON.parse(readFileSync(metaPath, "utf8"));
        } catch (error) {
          process.stderr.write(`  ! ignoring bad ${basename(metaPath)}: ${error.message}\n`);
        }
      }
      return { file, path, slug, meta };
    });

  // A sidecar whose scene is gone is ignored (the scan below only sees
  // .excalidraw), but it lingers on disk — say so instead of leaving a puzzle.
  const ids = new Set(scenes.map((scene) => basename(scene.file, ".excalidraw")));
  for (const name of names) {
    if (!name.endsWith(".meta.json")) continue;
    const id = name.slice(0, -".meta.json".length);
    if (!ids.has(id)) {
      process.stderr.write(`  ! orphan ${name}: no ${id}.excalidraw (ignored)\n`);
    }
  }

  return scenes;
}

function describeScene(scene) {
  const raw = JSON.parse(readFileSync(scene.path, "utf8"));
  const elements = Array.isArray(raw.elements) ? raw.elements : [];
  const live = elements.filter((el) => !el.isDeleted);
  const frames = live.filter((el) => el.type === "frame").length;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of live) {
    minX = Math.min(minX, el.x ?? 0);
    minY = Math.min(minY, el.y ?? 0);
    maxX = Math.max(maxX, (el.x ?? 0) + (el.width ?? 0));
    maxY = Math.max(maxY, (el.y ?? 0) + (el.height ?? 0));
  }
  const hasBox = Number.isFinite(minX) && Number.isFinite(maxX);

  // Older boards carry `updated: 0` (or a seconds-based value), which would
  // render as "1 Jan 1970". Only trust element timestamps that look like
  // epoch milliseconds; otherwise fall back to the file's own mtime.
  const stamps = live
    .map((el) => el.updated ?? 0)
    .filter((t) => t >= MIN_PLAUSIBLE_MS);
  const updated = stamps.length ? Math.max(...stamps) : 0;

  return {
    elements: live.length,
    frames,
    width: hasBox ? Math.round(maxX - minX) : 0,
    height: hasBox ? Math.round(maxY - minY) : 0,
    size: statSync(scene.path).size,
    updated: updated || statSync(scene.path).mtimeMs,
  };
}

/* --------------------------------------------------------------- rendering */

function runProcess(cmd, args) {
  return new Promise((resolvePromise) => {
    let stderr = "";
    let child;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      resolvePromise({ ok: false, error: error.message });
      return;
    }
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => resolvePromise({ ok: false, error: error.message }));
    child.on("close", (code) =>
      resolvePromise({
        ok: code === 0,
        error: code === 0 ? "" : stderr.trim().split("\n").slice(-4).join("\n"),
      }),
    );
  });
}

async function renderThumbnail(scene, thumbPath) {
  const sceneAge = statSync(scene.path).mtimeMs;
  if (!FORCE && existsSync(thumbPath) && statSync(thumbPath).mtimeMs >= sceneAge) {
    return { ok: true, cached: true };
  }
  if (NO_RENDER) {
    return { ok: existsSync(thumbPath), cached: true };
  }
  const result = await runProcess(CLI, [
    "render",
    scene.path,
    "--out",
    thumbPath,
    "--max-width",
    String(THUMB_MAX_WIDTH),
    "--padding",
    "28",
  ]);
  return { ...result, cached: false };
}

/** Small worker pool so a handful of boards renders without spawning all at once. */
async function mapWithLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/* -------------------------------------------------------------------- page */

function renderPage(entries, generatedAt) {
  const ICON_DOWNLOAD =
    '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 4v11"/><path d="M7.5 11.5L12 16l4.5-4.5"/><path d="M5 20h14"/></svg>';
  const ICON_TRASH =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/></svg>';

  const cards = entries
    .map((entry) => {
      const href = `/b/${encodeURIComponent(entry.slug)}`;
      const download = `/scenes/${entry.slug}.excalidraw`;
      const preview = entry.thumb
        ? `<img src="/gallery/thumbs/${entry.slug}.png?${entry.mtime}" alt="" loading="lazy">`
        : `<span class="placeholder">ยังไม่มีภาพตัวอย่าง</span>`;
      const bits = [
        `${entry.elements} elements`,
        entry.frames ? `${entry.frames} frames` : null,
        entry.width ? `${entry.width}×${entry.height}` : null,
        `${entry.sizeLabel}`,
        formatDay(entry.updated),
      ].filter(Boolean);
      return `      <article class="card" data-slug="${escapeHtml(entry.slug)}" data-search="${escapeHtml(
        `${entry.title} ${entry.subtitle} ${entry.slug}`.toLowerCase(),
      )}">
        <a class="shot" href="${href}" aria-label="เปิด ${escapeHtml(entry.title)}">${preview}</a>
        <div class="body">
          <h2>${escapeHtml(entry.title)}</h2>
          ${entry.subtitle ? `<p class="sub">${escapeHtml(entry.subtitle)}</p>` : ""}
          <p class="meta" title="${escapeHtml(formatDate(entry.updated))}">${escapeHtml(bits.join(" · "))}</p>
          <div class="actions">
            <a class="primary" href="${href}">เปิด</a>
            <span class="grow"></span>
            <a class="iconbtn" href="${download}" download aria-label="ดาวน์โหลด ${escapeHtml(
              entry.title,
            )}" title="ดาวน์โหลด">${ICON_DOWNLOAD}</a>
            <button class="iconbtn danger del" type="button" data-id="${escapeHtml(
              entry.slug,
            )}" aria-label="ลบ ${escapeHtml(entry.title)}" title="ลบ">${ICON_TRASH}<span>ลบ</span></button>
          </div>
        </div>
      </article>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="th">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>Excalidraw boards</title>
<style>
  :root {
    color-scheme: light;
    --bg: #fafafa;
    --panel: #ffffff;
    --line: #e4e4e7;
    --ink: #1b1b1f;
    --muted: #6f6f78;
    --accent: #6965db;
    --accent-soft: #ecebfb;
    --danger: #b42323;
    --danger-line: #e8c2c2;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 26px 22px 44px;
    background: var(--bg);
    color: var(--ink);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans Thai", Inter, system-ui, sans-serif;
  }
  header { max-width: 1180px; margin: 0 auto 18px; }
  .top { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
  h1 { margin: 0; font-size: 19px; font-weight: 600; letter-spacing: -0.2px; }
  .count { color: var(--muted); font-size: 12.5px; white-space: nowrap; }
  .grow { flex: 1; }
  input[type="search"] {
    width: 220px; max-width: 100%; padding: 7px 11px; font: inherit; font-size: 13px;
    color: var(--ink); background: var(--panel);
    border: 1px solid var(--line); border-radius: 7px; outline: none;
  }
  input[type="search"]::placeholder { color: var(--muted); }
  input[type="search"]:focus { border-color: var(--accent); }
  .app-link {
    color: #fff; text-decoration: none; white-space: nowrap;
    background: var(--accent); border: 1px solid var(--accent);
    padding: 7px 12px; border-radius: 7px; font-size: 12.5px;
  }
  .app-link:hover { filter: brightness(.94); }
  .grid {
    max-width: 1180px; margin: 0 auto;
    display: grid; gap: 14px;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  }
  .card {
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--panel); border: 1px solid var(--line); border-radius: 11px;
    transition: border-color .14s ease, transform .14s ease;
  }
  .card:hover { border-color: color-mix(in srgb, var(--accent) 45%, var(--line)); }
  .shot {
    display: flex; align-items: center; justify-content: center;
    aspect-ratio: 16 / 10; padding: 10px; background: #fff; overflow: hidden;
  }
  .shot img { max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; }
  .placeholder { color: #a9a9b3; font-size: 12px; }
  .body { display: flex; flex-direction: column; gap: 3px; padding: 11px 12px 12px; }
  h2 { margin: 0; font-size: 14.5px; font-weight: 600; line-height: 1.35; }
  .sub { margin: 0; color: var(--muted); font-size: 12px; }
  .meta {
    margin: 0; color: var(--muted); font-size: 11.5px; line-height: 1.45;
    font-variant-numeric: tabular-nums; overflow-wrap: anywhere;
  }
  .actions { display: flex; align-items: center; gap: 6px; margin-top: 9px; }
  .primary {
    display: inline-flex; align-items: center; text-decoration: none;
    background: var(--accent); color: #fff; font-size: 12.5px;
    padding: 5px 12px; border-radius: 7px; border: 1px solid var(--accent);
  }
  .primary:hover { filter: brightness(.94); }
  .iconbtn {
    display: inline-flex; align-items: center; justify-content: center; gap: 4px;
    height: 27px; padding: 0 7px; border-radius: 7px; cursor: pointer;
    border: 1px solid var(--line); background: transparent; color: var(--muted);
    font: inherit; font-size: 12px; text-decoration: none;
    opacity: .78; transition: opacity .12s ease, border-color .12s ease, color .12s ease;
  }
  .card:hover .iconbtn, .card:focus-within .iconbtn { opacity: 1; }
  .iconbtn:hover { border-color: var(--accent); color: var(--ink); }
  .iconbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; opacity: 1; }
  .iconbtn.danger { color: var(--danger); border-color: var(--danger-line); }
  .iconbtn.danger:hover { border-color: var(--danger); }
  .iconbtn:disabled { opacity: .4; cursor: default; }
  @media (hover: none) {
    .iconbtn { opacity: 1; }
  }
  .modal {
    position: fixed; inset: 0; z-index: 50; display: grid; place-items: center;
    background: rgba(24, 24, 27, .42); padding: 20px;
  }
  .modal[hidden] { display: none; }
  .modal-card {
    width: min(400px, 100%); background: var(--panel); border: 1px solid var(--line);
    border-radius: 12px; padding: 20px 20px 14px;
  }
  .modal-card h2 { margin: 0 0 8px; font-size: 15.5px; }
  .modal-card p { margin: 0 0 16px; font-size: 12.5px; line-height: 1.55; color: var(--muted); }
  .modal-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
  .ghost {
    font: inherit; font-size: 12.5px; padding: 6px 12px; cursor: pointer;
    border-radius: 7px; border: 1px solid var(--line); background: transparent; color: var(--ink);
  }
  .ghost:hover { border-color: var(--accent); }
  .modal-hint { margin: 12px 0 0; font-size: 11.5px; color: var(--muted); text-align: right; }
  .holdbtn {
    position: relative; overflow: hidden; min-width: 168px; justify-content: center;
    display: inline-flex; align-items: center; padding: 6px 14px; border-radius: 7px;
    border: 1px solid var(--danger-line); background: transparent; color: var(--danger);
    font: inherit; font-size: 12.5px; cursor: pointer; user-select: none; touch-action: none;
  }
  .holdbtn .fill {
    position: absolute; left: 0; top: 0; bottom: 0; width: 0; pointer-events: none;
    background: rgba(255, 90, 90, .28);
  }
  .holdbtn .lbl { position: relative; }
  .holdbtn:disabled { cursor: default; }
  footer {
    max-width: 1180px; margin: 26px auto 0; color: var(--muted); font-size: 11px;
  }
  .empty { max-width: 1180px; margin: 38px auto; color: var(--muted); font-size: 13px; }
</style>
</head>
<body>
<header>
  <div class="top">
    <h1>Boards</h1>
    <span class="count" id="count">${entries.length} board${entries.length === 1 ? "" : "s"}</span>
    <span class="grow"></span>
    <input type="search" id="q" placeholder="ค้นหากระดาน…" aria-label="ค้นหากระดาน" autocomplete="off" spellcheck="false">
    <a class="app-link" href="/new">+ กระดานใหม่</a>
  </div>
</header>
<main class="grid" id="grid">
${cards}
</main>
<p class="empty" id="empty" hidden>ไม่พบกระดานที่ตรงกับชื่อนี้</p>
<footer>อัปเดต ${escapeHtml(generatedAt)}</footer>
<div class="modal" id="del-modal" hidden>
  <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="del-title">
    <h2 id="del-title">ลบกระดานนี้?</h2>
    <p id="del-detail"></p>
    <div class="modal-actions">
      <button class="ghost" type="button" id="del-cancel">ยกเลิก</button>
      <button class="holdbtn" type="button" id="del-hold">
        <span class="fill"></span><span class="lbl">กดค้างเพื่อลบ</span>
      </button>
    </div>
    <p class="modal-hint">กดปุ่มค้างไว้ประมาณ 1 วินาทีเพื่อยืนยัน</p>
  </div>
</div>
<script>
  const q = document.getElementById("q");
  const grid = document.getElementById("grid");
  const count = document.getElementById("count");
  const empty = document.getElementById("empty");
  // the same glyphs the built page uses, so cards added at runtime look identical
  const ICONS = {
    download: ${JSON.stringify(ICON_DOWNLOAD)},
    trash: ${JSON.stringify(ICON_TRASH)},
  };

  function applyFilter() {
    const cards = [...grid.querySelectorAll(".card")];
    const needle = q.value.trim().toLowerCase();
    let shown = 0;
    for (const card of cards) {
      const hit = !needle || (card.dataset.search || "").includes(needle);
      card.hidden = !hit;
      if (hit) shown += 1;
    }
    count.textContent = needle ? shown + " จาก " + cards.length : cards.length + " กระดาน";
    empty.hidden = shown !== 0;
  }

  function fmtSize(bytes) {
    if (bytes > 1024 * 1024) return (bytes / 1024 / 1024).toFixed(1) + " MB";
    return Math.round(bytes / 1024) + " KB";
  }

  q.addEventListener("input", applyFilter);

  // delete a board from the catalogue: custom dialog + hold-to-confirm button
  const modal = document.getElementById("del-modal");
  const detail = document.getElementById("del-detail");
  const holdBtn = document.getElementById("del-hold");
  const holdFill = holdBtn.querySelector(".fill");
  const holdLbl = holdBtn.querySelector(".lbl");
  const HOLD_MS = 1100;
  let pendingId = null;
  let holdRaf = 0;
  let holdStart = 0;
  let deleting = false;

  function openDelete(id) {
    pendingId = id;
    deleting = false;
    detail.textContent = id + ".excalidraw จะถูกลบถาวรพร้อมประวัติเซฟย้อนหลัง กู้คืนไม่ได้";
    holdFill.style.width = "0%";
    holdLbl.textContent = "กดค้างเพื่อลบ";
    holdBtn.disabled = false;
    modal.hidden = false;
    holdBtn.focus();
  }

  function closeDelete() {
    if (deleting) return;
    cancelAnimationFrame(holdRaf);
    holdRaf = 0;
    holdFill.style.width = "0%";
    modal.hidden = true;
    pendingId = null;
  }

  function stopHold() {
    if (deleting) return;
    cancelAnimationFrame(holdRaf);
    holdRaf = 0;
    holdFill.style.width = "0%";
  }

  function finishHold() {
    cancelAnimationFrame(holdRaf);
    holdRaf = 0;
    deleting = true;
    holdBtn.disabled = true;
    holdLbl.textContent = "กำลังลบ...";
    holdFill.style.width = "100%";
    const id = pendingId;
    fetch("/api/boards/" + encodeURIComponent(id), { method: "DELETE" })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        const sel = '[data-slug="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]';
        const card = grid.querySelector(sel);
        if (card) card.remove();
        applyFilter();
        deleting = false;
        modal.hidden = true;
        pendingId = null;
      })
      .catch(() => {
        deleting = false;
        holdBtn.disabled = false;
        holdLbl.textContent = "ลบไม่สำเร็จ พอกดค้างอีกครั้ง";
        holdFill.style.width = "0%";
      });
  }

  function tickHold() {
    const ratio = Math.min(1, (performance.now() - holdStart) / HOLD_MS);
    holdFill.style.width = ratio * 100 + "%";
    if (ratio >= 1) {
      finishHold();
      return;
    }
    holdRaf = requestAnimationFrame(tickHold);
  }

  function startHold(event) {
    if (deleting || !pendingId) return;
    event.preventDefault();
    holdStart = performance.now();
    if (holdBtn.setPointerCapture && event.pointerId !== undefined) {
      try { holdBtn.setPointerCapture(event.pointerId); } catch (err) {}
    }
    cancelAnimationFrame(holdRaf);
    holdRaf = requestAnimationFrame(tickHold);
  }

  grid.addEventListener("click", (event) => {
    const btn = event.target.closest && event.target.closest(".del");
    if (!btn || btn.disabled) return;
    event.preventDefault();
    const id = btn.dataset.id;
    if (id) openDelete(id);
  });

  document.getElementById("del-cancel").addEventListener("click", closeDelete);
  modal.addEventListener("pointerdown", (event) => {
    if (event.target === modal) closeDelete();
  });
  document.addEventListener("keydown", (event) => {
    if (!modal.hidden && event.key === "Escape") closeDelete();
  });
  holdBtn.addEventListener("pointerdown", startHold);
  holdBtn.addEventListener("pointerup", stopHold);
  holdBtn.addEventListener("pointercancel", stopHold);
  holdBtn.addEventListener("keydown", (event) => {
    if ((event.key === " " || event.key === "Enter") && !event.repeat) startHold(event);
  });
  holdBtn.addEventListener("keyup", (event) => {
    if (event.key === " " || event.key === "Enter") stopHold();
  });

  // Boards saved through the editor may not have a rendered preview yet: list
  // them straight from the API so nothing on the server is invisible.
  fetch("/api/boards")
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (!data || !Array.isArray(data.boards)) return;
      const boards = data.boards;
      const alive = new Set(boards.map((board) => board.id));
      // The page is a snapshot: a board deleted after the last build must not
      // stay clickable here until someone rebuilds the catalog.
      let removed = 0;
      for (const card of grid.querySelectorAll(".card")) {
        if (alive.has(card.dataset.slug)) continue;
        card.remove();
        removed += 1;
      }
      // Renames in the editor only write the sidecar, so the static card keeps
      // the name it was built with. Refresh it here instead of keeping two
      // names for the same board until someone rebuilds the catalogue.
      const byId = new Map(boards.map((board) => [board.id, board]));
      for (const card of grid.querySelectorAll(".card")) {
        const board = byId.get(card.dataset.slug);
        const h2 = card.querySelector("h2");
        if (!board || !h2) continue;
        const title = board.title || board.id;
        if (h2.textContent === title) continue;
        h2.textContent = title;
        card.dataset.search = (board.id + " " + title).toLowerCase();
        const shot = card.querySelector("a.shot");
        if (shot) shot.setAttribute("aria-label", "เปิด " + title);
        for (const control of card.querySelectorAll(".actions a, .actions button")) {
          if (control.classList.contains("del")) control.setAttribute("aria-label", "ลบ " + title);
          else if (control.hasAttribute("download")) control.setAttribute("aria-label", "ดาวน์โหลด " + title);
        }
      }
      const known = new Set([...grid.querySelectorAll(".card")].map((c) => c.dataset.slug));
      let added = 0;
      for (const board of boards) {
        if (known.has(board.id)) continue;
        const href = "/b/" + encodeURIComponent(board.id);
        const card = document.createElement("article");
        card.className = "card";
        card.dataset.slug = board.id;
        card.dataset.search = (board.id + " " + (board.title || "")).toLowerCase();
        card.innerHTML =
          '<a class="shot" href="' + href + '"><span class="placeholder">บันทึกบนเซิร์ฟเวอร์</span></a>' +
          '<div class="body"><h2></h2><p class="meta"></p><div class="actions">' +
          '<a class="primary" href="' + href + '">เปิด</a><span class="grow"></span>' +
          '<a class="iconbtn" download aria-label="ดาวน์โหลด" title="ดาวน์โหลด">' + ICONS.download + '</a>' +
          '<button class="iconbtn danger del" type="button" aria-label="ลบกระดาน" title="ลบ">' +
          ICONS.trash + '<span>ลบ</span></button></div></div>';
        card.querySelector(".del").dataset.id = board.id;
        card.querySelector("h2").textContent = board.title || board.id;
        card.querySelector(".meta").textContent =
          (board.elements ?? "?") + " elements · " + fmtSize(board.bytes) + " · " +
          new Date(board.updated).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
        card.querySelector(".meta").title = new Date(board.updated).toLocaleDateString("en-GB", {
          day: "numeric", month: "short", year: "numeric",
        });
        card.querySelector("a.iconbtn").href = "/scenes/" + encodeURIComponent(board.id) + ".excalidraw";
        card.querySelector(".del").setAttribute("aria-label", "ลบ " + (board.title || board.id));
        grid.appendChild(card);
        added += 1;
      }
      if (added || removed) applyFilter();
    })
    .catch(() => {});

  applyFilter();
</script>
</body>
</html>
`;
}

/* -------------------------------------------------------------------- main */

async function main() {
  mkdirSync(THUMBS, { recursive: true });
  mkdirSync(OUT_SCENES, { recursive: true });

  const scenes = collectScenes();
  if (scenes.length === 0) {
    process.stderr.write(`no .excalidraw files in ${SCENES}\n`);
    process.exit(1);
  }

  // Drop thumbnails/copies whose source scene no longer exists.
  const keep = new Set(scenes.map((s) => s.slug));
  for (const dir of [THUMBS, OUT_SCENES]) {
    for (const file of readdirSync(dir)) {
      const slug = basename(file, extname(file));
      if (!keep.has(slug)) rmSync(join(dir, file), { force: true });
    }
  }

  process.stdout.write(`building ${scenes.length} board(s) from ${SCENES}\n`);

  const rendered = await mapWithLimit(scenes, CONCURRENCY, async (scene) => {
    const info = describeScene(scene);
    const thumbPath = join(THUMBS, `${scene.slug}.png`);
    const result = await renderThumbnail(scene, thumbPath);
    if (!result.ok) {
      process.stdout.write(`  ! ${scene.slug}: thumbnail failed — ${result.error || "unknown"}\n`);
    } else {
      process.stdout.write(`  ${result.cached ? "=" : "✓"} ${scene.slug}\n`);
    }
    copyFileSync(scene.path, join(OUT_SCENES, `${scene.slug}.excalidraw`));
    return { scene, info, thumb: result.ok && existsSync(thumbPath) };
  });

  const entries = rendered
    .map(({ scene, info, thumb }) => {
      const file = join(THUMBS, `${scene.slug}.png`);
      const px = thumb ? pngSize(file) : null;
      return {
        slug: scene.slug,
        title: scene.meta.title || humanize(scene.slug),
        subtitle: scene.meta.subtitle || "",
        tags: scene.meta.tags || [],
        elements: info.elements,
        frames: info.frames,
        width: px?.width || info.width,
        height: px?.height || info.height,
        size: info.size,
        sizeLabel: formatBytes(info.size),
        updated: info.updated,
        thumb,
        mtime: Math.round(statSync(scene.path).mtimeMs),
      };
    })
    // newest first, then a stable tiebreak so a rebuild never reshuffles cards
    // that were saved in the same minute
    .sort((a, b) => b.updated - a.updated || a.title.localeCompare(b.title, "th"));

  const generatedAt = new Date().toLocaleString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  writeFileSync(join(SITE, "index.html"), renderPage(entries, generatedAt));
  writeFileSync(
    join(SITE, "manifest.json"),
    `${JSON.stringify({ generatedAt, boards: entries.map(({ mtime, ...rest }) => rest) }, null, 2)}\n`,
  );

  const failed = entries.filter((e) => !e.thumb).length;
  process.stdout.write(
    `\n${entries.length} board(s) → ${join(SITE, "index.html")}` +
      `${failed ? ` (${failed} without preview)` : ""}\n`,
  );
}

try {
  await main();
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exit(1);
}

#!/usr/bin/env node
/**
 * gallery/build.mjs — turn a folder of board folders into a browsable catalog.
 *
 * Why this exists: the self-hosted Excalidraw image is a static frontend with no
 * storage of its own. Boards live as folders on disk; this script is the missing
 * "index": it scans gallery/scenes/, renders a PNG preview of each board, and
 * writes a static gallery page next to the app.
 *
 * Usage
 *   node gallery/build.mjs              # render missing/stale thumbnails, write site/
 *   node gallery/build.mjs --force      # re-render every thumbnail
 *   node gallery/build.mjs --no-render  # catalog only (thumbnails must exist)
 *   SCENES_DIR=/tmp/x SITE_DIR=/tmp/y node gallery/build.mjs --no-render
 *
 * Per-scene metadata (optional)
 *   gallery/scenes/<id>/meta.json
 *     { "title": "...", "subtitle": "...", "tags": ["..."] }
 *   Without it the title is derived from the folder name.
 *
 * Board layout (one folder per board, written by app/server.mjs)
 *   <scenes>/<id>/scene.excalidraw            the board
 *   <scenes>/<id>/meta.json                   optional sidecar
 *   <scenes>/<id>/history/<stamp>.excalidraw  saved snapshots — never scanned
 *
 * Old flat boards (`<scenes>/<id>.excalidraw` + `<id>.meta.json`) are still
 * picked up so a never-migrated board does not vanish from the catalogue.
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
/* Both roots are overridable so a test can build a throwaway catalog. */
const SCENES = resolve(process.env.SCENES_DIR || join(HERE, "scenes"));
const SITE = resolve(process.env.SITE_DIR || join(HERE, "site"));
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

function readMetaFile(metaPath) {
  if (!existsSync(metaPath)) return {};
  try {
    const parsed = JSON.parse(readFileSync(metaPath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    process.stderr.write(`  ! ignoring bad ${basename(metaPath)}: ${error.message}\n`);
    return {};
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function collectScenes() {
  if (!existsSync(SCENES)) {
    // first boot of a fresh install: nothing mounted/created yet, which is the
    // same as an empty library — the empty catalogue below is the answer
    process.stderr.write(`scenes folder not found, treating as empty: ${SCENES}\n`);
    return [];
  }
  const names = readdirSync(SCENES).sort();
  const scenes = [];
  const ids = new Set();
  const slugs = new Map();

  const add = (id, path, metaPath) => {
    if (!id || ids.has(id)) return;
    const slug = slugify(id) || "scene";
    if (slugs.has(slug)) {
      process.stderr.write(`  ! skipping ${id}: slug ${slug} already used by ${slugs.get(slug)}\n`);
      return;
    }
    ids.add(id);
    slugs.set(slug, id);
    scenes.push({ id, file: path, path, slug, meta: readMetaFile(metaPath) });
  };

  // Current layout: <scenes>/<id>/scene.excalidraw. Snapshots live in
  // <id>/history/, one level below the file we read, so they are never scanned.
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const dir = join(SCENES, name);
    if (!isDirectory(dir)) continue;
    const scene = join(dir, "scene.excalidraw");
    if (existsSync(scene)) add(name, scene, join(dir, "meta.json"));
  }

  // Legacy flat layout: <scenes>/<id>.excalidraw, still read by the server
  // until that board's next save moves it into a folder.
  for (const name of names) {
    if (name.startsWith(".") || extname(name) !== ".excalidraw") continue;
    const id = basename(name, ".excalidraw");
    const file = join(SCENES, name);
    let isFile = false;
    try {
      isFile = statSync(file).isFile();
    } catch {
      /* dangling entry */
    }
    if (isFile) add(id, file, join(SCENES, `${id}.meta.json`));
  }

  // A sidecar whose scene is gone is ignored, but it lingers on disk — say so
  // instead of leaving a puzzle.
  for (const name of names) {
    if (name.startsWith(".") || !name.endsWith(".meta.json")) continue;
    const id = name.slice(0, -".meta.json".length);
    if (!ids.has(id)) {
      process.stderr.write(`  ! orphan ${name}: no ${id}/scene.excalidraw and no ${id}.excalidraw (ignored)\n`);
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
    // --no-render never renders: it only reuses what the host already produced,
    // so a missing preview is "not yet", not a failure
    return { ok: existsSync(thumbPath), cached: true, skipped: true };
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
  const ICON_PENCIL =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17v3z"/></svg>';

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
            <button class="iconbtn rename" type="button" data-id="${escapeHtml(
              entry.slug,
            )}" aria-label="แก้ชื่อ ${escapeHtml(entry.title)}" title="แก้ชื่อกระดาน">${ICON_PENCIL}<span>แก้ชื่อ</span></button>
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
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<title>Excalidraw boards</title>
<style>
  :root {
    color-scheme: light;
    --bg: #eef1f8;
    --panel: rgba(255, 255, 255, 0.56);
    --panel-strong: rgba(255, 255, 255, 0.78);
    --line: rgba(24, 24, 39, 0.1);
    --line-strong: rgba(24, 24, 39, 0.16);
    --glass-line: rgba(255, 255, 255, 0.8);
    --ink: #18181f;
    --muted: #64646f;
    --accent: #6360d9;
    --accent-soft: rgba(99, 96, 217, 0.12);
    --danger: #b42323;
    --danger-line: #e8c2c2;
    --blur: blur(20px) saturate(155%);
    --shadow: 0 12px 36px rgba(31, 36, 71, 0.1), inset 0 1px 0 rgba(255, 255, 255, 0.72);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    padding: 22px 22px 44px;
    background:
      radial-gradient(900px 700px at 6% -8%, rgba(139, 168, 255, 0.9) 0%, transparent 62%),
      radial-gradient(820px 640px at 102% -2%, rgba(255, 148, 196, 0.78) 0%, transparent 60%),
      radial-gradient(920px 760px at 52% 112%, rgba(121, 231, 195, 0.74) 0%, transparent 62%),
      radial-gradient(760px 560px at 26% 48%, rgba(197, 212, 255, 0.58) 0%, transparent 72%),
      radial-gradient(760px 560px at 78% 62%, rgba(255, 202, 228, 0.52) 0%, transparent 72%),
      var(--bg);
    background-attachment: fixed;
    color: var(--ink);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans Thai", Inter, system-ui, sans-serif;
  }
  header {
    position: sticky; top: 12px; z-index: 20;
    max-width: 1180px; margin: 0 auto 20px; padding: 9px 11px;
    border: 1px solid var(--glass-line); border-radius: 16px;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.58), rgba(255, 255, 255, 0.32));
    backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur);
    box-shadow: var(--shadow);
  }
  .top { display: flex; flex-wrap: wrap; align-items: center; gap: 9px; }
  h1 { margin: 0; font-size: 19px; font-weight: 600; letter-spacing: -0.3px; }
  .count { color: var(--muted); font-size: 12.5px; white-space: nowrap; }
  .grow { flex: 1; }
  input[type="search"] {
    width: 220px; max-width: 100%; padding: 7px 11px; font: inherit; font-size: 13px;
    color: var(--ink); background: rgba(255, 255, 255, 0.6);
    border: 1px solid var(--glass-line); border-radius: 9px; outline: none;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7);
  }
  input[type="search"]::placeholder { color: var(--muted); }
  input[type="search"]:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99, 96, 217, 0.14); }
  .app-link {
    color: #fff; text-decoration: none; white-space: nowrap;
    background: linear-gradient(180deg, #7673e3, var(--accent));
    border: 1px solid rgba(255, 255, 255, 0.3);
    padding: 7px 12px; border-radius: 9px; font-size: 12.5px;
    box-shadow: 0 6px 16px rgba(99, 96, 217, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.28);
  }
  .app-link:hover { filter: brightness(.96); }
  .grid {
    max-width: 1180px; margin: 0 auto;
    display: grid; gap: 15px;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  }
  .card {
    display: flex; flex-direction: column; overflow: hidden;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.42), rgba(255, 255, 255, 0.22));
    backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur);
    border: 1px solid var(--glass-line); border-radius: 16px;
    box-shadow: 0 10px 30px rgba(31, 36, 71, 0.08), inset 0 1px 0 rgba(255, 255, 255, 0.7);
    transition: border-color .14s ease, transform .14s ease, box-shadow .14s ease;
  }
  .card:hover {
    border-color: color-mix(in srgb, var(--accent) 32%, var(--glass-line));
    transform: translateY(-2px);
    box-shadow: 0 18px 42px rgba(31, 36, 71, 0.13), inset 0 1px 0 rgba(255, 255, 255, 0.78);
  }
  .shot {
    display: flex; align-items: center; justify-content: center; text-decoration: none;
    aspect-ratio: 16 / 10; padding: 10px; overflow: hidden;
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.68), rgba(255, 255, 255, 0.32));
    border-bottom: 1px solid rgba(255, 255, 255, 0.6);
  }
  .shot img { max-width: 100%; max-height: 100%; width: auto; height: auto; object-fit: contain; }
  .placeholder { color: var(--muted); font-size: 12px; }
  .body { display: flex; flex-direction: column; gap: 3px; padding: 12px 13px 13px; }
  h2 { margin: 0; font-size: 14.5px; font-weight: 600; line-height: 1.35; }
  .sub { margin: 0; color: var(--muted); font-size: 12px; }
  .meta {
    margin: 0; color: var(--muted); font-size: 11.5px; line-height: 1.45;
    font-variant-numeric: tabular-nums; overflow-wrap: anywhere;
  }
  .actions { display: flex; align-items: center; gap: 6px; margin-top: 10px; }
  .primary {
    display: inline-flex; align-items: center; text-decoration: none;
    background: linear-gradient(180deg, #7673e3, var(--accent));
    color: #fff; font-size: 12.5px; padding: 5px 12px; border-radius: 8px;
    border: 1px solid rgba(255, 255, 255, 0.26);
    box-shadow: 0 5px 14px rgba(99, 96, 217, 0.22), inset 0 1px 0 rgba(255, 255, 255, 0.26);
  }
  .primary:hover { filter: brightness(.96); }
  button.primary { font: inherit; font-size: 12.5px; cursor: pointer; padding: 7px 13px; border-radius: 9px; }
  .iconbtn {
    display: inline-flex; align-items: center; justify-content: center; gap: 4px;
    height: 28px; padding: 0 7px; border-radius: 8px; cursor: pointer;
    border: 1px solid rgba(255, 255, 255, 0.7);
    background: rgba(255, 255, 255, 0.44);
    color: var(--muted);
    font: inherit; font-size: 12px; text-decoration: none;
    opacity: .84; transition: opacity .12s ease, border-color .12s ease, color .12s ease, background .12s ease;
  }
  .card:hover .iconbtn, .card:focus-within .iconbtn { opacity: 1; }
  .iconbtn:hover { background: rgba(255, 255, 255, 0.78); border-color: var(--accent); color: var(--ink); }
  .iconbtn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; opacity: 1; }
  .iconbtn.rename span { display: inline; }
  .iconbtn.danger { color: var(--danger); border-color: rgba(232, 194, 194, 0.9); background: rgba(255, 240, 240, 0.4); }
  .iconbtn.danger:hover { border-color: var(--danger); background: rgba(255, 240, 240, 0.72); }
  .iconbtn:disabled { opacity: .4; cursor: default; }
  @media (hover: none) {
    .iconbtn { opacity: 1; }
  }
  @media (max-width: 420px) {
    .iconbtn.rename span, .iconbtn.danger span { display: none; }
  }
  .modal {
    position: fixed; inset: 0; z-index: 50; display: grid; place-items: center;
    background: rgba(24, 28, 48, .26);
    backdrop-filter: blur(7px); -webkit-backdrop-filter: blur(7px);
    padding: 20px;
  }
  .modal[hidden] { display: none; }
  .modal-card {
    width: min(420px, 100%);
    background: linear-gradient(180deg, rgba(255, 255, 255, 0.86), rgba(255, 255, 255, 0.7));
    backdrop-filter: var(--blur); -webkit-backdrop-filter: var(--blur);
    border: 1px solid var(--glass-line); border-radius: 18px; padding: 20px 20px 15px;
    box-shadow: 0 26px 70px rgba(24, 30, 60, 0.24), inset 0 1px 0 rgba(255, 255, 255, 0.8);
  }
  .modal-card h2 { margin: 0 0 8px; font-size: 16px; }
  .modal-card p { margin: 0 0 16px; font-size: 12.5px; line-height: 1.55; color: var(--muted); }
  .modal-actions { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
  .field { display: flex; flex-direction: column; gap: 6px; margin: 0 0 14px; }
  .field span { font-size: 11.5px; color: var(--muted); }
  .field input {
    width: 100%; padding: 8px 10px; font: inherit; font-size: 13.5px;
    color: var(--ink); background: rgba(255, 255, 255, 0.72);
    border: 1px solid var(--line-strong); border-radius: 9px; outline: none;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.7);
  }
  .field input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px rgba(99, 96, 217, 0.14); }
  .modal-note { margin: -4px 0 12px !important; font-size: 12px !important; color: var(--danger) !important; }
  .ghost {
    font: inherit; font-size: 12.5px; padding: 7px 12px; cursor: pointer;
    border-radius: 9px; border: 1px solid var(--line-strong);
    background: rgba(255, 255, 255, 0.48); color: var(--ink);
  }
  .ghost:hover { border-color: var(--accent); background: rgba(255, 255, 255, 0.76); }
  .modal-hint { margin: 12px 0 0 !important; font-size: 11.5px !important; color: var(--muted) !important; text-align: right; }
  .holdbtn {
    position: relative; overflow: hidden; min-width: 168px; justify-content: center;
    display: inline-flex; align-items: center; padding: 7px 14px; border-radius: 9px;
    border: 1px solid var(--danger-line); background: rgba(255, 240, 240, 0.4); color: var(--danger);
    font: inherit; font-size: 12.5px; cursor: pointer; user-select: none; touch-action: none;
  }
  .holdbtn .fill {
    position: absolute; left: 0; top: 0; bottom: 0; width: 0; pointer-events: none;
    background: rgba(255, 90, 90, .26);
  }
  .holdbtn .lbl { position: relative; }
  .holdbtn:disabled { cursor: default; }
  footer {
    max-width: 1180px; margin: 26px auto 0; color: var(--muted); font-size: 11px;
  }
  .empty { max-width: 1180px; margin: 38px auto; color: var(--muted); font-size: 13px; }
  @supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
    header, .card, .modal-card { background: rgba(250, 251, 255, 0.96); }
  }
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
${entries.length === 0 ? '<p class="empty" id="no-boards">ยังไม่มีกระดานในเซิร์ฟเวอร์นี้ — กด “+ กระดานใหม่” เพื่อเริ่ม</p>' : ""}
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
<div class="modal" id="rename-modal" hidden>
  <form class="modal-card" id="rename-form" role="dialog" aria-modal="true" aria-labelledby="rename-title" novalidate>
    <h2 id="rename-title">แก้ชื่อกระดาน</h2>
    <p>ชื่อนี้จะแสดงในหน้ารวมและในหน้าแก้ไขทันที</p>
    <label class="field" for="rename-input">
      <span>ชื่อกระดาน</span>
      <input id="rename-input" maxlength="120" autocomplete="off" spellcheck="false" required>
    </label>
    <p class="modal-note" id="rename-note" hidden></p>
    <div class="modal-actions">
      <button class="ghost" type="button" id="rename-cancel">ยกเลิก</button>
      <button class="primary" type="submit" id="rename-save">บันทึกชื่อ</button>
    </div>
  </form>
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
    pencil: ${JSON.stringify(ICON_PENCIL)},
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

  function cardFor(id) {
    const safe = window.CSS && CSS.escape ? CSS.escape(id) : String(id).replace(/"/g, '\\\\"');
    return grid.querySelector('[data-slug="' + safe + '"]');
  }

  // One place updates every place a board name appears on a card, so a rename
  // in the editor, from this dialog, or from the API all converge on one name.
  function updateCardTitle(card, id, title, subtitle) {
    if (!card) return;
    const name = title || id;
    const sub = subtitle || "";
    const h2 = card.querySelector("h2");
    if (h2) h2.textContent = name;
    card.dataset.search = (id + " " + name + " " + sub).toLowerCase();
    const shot = card.querySelector("a.shot");
    if (shot) shot.setAttribute("aria-label", "เปิด " + name);
    const rename = card.querySelector(".rename");
    if (rename) {
      rename.dataset.id = id;
      rename.setAttribute("aria-label", "แก้ชื่อ " + name);
      rename.title = "แก้ชื่อกระดาน";
    }
    const del = card.querySelector(".del");
    if (del) {
      del.dataset.id = id;
      del.setAttribute("aria-label", "ลบ " + name);
    }
    const download = card.querySelector(".actions a[download]");
    if (download) download.setAttribute("aria-label", "ดาวน์โหลด " + name);
  }

  q.addEventListener("input", applyFilter);

  // rename a board from the catalogue: the same PATCH the editor uses
  const renameModal = document.getElementById("rename-modal");
  const renameForm = document.getElementById("rename-form");
  const renameInput = document.getElementById("rename-input");
  const renameNote = document.getElementById("rename-note");
  const renameSave = document.getElementById("rename-save");
  let renameId = null;
  let renameBusy = false;

  function openRename(id, title, trigger) {
    if (!renameModal.hidden) return;
    if (!modal.hidden && !deleting) closeDelete();
    renameId = id;
    renameBusy = false;
    renameNote.hidden = true;
    renameNote.textContent = "";
    renameInput.value = title || id;
    renameModal.hidden = false;
    renameModal._trigger = trigger || null;
    renameInput.focus();
    renameInput.select();
    // Some browsers need a frame before the input is focusable after [hidden] is removed.
    requestAnimationFrame(() => {
      if (document.activeElement !== renameInput) {
        renameInput.focus();
        renameInput.select();
      }
    });
  }

  function closeRename() {
    if (renameBusy) return;
    const trigger = renameModal._trigger;
    renameModal.hidden = true;
    renameModal._trigger = null;
    renameId = null;
    if (trigger && trigger.isConnected) trigger.focus();
  }

  function showRenameNote(text) {
    renameNote.textContent = text;
    renameNote.hidden = false;
  }

  renameForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (renameBusy || !renameId) return;
    const id = renameId;
    const next = renameInput.value.trim();
    if (!next) {
      showRenameNote("ชื่อต้องไม่ว่าง");
      renameInput.focus();
      return;
    }
    renameBusy = true;
    renameSave.disabled = true;
    renameSave.textContent = "กำลังบันทึก…";
    renameNote.hidden = true;
    fetch("/api/boards/" + encodeURIComponent(id) + "/meta", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: next }),
    })
      .then((res) => {
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      })
      .then((meta) => {
        const card = cardFor(id);
        updateCardTitle(card, id, (meta && meta.title) || next, meta && meta.subtitle);
        const trigger = renameModal._trigger;
        renameBusy = false;
        renameSave.disabled = false;
        renameSave.textContent = "บันทึกชื่อ";
        renameModal.hidden = true;
        renameModal._trigger = null;
        renameId = null;
        if (trigger && trigger.isConnected) trigger.focus();
        if (!card) applyFilter();
      })
      .catch((err) => {
        renameBusy = false;
        renameSave.disabled = false;
        renameSave.textContent = "บันทึกชื่อ";
        showRenameNote("บันทึกชื่อไม่สำเร็จ" + (err && err.message ? " (" + err.message + ")" : ""));
        renameInput.focus();
      });
  });

  document.getElementById("rename-cancel").addEventListener("click", closeRename);
  renameModal.addEventListener("pointerdown", (event) => {
    if (event.target === renameModal) closeRename();
  });

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
    if (!renameModal.hidden && !renameBusy) closeRename();
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
    const rename = event.target.closest && event.target.closest(".rename");
    if (rename && !rename.disabled) {
      event.preventDefault();
      const card = rename.closest(".card");
      const h2 = card && card.querySelector("h2");
      if (rename.dataset.id) openRename(rename.dataset.id, h2 ? h2.textContent : "", rename);
      return;
    }
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
    if (event.key !== "Escape") return;
    if (!renameModal.hidden) closeRename();
    else if (!modal.hidden) closeDelete();
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
        if (!board) continue;
        updateCardTitle(card, board.id, board.title || board.id, board.subtitle || "");
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
          '<button class="iconbtn rename" type="button" aria-label="แก้ชื่อกระดาน" title="แก้ชื่อกระดาน">' +
          ICONS.pencil + '<span>แก้ชื่อ</span></button>' +
          '<a class="iconbtn" download aria-label="ดาวน์โหลด" title="ดาวน์โหลด">' + ICONS.download + '</a>' +
          '<button class="iconbtn danger del" type="button" aria-label="ลบกระดาน" title="ลบ">' +
          ICONS.trash + '<span>ลบ</span></button></div></div>';
        card.querySelector(".rename").dataset.id = board.id;
        card.querySelector(".del").dataset.id = board.id;
        updateCardTitle(card, board.id, board.title || board.id, board.subtitle || "");
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
    // a brand-new install has no boards yet: write the empty catalogue instead
    // of failing, so / is a page with a "+ กระดานใหม่" button and not a 404
    process.stderr.write(`no boards in ${SCENES} yet (expected <id>/scene.excalidraw)\n`);
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
    if (!result.ok && result.skipped) {
      process.stdout.write(`  · ${scene.slug} (no preview yet)\n`);
    } else if (!result.ok) {
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
        id: scene.id,
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

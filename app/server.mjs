#!/usr/bin/env node
/**
 * server.mjs — boards server for the self-hosted Excalidraw app.
 *
 * Zero dependencies (node:http + node:fs). Serves three things from one origin:
 *   /gallery/…   the generated board catalogue (gallery/site)
 *   /scenes/…    raw .excalidraw files (download / #url= deep link)
 *   /, /b/:id    the editor SPA (app/dist), which talks to /api/boards
 *
 * Boards are plain files on the host disk — that is the whole point: nothing
 * lives in the browser anymore.
 *
 *   DATA_DIR     where boards are stored   (default ./gallery/scenes)
 *   APP_DIR      built SPA                 (default ./app/dist)
 *   GALLERY_DIR  built catalogue           (default ./gallery/site)
 *   PORT         listen port               (default 5002)
 *   HISTORY_KEEP how many autosave copies  (default 20)
 */

import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";

const PORT = Number(process.env.PORT || 5002);
const DATA_DIR = resolve(process.env.DATA_DIR || "./gallery/scenes");
const APP_DIR = resolve(process.env.APP_DIR || "./app/dist");
const GALLERY_DIR = resolve(process.env.GALLERY_DIR || "./gallery/site");
const HISTORY_KEEP = Number(process.env.HISTORY_KEEP || 20);
const MAX_BODY = 32 * 1024 * 1024;

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const SCENE_RE = /\.excalidraw$/i;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".excalidraw": "application/json; charset=utf-8",
};
const typeOf = (p) => TYPES[extname(p).toLowerCase()] || "application/octet-stream";

const log = (...a) => console.log(new Date().toISOString(), ...a);

/* ------------------------------------------------------------------ helpers */

function send(res, code, body, headers = {}) {
  res.writeHead(code, { "X-Content-Type-Options": "nosniff", ...headers });
  res.end(body);
}
const json = (res, code, value) =>
  send(res, code, JSON.stringify(value), { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
const fail = (res, code, message, extra = {}) => json(res, code, { error: message, ...extra });

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("body too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Reject any path that escapes `root` (path traversal guard). */
function within(root, relPath) {
  const target = resolve(root, "." + (relPath.startsWith("/") ? relPath : `/${relPath}`));
  return target === root || target.startsWith(root + sep) ? target : null;
}

async function serveFile(res, filePath, { cache = "no-cache", download = null, status = 200 } = {}) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;
  res.writeHead(status, {
    "Content-Type": typeOf(filePath),
    "Content-Length": info.size,
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": cache,
    ...(download ? { "Content-Disposition": `attachment; filename="${download}"` } : {}),
  });
  await new Promise((ok, no) => {
    const s = createReadStream(filePath);
    s.on("error", no);
    s.on("end", ok);
    s.pipe(res);
  }).catch(() => {});
  return true;
}

async function fileExists(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

function notFoundPage(pathname) {
  const safe = String(pathname).replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]);
  return `<!doctype html><html lang="th"><meta charset="utf-8"><title>ไม่พบหน้านี้ · Excalidraw boards</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#121212;color:#e8e8ea;font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{text-align:center;padding:40px}h1{font-size:22px;margin:0 0 8px}p{color:#9a9aa2;margin:0 0 22px}
code{background:#1e1e24;padding:2px 6px;border-radius:5px;color:#c9c9d1}
a{display:inline-block;background:#4a5bd6;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600}</style>
<main><h1>ไม่พบหน้านี้</h1><p><code>${safe}</code> ไม่มีอยู่ในเซิร์ฟเวอร์นี้</p><a href="/">กลับไปหน้าแกลเลอรี</a></main></html>`;
}

const scenePath = (id) => join(DATA_DIR, `${id}.excalidraw`);
const metaPath = (id) => join(DATA_DIR, `${id}.meta.json`);
const historyDir = (id) => join(DATA_DIR, ".history", id);

function emptyScene() {
  return {
    type: "excalidraw",
    version: 2,
    source: "boards-server",
    elements: [],
    appState: { gridSize: 20, gridStep: 5, gridModeEnabled: false, viewBackgroundColor: "#ffffff" },
    files: {},
  };
}

function slugify(name) {
  const base = String(name || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return base || "board";
}

async function uniqueId(wanted) {
  const base = slugify(wanted);
  for (let i = 0; i < 500; i += 1) {
    const id = i === 0 ? base : `${base}-${i + 1}`;
    try {
      await stat(scenePath(id));
    } catch {
      return id;
    }
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Keep the previous copy of a board before overwriting it. */
async function snapshot(id) {
  try {
    const info = await stat(scenePath(id));
    if (info.size === 0) return;
    await mkdir(historyDir(id), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await copyFile(scenePath(id), join(historyDir(id), `${stamp}.excalidraw`));
    const kept = (await readdir(historyDir(id))).filter((f) => SCENE_RE.test(f)).sort();
    for (const old of kept.slice(0, Math.max(0, kept.length - HISTORY_KEEP))) {
      await unlink(join(historyDir(id), old)).catch(() => {});
    }
  } catch {
    /* first save: nothing to snapshot */
  }
}

async function writeAtomic(path, contents) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now().toString(36)}`;
  await writeFile(tmp, contents);
  await rename(tmp, path);
}

/** Write a board: keep the old copy, then atomically replace the file. */
async function saveScene(id, scene) {
  await mkdir(DATA_DIR, { recursive: true });
  await snapshot(id);
  await writeAtomic(scenePath(id), `${JSON.stringify(scene, null, 2)}\n`);
}

/** Serialise writes per board: two editors saving at once must not interleave. */
const boardLocks = new Map();
function withBoardLock(id, fn) {
  const prev = boardLocks.get(id) || Promise.resolve();
  const next = prev.then(fn, fn);
  boardLocks.set(
    id,
    next.catch(() => {}),
  );
  return next;
}

/* --------------------------------------------------------------------- meta */

/*
 * `gallery/scenes/<id>.meta.json` is an optional sidecar: { title, subtitle, tags }.
 * It holds the board's display name while the scene file stays a pure Excalidraw
 * document. Missing, empty or broken sidecars all read as "no metadata".
 */

const META_TITLE_MAX = 120;

async function readMeta(id) {
  try {
    const parsed = JSON.parse(await readFile(metaPath(id), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Public shape: the title always exists (falls back to the board id). */
function metaView(id, meta) {
  return {
    id,
    title: typeof meta?.title === "string" && meta.title ? meta.title : id,
    subtitle: typeof meta?.subtitle === "string" ? meta.subtitle : "",
    tags: Array.isArray(meta?.tags) ? meta.tags.map(String) : [],
  };
}

async function apiMetaGet(res, id) {
  if (!(await fileExists(scenePath(id)))) return fail(res, 404, `board not found: ${id}`);
  json(res, 200, metaView(id, await readMeta(id)));
}

async function apiMetaPatch(res, req, id) {
  if (!(await fileExists(scenePath(id)))) return fail(res, 404, `board not found: ${id}`);

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return fail(res, 400, "body is not valid JSON");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail(res, 400, "expected a JSON object");
  }
  if (typeof body.title !== "string") return fail(res, 400, 'expected "title" to be a string');

  const title = body.title.trim();
  if ([...title].length > META_TITLE_MAX) {
    return fail(res, 400, `title is longer than ${META_TITLE_MAX} characters`);
  }

  // read-modify-write under the board lock so a rename cannot race a scene save
  const meta = await withBoardLock(id, async () => {
    const current = await readMeta(id);
    const next = {};
    if (title) next.title = title;
    if (typeof current.subtitle === "string" && current.subtitle) next.subtitle = current.subtitle;
    if (Array.isArray(current.tags) && current.tags.length) next.tags = current.tags;

    if (Object.keys(next).length) {
      await mkdir(DATA_DIR, { recursive: true });
      await writeAtomic(metaPath(id), `${JSON.stringify(next, null, 2)}\n`);
    } else {
      // nothing custom left: delete the sidecar instead of leaving `{}` behind
      await unlink(metaPath(id)).catch(() => {});
    }
    return next;
  });

  const view = metaView(id, meta);
  broadcast(id, { type: "meta", ...view });
  log("meta", id, view.title);
  json(res, 200, view);
}

/* --------------------------------------------------------------------- api */

async function apiList(res) {
  let names;
  try {
    names = await readdir(DATA_DIR);
  } catch {
    return json(res, 200, { boards: [] });
  }
  const boards = [];
  for (const name of names) {
    if (!SCENE_RE.test(name) || name.startsWith(".")) continue;
    const id = name.replace(SCENE_RE, "");
    const path = join(DATA_DIR, name);
    try {
      const info = await stat(path);
      let title = id;
      let subtitle = "";
      let elements = null;
      try {
        const meta = JSON.parse(await readFile(metaPath(id), "utf8"));
        if (meta?.title) title = String(meta.title);
        if (meta?.subtitle) subtitle = String(meta.subtitle);
      } catch {
        /* no meta sidecar */
      }
      try {
        const scene = JSON.parse(await readFile(path, "utf8"));
        elements = Array.isArray(scene.elements) ? scene.elements.filter((e) => !e.isDeleted).length : null;
      } catch {
        /* unreadable scene: still list it */
      }
      boards.push({ id, title, subtitle, bytes: info.size, updated: info.mtimeMs, elements });
    } catch {
      /* racing delete */
    }
  }
  boards.sort((a, b) => b.updated - a.updated);
  json(res, 200, { boards });
}

async function apiCreate(res, req) {
  let wanted = "";
  try {
    const body = await readBody(req);
    if (body.trim()) wanted = JSON.parse(body).name || "";
  } catch {
    /* empty body is fine */
  }
  const id = await uniqueId(wanted || `board-${new Date().toISOString().slice(0, 16).replace(/[:T-]/g, "")}`);
  const scene = emptyScene();
  await mkdir(DATA_DIR, { recursive: true });
  await writeAtomic(scenePath(id), `${JSON.stringify(scene, null, 2)}\n`);
  log("created", id);
  json(res, 201, { id, scene });
}

async function apiGet(res, id) {
  try {
    const raw = await readFile(scenePath(id), "utf8");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(raw);
    return;
  } catch {
    return fail(res, 404, `board not found: ${id}`);
  }
}

async function apiPut(res, req, id) {
  const raw = await readBody(req);
  let scene;
  try {
    scene = JSON.parse(raw);
  } catch {
    return fail(res, 400, "body is not valid JSON");
  }
  if (scene?.type !== "excalidraw" || !Array.isArray(scene.elements)) {
    return fail(res, 400, 'expected a scene object with type "excalidraw" and an elements array');
  }
  await withBoardLock(id, () => saveScene(id, scene));
  json(res, 200, { id, elements: scene.elements.length, savedAt: Date.now() });
}

async function apiDelete(res, id) {
  try {
    await unlink(scenePath(id));
  } catch {
    return fail(res, 404, `board not found: ${id}`);
  }
  // the .meta.json sidecar belongs to the board: leaving it behind would show
  // a stale title if a new board later reuses the same id
  await unlink(metaPath(id)).catch(() => {});
  await rm(historyDir(id), { recursive: true, force: true }).catch(() => {});
  const peers = rooms.get(id);
  if (peers) {
    for (const socket of peers) {
      try {
        socket.send(JSON.stringify({ type: "deleted", board: id }));
        socket.close(4004, "board deleted");
      } catch {
        /* socket already gone */
      }
    }
    rooms.delete(id);
  }
  log("deleted", id);
  json(res, 200, { id, deleted: true });
}

/* -------------------------------------------------------------------- live */

/*
 * One WebSocket room per board: /ws/board/<id>
 *
 * Excalidraw has no merge algorithm of its own, so clients send their whole
 * scene and receivers merge element-by-element by `version`/`versionNonce`
 * (the same fields Excalidraw bumps on every edit). That keeps two people
 * drawing at the same time from wiping each other's shapes, and it converges:
 * whoever still holds an element the other side lacks re-sends the merged set.
 *
 * The socket owns persistence while it is open (debounced, 350 ms); the HTTP
 * PUT stays as the fallback for tabs that only ever open one connection.
 */
const rooms = new Map(); // boardId -> Set<ws>
const saveQueue = new Map(); // boardId -> {scene, timer, waiters}
const PEER_COLORS = ["#7c8cff", "#ff8a5c", "#3ecf8e", "#f5c451", "#ff6b9d", "#5cc8ff", "#b18cff"];

// A tab keeps one id in sessionStorage, so a reload can replace its own old
// socket instead of looking like a second person. Malformed ids are ignored.
const SID_RE = /^[A-Za-z0-9_-]{8,64}$/;

// A browser that vanishes without closing its socket (sleep, lost Wi-Fi,
// Tailscale drop) never sends a close frame, so the only way to keep the
// presence honest is to ping and drop whatever stops answering.
const HEARTBEAT_MS = (() => {
  const raw = Number(process.env.HEARTBEAT_MS);
  return Number.isFinite(raw) && raw >= 100 ? raw : 30_000;
})();

const roomOf = (id) => {
  let room = rooms.get(id);
  if (!room) rooms.set(id, (room = new Set()));
  return room;
};

function broadcast(id, message, except) {
  const room = rooms.get(id);
  if (!room) return;
  const text = JSON.stringify(message);
  for (const client of room) {
    if (client === except || client.readyState !== 1) continue;
    client.send(text);
  }
}

const presenceOf = (id) => ({
  type: "presence",
  peers: [...(rooms.get(id) || [])].map((c) => ({ id: c.peerId, name: c.peerName, color: c.peerColor })),
});

const announce = (id) => broadcast(id, presenceOf(id));

/** Debounced write: a burst of dragging becomes one snapshot on disk. */
function queuePersist(id, scene, done) {
  let entry = saveQueue.get(id);
  if (!entry) saveQueue.set(id, (entry = { scene: null, timer: 0, waiters: [] }));
  entry.scene = scene;
  entry.waiters.push(done);
  if (entry.timer) return;
  entry.timer = setTimeout(async () => {
    entry.timer = 0;
    const payload = entry.scene;
    const waiters = entry.waiters.splice(0);
    entry.scene = null;
    if (!payload) return;
    try {
      await withBoardLock(id, () => saveScene(id, payload));
      for (const w of waiters) w(true);
    } catch (error) {
      log("ws save failed", id, error?.message);
      for (const w of waiters) w(false);
    }
  }, 350);
}

const live = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY });

live.on("connection", (ws, request, id) => {
  if (!rooms.has(id)) roomOf(id);
  const room = roomOf(id);
  const params = new URL(request.url, "http://x").searchParams;
  const sidParam = String(params.get("sid") || "");
  ws.peerSid = SID_RE.test(sidParam) ? sidParam : null;
  ws.peerName = String(params.get("name") || "").slice(0, 40) || "ไม่ระบุชื่อ";

  // the same tab reconnecting (reload, network blip) takes its old slot back:
  // dropping the previous socket keeps one person at one place in the room
  if (ws.peerSid) {
    for (const other of room) {
      if (other === ws || other.peerSid !== ws.peerSid) continue;
      other.replaced = true;
      room.delete(other);
      try {
        other.send(JSON.stringify({ type: "replaced" }));
        other.close(4001, "replaced");
      } catch {
        /* already gone */
      }
      setTimeout(() => other.terminate(), 1_000).unref?.();
    }
  }

  const taken = new Set([...room].map((c) => c.peerColor));
  ws.peerId = `p${Math.random().toString(36).slice(2, 9)}`;
  ws.peerColor = PEER_COLORS.find((c) => !taken.has(c)) || PEER_COLORS[room.size % PEER_COLORS.length];
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
  room.add(ws);

  const send = (message) => ws.readyState === 1 && ws.send(JSON.stringify(message));
  send({ type: "welcome", board: id, you: { id: ws.peerId, name: ws.peerName, color: ws.peerColor } });
  announce(id);

  ws.on("message", (raw) => {
    if (raw.length > MAX_BODY) return;
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!message || typeof message !== "object") return;

    if (message.type === "update") {
      const scene = message.scene;
      if (scene?.type !== "excalidraw" || !Array.isArray(scene.elements)) return;
      queuePersist(id, scene, (ok) => send({ type: ok ? "saved" : "save-failed", at: Date.now() }));
      broadcast(id, { type: "update", from: ws.peerId, scene }, ws);
      return;
    }

    if (message.type === "pointer") {
      const x = Number(message.x);
      const y = Number(message.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      broadcast(id, { type: "pointer", from: ws.peerId, color: ws.peerColor, x, y }, ws);
    }
  });

  ws.on("close", () => {
    // a replaced socket already left the room and its replacement announced
    // the new presence — saying it again would only repeat the same frame
    if (ws.replaced) return;
    room.delete(ws);
    if (!room.size) rooms.delete(id);
    announce(id);
  });
  ws.on("error", () => {});
});

/* One sweeper for every room: a socket that still has not answered the previous
 * ping is gone as far as anyone can tell, so it leaves the presence right now
 * instead of lingering until the OS notices the dead connection. */
const heartbeat = setInterval(() => {
  for (const room of rooms.values()) {
    for (const ws of room) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }
  }
}, HEARTBEAT_MS);
heartbeat.unref?.();

/* ------------------------------------------------------------------ routing */


const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const path = decodeURIComponent(url.pathname);
  const method = req.method || "GET";

  try {
    if (path === "/api/health") return json(res, 200, { ok: true, dataDir: DATA_DIR });

    if (path === "/api/boards") {
      if (method === "GET") return await apiList(res);
      if (method === "POST") return await apiCreate(res, req);
      return fail(res, 405, "method not allowed");
    }

    const metaMatch = path.match(/^\/api\/boards\/([^/]+)\/meta$/);
    if (metaMatch) {
      const id = metaMatch[1];
      if (!ID_RE.test(id)) return fail(res, 400, "invalid board id");
      if (method === "GET") return await apiMetaGet(res, id);
      if (method === "PATCH") return await apiMetaPatch(res, req, id);
      return fail(res, 405, "method not allowed");
    }

    const boardMatch = path.match(/^\/api\/boards\/([^/]+)$/);
    if (boardMatch) {
      const id = boardMatch[1];
      if (!ID_RE.test(id)) return fail(res, 400, "invalid board id");
      if (method === "GET") return await apiGet(res, id);
      if (method === "PUT") return await apiPut(res, req, id);
      if (method === "DELETE") return await apiDelete(res, id);
      return fail(res, 405, "method not allowed");
    }

    if (method !== "GET" && method !== "HEAD") return fail(res, 405, "method not allowed");

    if (path.startsWith("/scenes/")) {
      const file = within(DATA_DIR, path.slice("/scenes/".length));
      if (file && (await serveFile(res, file))) return;
      return fail(res, 404, "scene not found");
    }

    if (path === "/gallery" || path.startsWith("/gallery/")) {
      const rel = path.replace(/^\/gallery\/?/, "");
      const candidate = rel === "" || path.endsWith("/") ? join(rel, "index.html") : rel;
      const file = within(GALLERY_DIR, candidate);
      if (file && (await serveFile(res, file))) return;
      const dirIndex = within(GALLERY_DIR, join(candidate, "index.html"));
      if (dirIndex && (await serveFile(res, dirIndex))) return;
      return fail(res, 404, "not found in gallery");
    }

    // the catalogue is the landing page
    if (path === "/" || path === "/index.html") {
      const home = within(GALLERY_DIR, "index.html");
      if (await serveFile(res, home, { cache: "no-cache" })) return;
    }

    // app shell + its hashed assets
    const asset = within(APP_DIR, path === "/" ? "index.html" : path);
    if (asset && (await serveFile(res, asset, { cache: path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache" }))) {
      return;
    }

    // Only these two shapes are editor routes. Everything else is a genuine
    // 404 — serving the editor shell for any unknown path made a mistyped
    // address look like a broken board.
    const shell = join(APP_DIR, "index.html");
    const boardRoute = path.match(/^\/b\/([^/]+)\/?$/);
    if (boardRoute) {
      const id = decodeURIComponent(boardRoute[1]);
      const known = ID_RE.test(id) && (await fileExists(scenePath(id)));
      // the shell always renders; 404 tells the browser the board is missing
      if (await serveFile(res, shell, { status: known ? 200 : 404 })) return;
    }
    if (path === "/new" || path === "/new/") {
      if (await serveFile(res, shell)) return;
    }
    return send(res, 404, notFoundPage(path), { "Content-Type": "text/html; charset=utf-8" });
  } catch (error) {
    const status = error?.status || 500;
    log("error", method, path, error?.message);
    if (!res.headersSent) fail(res, status, error?.message || "internal error");
    else res.end();
  }
});

server.on("upgrade", (request, socket, head) => {
  let id = null;
  try {
    const match = new URL(request.url, "http://localhost").pathname.match(/^\/ws\/board\/([^/]+)$/);
    if (match) id = decodeURIComponent(match[1]);
  } catch {
    id = null;
  }
  if (!id || !ID_RE.test(id)) {
    socket.destroy();
    return;
  }
  live.handleUpgrade(request, socket, head, (ws) => live.emit("connection", ws, request, id));
});

server.listen(PORT, "0.0.0.0", () => {
  log(`boards server on :${PORT}`);
  log(`data   ${DATA_DIR}`);
  log(`app    ${APP_DIR}`);
  log(`gallery ${GALLERY_DIR}`);
});

#!/usr/bin/env node
/**
 * Catalog check for the groups (หมวดหมู่) UI and the dark/light theme.
 *
 * Builds a throwaway catalogue from three scenes, serves it from a stub API that
 * implements the documented groups contract, and drives headless Chrome over CDP
 * to prove the behaviours the backend worker has to support:
 *
 *   - group bar: "ทั้งหมด" + one chip per group (name + count) + "+ หมวดใหม่"
 *   - the grid is split into one section per group plus "ไม่มีหมวดหมู่"
 *   - a chip filters the grid, search (#q) still hides cards and empty sections
 *   - create / rename / delete a group through the dialogs (POST/PATCH/DELETE)
 *   - the per-card select moves a board (PATCH /api/boards/:id/meta {groupId})
 *   - deleting a group moves its boards back to ungrouped
 *   - the theme toggle flips <html data-theme>, survives a reload, is applied
 *     before the body exists (no flash) and stays readable in both themes
 *
 * Usage: node scripts/test-catalog-groups.mjs
 * Needs: node 22+ (global WebSocket), a local Chrome. Exits non-zero on failure.
 * Screenshots land in /tmp/catalog-groups (override with OUT_DIR).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const OUT = process.env.OUT_DIR || "/tmp/catalog-groups";

const results = [];
let failures = 0;

function check(name, ok, detail = "") {
  const pass = Boolean(ok);
  results.push({ name, ok: pass, detail: String(detail || "") });
  if (!pass) failures += 1;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return pass;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ png io */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** Minimal 8-bit RGB PNG writer: enough for a soft gradient preview. */
function encodePng(width, height, pixel) {
  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * stride] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const at = y * stride + 1 + x * 3;
      raw[at] = r;
      raw[at + 1] = g;
      raw[at + 2] = b;
    }
  }
  const chunks = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    chunks.push(length, body, crc);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  chunk("IHDR", ihdr);
  chunk("IDAT", zlib.deflateSync(raw));
  chunk("IEND", Buffer.alloc(0));
  return Buffer.concat(chunks);
}

/** Decode an 8-bit non-interlaced PNG (RGB or RGBA) so pixels can be measured. */
function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error("not a png");
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const length = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + length);
    pos += 12 + length;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`unsupported bit depth ${data[8]}`);
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced png");
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      const v = line[x];
      let value;
      if (filter === 0) value = v;
      else if (filter === 1) value = v + a;
      else if (filter === 2) value = v + b;
      else if (filter === 3) value = v + ((a + b) >> 1);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value = v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      } else throw new Error(`bad filter ${filter}`);
      cur[x] = value & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, channels, data: out };
}

/** Mean relative luminance of a pixel rectangle (sRGB, 0 = black, 1 = white). */
function meanLuminance(png, region) {
  const { width, channels, data } = png;
  const x0 = Math.max(0, Math.round(region.x));
  const y0 = Math.max(0, Math.round(region.y));
  const x1 = Math.min(png.width, Math.round(region.x + region.width));
  const y1 = Math.min(png.height, Math.round(region.y + region.height));
  let sum = 0;
  let n = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const at = (y * width + x) * channels;
      const lin = (v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      };
      sum += 0.2126 * lin(data[at]) + 0.7152 * lin(data[at + 1]) + 0.0722 * lin(data[at + 2]);
      n += 1;
    }
  }
  return n ? sum / n : 0;
}

/* --------------------------------------------------------------- fixtures */

const SEEDS = [
  { id: "alpha-board", title: "แผนลูกค้า Alpha", subtitle: "deck ลูกค้า" },
  { id: "beta-board", title: "สรุปงาน Beta", subtitle: "งานภายใน" },
  { id: "gamma-board", title: "ทดลอง Gamma", subtitle: "ยังไม่จัดหมวด" },
];

const G1 = "grp_aa11bb22";
const G2 = "grp_cc33dd44";
const G3 = "grp_ee55ff66"; // created by the UI during the run
const G4 = "grp_1234abcd"; // created by the UI during the run

/* ------------------------------------------------------------ stub server */

function createStub(siteDir, slugs) {
  const state = {
    log: [],
    inlineGroupId: false,
    groups: [
      { id: G1, name: "ลูกค้า", color: "violet", createdAt: "2026-11-01T09:00:00.000Z", updatedAt: "2026-11-01T09:00:00.000Z" },
      { id: G2, name: "งานภายใน", color: "teal", createdAt: "2026-11-02T09:00:00.000Z", updatedAt: "2026-11-02T09:00:00.000Z" },
    ],
    membership: new Map([
      [slugs[0], G1],
      [slugs[1], G2],
      [slugs[2], ""],
    ]),
    boards: new Map(
      slugs.map((slug, index) => [
        slug,
        {
          id: slug,
          title: SEEDS[index].title,
          subtitle: SEEDS[index].subtitle,
          updated: Date.UTC(2026, 10, 20 + index, 3, 0, 0),
          bytes: 18_000 + index * 4200,
          elements: 12 + index * 5,
        },
      ]),
    ),
    nextId: 0,
  };

  const countOf = (groupId) => {
    let n = 0;
    for (const value of state.membership.values()) if (value === groupId) n += 1;
    return n;
  };
  const groupJson = (group) => ({ ...group, count: countOf(group.id) });
  const nameTaken = (name, exceptId) =>
    state.groups.some(
      (group) => group.id !== exceptId && group.name.toLowerCase() === name.toLowerCase(),
    );

  const json = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(text);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const pathname = decodeURIComponent(url.pathname);
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsed = null;
      if (body) {
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = null;
        }
      }
      state.log.push({ method: req.method, path: pathname, query: url.search, body: parsed });

      /* static build output */
      if (req.method === "GET" && (pathname === "/" || pathname === "/index.html")) {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(readFileSync(path.join(siteDir, "index.html")));
        return;
      }
      if (req.method === "GET" && pathname === "/favicon.svg") {
        res.writeHead(200, { "content-type": "image/svg+xml" });
        res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" rx="3" fill="#6360d9"/></svg>');
        return;
      }
      if (req.method === "GET" && pathname.startsWith("/gallery/thumbs/")) {
        const file = path.join(siteDir, "thumbs", path.basename(pathname));
        if (!existsSync(file)) return json(res, 404, { error: "no thumb" });
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(readFileSync(file));
        return;
      }
      if (req.method === "GET" && pathname.startsWith("/scenes/")) {
        const file = path.join(siteDir, "scenes", path.basename(pathname));
        if (!existsSync(file)) return json(res, 404, { error: "no scene" });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(readFileSync(file));
        return;
      }
      if (req.method === "GET" && pathname === "/manifest.json") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(readFileSync(path.join(siteDir, "manifest.json")));
        return;
      }

      /* boards */
      if (req.method === "GET" && pathname === "/api/boards") {
        const boards = [...state.boards.values()].map((board) => {
          const out = {
            id: board.id,
            title: board.title,
            subtitle: board.subtitle,
            updated: board.updated,
            bytes: board.bytes,
            elements: board.elements,
          };
          // the documented contract keeps membership out of this list; the flip
          // proves the page also copes when a server does include it
          if (state.inlineGroupId) out.groupId = state.membership.get(board.id) || null;
          return out;
        });
        return json(res, 200, { boards });
      }
      const boardMeta = pathname.match(/^\/api\/boards\/([^/]+)\/meta$/);
      if (boardMeta) {
        const id = boardMeta[1];
        const board = state.boards.get(id);
        if (!board) return json(res, 404, { error: "unknown board" });
        const groupId = state.membership.get(id) || null;
        if (req.method === "GET") {
          return json(res, 200, {
            id,
            title: board.title,
            subtitle: board.subtitle,
            groupId,
            updatedAt: new Date(board.updated).toISOString(),
          });
        }
        if (req.method === "PATCH") {
          if (!parsed || typeof parsed !== "object") return json(res, 400, { error: "bad body" });
          if (typeof parsed.title === "string") board.title = parsed.title.slice(0, 120);
          if (typeof parsed.subtitle === "string") board.subtitle = parsed.subtitle.slice(0, 120);
          if ("groupId" in parsed) {
            const next = parsed.groupId;
            if (next === null || next === "") state.membership.delete(id);
            else if (typeof next === "string" && state.groups.some((g) => g.id === next)) {
              state.membership.set(id, next);
            } else return json(res, 400, { error: "unknown group" });
          }
          board.updated = Date.now();
          return json(res, 200, {
            id,
            title: board.title,
            subtitle: board.subtitle,
            groupId: state.membership.get(id) || null,
          });
        }
        return json(res, 405, { error: "method" });
      }
      const boardOne = pathname.match(/^\/api\/boards\/([^/]+)$/);
      if (boardOne && req.method === "DELETE") {
        const id = boardOne[1];
        if (!state.boards.has(id)) return json(res, 404, { error: "unknown board" });
        state.boards.delete(id);
        state.membership.delete(id);
        return json(res, 200, { deleted: id });
      }

      /* groups */
      if (pathname === "/api/groups" && req.method === "GET") {
        if (state.groupsDisabled) return json(res, 404, { error: "no groups api" });
        return json(res, 200, { groups: state.groups.map(groupJson) });
      }
      if (pathname === "/api/groups" && req.method === "POST") {
        const name = parsed && typeof parsed.name === "string" ? parsed.name.trim() : "";
        const color = parsed && typeof parsed.color === "string" ? parsed.color : "violet";
        if (!name || name.length > 60) return json(res, 400, { error: "bad name" });
        if (nameTaken(name)) return json(res, 409, { error: "duplicate" });
        const group = {
          id: `grp_${(0x10000000 + (state.nextId += 1)).toString(16)}${G3.slice(4, 8)}`.slice(0, 12),
          name,
          color,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        state.groups.push(group);
        return json(res, 201, { group: groupJson(group) });
      }
      const groupOne = pathname.match(/^\/api\/groups\/([^/]+)$/);
      if (groupOne) {
        const id = groupOne[1];
        const group = state.groups.find((item) => item.id === id);
        if (!group) return json(res, 404, { error: "unknown group" });
        if (req.method === "PATCH") {
          const name = parsed && typeof parsed.name === "string" ? parsed.name.trim() : group.name;
          if (!name || name.length > 60) return json(res, 400, { error: "bad name" });
          if (nameTaken(name, id)) return json(res, 409, { error: "duplicate" });
          group.name = name;
          if (parsed && typeof parsed.color === "string") group.color = parsed.color;
          group.updatedAt = new Date().toISOString();
          return json(res, 200, { group: groupJson(group) });
        }
        if (req.method === "DELETE") {
          const moved = countOf(id);
          state.groups = state.groups.filter((item) => item.id !== id);
          for (const [boardId, groupId] of [...state.membership.entries()]) {
            if (groupId === id) state.membership.delete(boardId);
          }
          return json(res, 200, { deleted: id, moved });
        }
      }
      return json(res, 404, { error: `no route ${req.method} ${pathname}` });
    });
  });

  return { server, state, countOf };
}

/* --------------------------------------------------------------- cdp glue */

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result || {});
        return;
      }
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params?.exceptionDetails;
        this.consoleErrors.push(details?.exception?.description || details?.text || "exception");
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
        this.consoleErrors.push(
          (message.params.args || []).map((arg) => arg.value ?? arg.description ?? arg.type).join(" "),
        );
      }
      if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
        this.consoleErrors.push(message.params.entry.text);
      }
    });
  }

  send(method, params = {}) {
    const id = (this.nextId += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { awaitPromise = false } = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error(details.exception?.description || details.text || "evaluate failed");
    }
    return result.result?.value;
  }

  async waitFor(expression, { timeout = 15000, interval = 100, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    let last = "";
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression)) return true;
      } catch (error) {
        last = error.message;
      }
      await sleep(interval);
    }
    throw new Error(`timeout waiting for ${label}${last ? ` (last error: ${last})` : ""}`);
  }

  async click(selector) {
    const box = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const style = getComputedStyle(el);
      if (style.visibility === "hidden" || style.display === "none") return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    if (!box) throw new Error(`cannot click missing/invisible element ${selector}`);
    const hit = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      const r = el.getBoundingClientRect();
      const node = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (!node) return { ok: false, why: "nothing at that point" };
      return {
        ok: node === el || el.contains(node),
        node: node.tagName.toLowerCase() + (node.id ? "#" + node.id : "") + (node.className ? "." + String(node.className).split(" ").join(".") : ""),
      };
    })()`);
    if (!hit.ok) throw new Error(`element ${selector} is covered by ${hit.node} at ${Math.round(box.x)},${Math.round(box.y)}`);
    await sleep(70);
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", {
        type,
        x: box.x,
        y: box.y,
        button: type === "mouseMoved" ? "none" : "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
      });
    }
    return box;
  }

  /* press and hold on one element — needed by the hold-to-delete button */
  async hold(selector, ms) {
    const box = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: Math.round(r.width), h: Math.round(r.height) };
    })()`);
    if (!box) throw new Error(`cannot hold on missing/invisible element ${selector}`);
    await sleep(70);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none", buttons: 0, clickCount: 0 });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", buttons: 1, clickCount: 1 });
    await sleep(ms);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", buttons: 0, clickCount: 1 });
    return box;
  }

  async type(text) {
    await this.send("Input.insertText", { text });
  }

  async press(key, code, vk) {
    const base = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async backspace(times) {
    for (let i = 0; i < times; i += 1) {
      await this.send("Input.dispatchKeyEvent", {
        type: "keyDown",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      });
      await this.send("Input.dispatchKeyEvent", {
        type: "keyUp",
        key: "Backspace",
        code: "Backspace",
        windowsVirtualKeyCode: 8,
        nativeVirtualKeyCode: 8,
      });
    }
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
    await this.waitFor("document.readyState === 'complete'", { label: `load ${url}` });
  }

  async reload() {
    await this.send("Page.reload", { ignoreCache: false });
    await sleep(60);
    await this.waitFor("document.readyState === 'complete'", { label: "reload" });
  }

  /* hide a lingering toast so the captured picture shows the steady state */
  async quiet() {
    await this.evaluate(`(() => {
      const toast = document.getElementById("toast");
      if (toast) { toast.hidden = true; toast.classList.remove("on"); }
    })()`);
    await sleep(90);
  }

  async screenshot(file) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    await writeFile(file, Buffer.from(data, "base64"));
    return file;
  }

  async viewport(width, height) {
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 500,
    });
  }

  async mediaScheme(scheme) {
    await this.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-color-scheme", value: scheme }],
    });
  }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/* ------------------------------------------------------------------- main */

async function main() {
  if (typeof WebSocket !== "function") {
    throw new Error("this check needs node 22+ (global WebSocket)");
  }
  if (!existsSync(CHROME)) throw new Error(`chrome not found at ${CHROME} (set CHROME)`);
  await mkdir(OUT, { recursive: true });

  const tmp = await mkdtemp(path.join(os.tmpdir(), "catalog-groups-"));
  const scenesDir = path.join(tmp, "scenes");
  const siteDir = path.join(tmp, "site");
  const profile = path.join(tmp, "chrome");

  /* --- scenes + previews, then the real build -------------------------- */
  for (const [index, seed] of SEEDS.entries()) {
    const dir = path.join(scenesDir, seed.id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "scene.excalidraw"),
      JSON.stringify({
        type: "excalidraw",
        version: 2,
        source: "test-catalog-groups",
        elements: [{ id: `rect-${index}`, type: "rectangle", x: 10, y: 10, width: 120, height: 80 }],
        appState: { viewBackgroundColor: "#ffffff" },
        files: {},
      }),
    );
    await writeFile(
      path.join(dir, "meta.json"),
      JSON.stringify({ title: seed.title, subtitle: seed.subtitle }, null, 2),
    );
  }
  await mkdir(path.join(siteDir, "thumbs"), { recursive: true });
  for (const [index, seed] of SEEDS.entries()) {
    const hue = [212, 168, 300][index];
    await writeFile(
      path.join(siteDir, "thumbs", `${seed.id}.png`),
      encodePng(320, 200, (x, y) => {
        const t = (x / 320) * 0.6 + (y / 200) * 0.4;
        const clamp = (value) => Math.max(0, Math.min(255, Math.round(value)));
        return [
          clamp(210 - t * 90 - index * 8),
          clamp(220 - t * 70 - hue * 0.08),
          clamp(250 - t * 45 + index * 4),
        ];
      }),
    );
  }

  const buildOut = execFileSync(process.execPath, ["gallery/build.mjs", "--no-render"], {
    cwd: ROOT,
    env: { ...process.env, SCENES_DIR: scenesDir, SITE_DIR: siteDir },
    encoding: "utf8",
  });
  check("build --no-render prints the board count", /\b3 board\(s\) → /.test(buildOut), buildOut.trim().split("\n").pop());
  check("build produced previews for every card", /without preview/.test(buildOut) === false, "no 'without preview' note");

  const manifest = JSON.parse(await readFile(path.join(siteDir, "manifest.json"), "utf8"));
  // the catalogue sorts newest-first, so the manifest order is not the folder
  // order; the fixtures are addressed by slug from here on
  const slugs = SEEDS.map((seed) => seed.id);
  const built = manifest.boards.map((board) => board.id);
  check(
    "build lists one manifest entry per scene",
    built.length === 3 && slugs.every((slug) => built.includes(slug)),
    built.join(", "),
  );

  const stub = createStub(siteDir, slugs);
  await new Promise((resolve) => stub.server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${stub.server.address().port}`;

  /* --- chrome ---------------------------------------------------------- */
  const port = await freePort();
  const { spawn } = await import("node:child_process");
  const browser = spawn(
    CHROME,
    [
      "--headless=new",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-dev-shm-usage",
      "--hide-scrollbars",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      "--window-size=1440,900",
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let cdp = null;
  const cleanup = async () => {
    try {
      browser.kill("SIGKILL");
    } catch {
      /* already gone */
    }
    await new Promise((resolve) => stub.server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  };

  try {
    let targets = null;
    for (let i = 0; i < 120; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        targets = await response.json();
        if (targets.length) break;
      } catch {
        /* chrome still booting */
      }
      await sleep(100);
    }
    const page = targets?.find((target) => target.type === "page");
    if (!page) throw new Error("headless Chrome exposed no page target");

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", reject, { once: true });
    });
    cdp = new CDP(ws);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `
        window.__themeTrace = [];
        const record = (why, theme) => window.__themeTrace.push({
          why,
          theme: theme === undefined ? (document.documentElement && document.documentElement.getAttribute("data-theme")) : theme,
          bodyExists: !!document.body,
          readyState: document.readyState,
        });
        // the page sets the attribute from a synchronous <head> script: wrap
        // setAttribute so we can see whether <body> existed at that moment
        const setAttribute = Element.prototype.setAttribute;
        Element.prototype.setAttribute = function (name, value) {
          if (name === "data-theme" && this === document.documentElement) record("setAttribute", String(value));
          return setAttribute.call(this, name, value);
        };
        document.addEventListener("readystatechange", () => record("readystatechange"));
        requestAnimationFrame(() => record("first-frame"));
      `,
    });

    await cdp.viewport(1440, 900);
    await cdp.mediaScheme("light");

    // membership lands a moment after the first paint (one meta call per card,
    // or one /api/boards answer), so wait for the sections to settle instead of
    // reading the chips too early
    const countsExpr = `[...document.querySelectorAll(".board-section")].map((section) => section.dataset.group + ":" + section.querySelectorAll(".card").length).join("|")`;
    const waitSettled = (expected, label) =>
      cdp.waitFor(`${countsExpr} === ${JSON.stringify(expected)}`, { label });

    await cdp.navigate(`${base}/`);
    await waitSettled(`${G1}:1|${G2}:1|__none__:1`, "initial sections with their boards");

    /* --- 1. chips ------------------------------------------------------ */
    const chips = await cdp.evaluate(`[...document.querySelectorAll("#group-chips .chip")].map((chip) => ({
      key: chip.dataset.group,
      label: chip.textContent.trim().replace(/\\s+/g, " "),
      count: (chip.querySelector(".n") || {}).textContent,
      pressed: chip.getAttribute("aria-pressed"),
      dot: (chip.querySelector(".dot") || {}).className || "",
    }))`);
    check(
      "chip bar: ทั้งหมด + one chip per group",
      chips.length === 3 && chips[0].key === "all" && chips[0].label.startsWith("ทั้งหมด"),
      JSON.stringify(chips.map((chip) => chip.label)),
    );
    check(
      "chips carry the per-group counts from the API",
      chips[1].count === "1" && chips[2].count === "1" && chips[0].count === "3",
      chips.map((chip) => `${chip.label}`).join(" | "),
    );
    check(
      "group chips show their colour dot and ทั้งหมด is the pressed default",
      chips[1].dot.includes("violet") && chips[2].dot.includes("teal") && chips[0].pressed === "true",
      chips.map((chip) => chip.dot.trim()).join(" | "),
    );
    check("a + หมวดใหม่ button sits in the group bar", await cdp.evaluate('!!document.querySelector("#group-new") && !document.querySelector("#groupbar").hidden'), "");

    /* --- 2. sections --------------------------------------------------- */
    const sections = await cdp.evaluate(`[...document.querySelectorAll(".board-section")].map((section) => ({
      key: section.dataset.group,
      name: (section.querySelector(".sect-name") || {}).textContent || "",
      dot: (section.querySelector(".sect-head .dot") || {}).className || "",
      head: !!section.querySelector(".sect-head"),
      cards: [...section.querySelectorAll(".card")].map((card) => card.dataset.slug),
      hidden: section.hidden,
    }))`);
    check(
      "grid is split into one section per group plus ไม่มีหมวดหมู่",
      sections.length === 3 &&
        sections[0].key === G1 &&
        sections[1].key === G2 &&
        sections[2].key === "__none__" &&
        sections[2].name === "ไม่มีหมวดหมู่",
      sections.map((section) => `${section.name || "∅"}:${section.cards.join("+") || "-"}`).join(" | "),
    );
    check(
      "each board sits in its group's section",
      JSON.stringify(sections[0].cards) === JSON.stringify([slugs[0]]) &&
        JSON.stringify(sections[1].cards) === JSON.stringify([slugs[1]]) &&
        JSON.stringify(sections[2].cards) === JSON.stringify([slugs[2]]),
      JSON.stringify(sections.map((section) => section.cards)),
    );
    check(
      "section headings have a colour dot, a name and a count",
      sections[0].dot.includes("violet") && sections[1].dot.includes("teal") && sections[2].dot.includes("slate"),
      sections.map((section) => section.dot.trim()).join(" | "),
    );

    /* --- 3. per-card select -------------------------------------------- */
    const selects = await cdp.evaluate(`[...document.querySelectorAll(".card")].map((card) => {
      const pick = card.querySelector(".group-pick");
      const sel = card.querySelector("select.card-group");
      return {
        slug: card.dataset.slug,
        shown: pick ? !pick.hidden : false,
        options: sel ? [...sel.options].map((option) => [option.value, option.textContent]) : [],
        value: sel ? sel.value : null,
      };
    })`);
    check(
      "every card gets a group select listing ไม่มีหมวดหมู่ + all groups",
      selects.every((row) => row.shown && row.options.length === 3 && row.options[0][0] === "") &&
        selects[0].value === G1 &&
        selects[1].value === G2 &&
        selects[2].value === "",
      JSON.stringify(selects.map((row) => [row.slug, row.value, row.options.length])),
    );

    /* --- 4. chip filtering --------------------------------------------- */
    await cdp.click(`#group-chips .chip[data-group="${G1}"]`);
    await sleep(120);
    const filtered = await cdp.evaluate(`({
      pressed: [...document.querySelectorAll("#group-chips .chip")].map((chip) => chip.getAttribute("aria-pressed")),
      visibleSections: [...document.querySelectorAll(".board-section")].filter((section) => !section.hidden).map((section) => section.dataset.group),
      counter: document.getElementById("count").textContent.trim(),
    })`);
    check(
      "clicking a chip shows only that section",
      JSON.stringify(filtered.visibleSections) === JSON.stringify([G1]) &&
        JSON.stringify(filtered.pressed) === JSON.stringify(["false", "true", "false"]),
      `${filtered.visibleSections.join(",")} · counter=${filtered.counter}`,
    );
    check("counter stays honest under a chip filter", filtered.counter === "1 จาก 3", filtered.counter);

    await cdp.click('#group-chips .chip[data-group="all"]');
    await sleep(120);
    check(
      "ทั้งหมด brings every section back",
      (await cdp.evaluate('[...document.querySelectorAll(".board-section")].filter((section) => !section.hidden).length')) === 3,
      "3 sections visible",
    );

    /* --- 5. create a group --------------------------------------------- */
    const logMark = stub.state.log.length;
    await cdp.click("#group-new");
    await cdp.waitFor('!document.getElementById("group-modal").hidden', { label: "create dialog" });
    check(
      "create dialog opens with the name focused, empty and violet preselected",
      await cdp.evaluate(`document.activeElement === document.getElementById("group-name") &&
        document.getElementById("group-name").value === "" &&
        document.querySelector('input[name="group-color"]:checked').value === "violet"`),
      (await cdp.evaluate('document.getElementById("group-modal-title").textContent')),
    );
    await cdp.type("ทดสอบหมวดใหม่");
    await cdp.click('label.swatch input[value="amber"]');
    await cdp.click("#group-save");
    await cdp.waitFor('document.querySelectorAll("#group-chips .chip").length === 4', { label: "four chips" });
    const created = stub.state.log.slice(logMark).filter((entry) => entry.method === "POST" && entry.path === "/api/groups");
    check(
      "saving POSTs /api/groups with the name and the picked colour",
      created.length === 1 && created[0].body.name === "ทดสอบหมวดใหม่" && created[0].body.color === "amber",
      JSON.stringify(created.map((entry) => entry.body)),
    );
    const afterCreate = await cdp.evaluate(`(() => {
      const chip = [...document.querySelectorAll("#group-chips .chip")].find((item) => item.textContent.includes("ทดสอบหมวดใหม่"));
      const section = [...document.querySelectorAll(".board-section")].find((item) =>
        (item.querySelector(".sect-name") || {}).textContent === "ทดสอบหมวดใหม่");
      return {
        chip: chip ? { key: chip.dataset.group, dot: chip.querySelector(".dot").className, count: chip.querySelector(".n").textContent } : null,
        section: section ? { key: section.dataset.group, hidden: section.hidden, cards: section.querySelectorAll(".card").length } : null,
        chips: document.querySelectorAll("#group-chips .chip").length,
        sections: document.querySelectorAll(".board-section").length,
        toast: document.getElementById("toast").textContent,
      };
    })()`);
    check(
      "the new group appears as a chip and as a (still empty, hidden) section",
      Boolean(afterCreate.chip && afterCreate.section) &&
        afterCreate.chip.dot.includes("amber") &&
        afterCreate.chip.count === "0" &&
        afterCreate.section.hidden === true &&
        afterCreate.sections === 4,
      JSON.stringify(afterCreate),
    );
    check("a toast confirms the new group", afterCreate.toast.includes("ทดสอบหมวดใหม่"), afterCreate.toast);
    const newGroupId = afterCreate.chip.key;

    /* --- 6. rename the group from its section header -------------------- */
    const patchMark = stub.state.log.length;
    await cdp.click(`.sect-btn[data-act="group-rename"][data-group="${G1}"]`);
    await cdp.waitFor('!document.getElementById("group-modal").hidden', { label: "rename dialog" });
    const renamePrefill = await cdp.evaluate(`({
      title: document.getElementById("group-modal-title").textContent,
      value: document.getElementById("group-name").value,
      color: document.querySelector('input[name="group-color"]:checked').value,
    })`);
    check(
      "แก้ชื่อ opens the same dialog, prefilled with the group's name and colour",
      renamePrefill.title === "แก้ชื่อหมวด" && renamePrefill.value === "ลูกค้า" && renamePrefill.color === "violet",
      JSON.stringify(renamePrefill),
    );
    await cdp.type("ลูกค้าใหม่");
    await cdp.click("#group-save");
    await cdp.waitFor(
      `[...document.querySelectorAll(".sect-name")].some((el) => el.textContent === "ลูกค้าใหม่")`,
      { label: "renamed section heading" },
    );
    const renamed = stub.state.log.slice(patchMark).filter((entry) => entry.method === "PATCH" && entry.path === `/api/groups/${G1}`);
    check(
      "rename PATCHes /api/groups/:id and updates the heading and the chip",
      renamed.length === 1 &&
        renamed[0].body.name === "ลูกค้าใหม่" &&
        (await cdp.evaluate(`(() => {
          const chip = document.querySelector('#group-chips .chip[data-group="${G1}"]');
          const section = document.querySelector('.board-section[data-group="${G1}"]');
          return chip.textContent.includes("ลูกค้าใหม่") && section.querySelector(".sect-name").textContent === "ลูกค้าใหม่";
        })()`)),
      JSON.stringify(renamed.map((entry) => entry.body)),
    );

    /* --- 7. a duplicate name shows the inline 409 error ----------------- */
    await cdp.click("#group-new");
    await cdp.waitFor('!document.getElementById("group-modal").hidden', { label: "create dialog again" });
    await cdp.type("ลูกค้าใหม่");
    await cdp.click("#group-save");
    await cdp.waitFor('!document.getElementById("group-note").hidden', { label: "inline error" });
    const dupNote = await cdp.evaluate('document.getElementById("group-note").textContent');
    check("a duplicate name is reported inline, dialog stays open", dupNote.includes("มีชื่อหมวดนี้อยู่แล้ว") && (await cdp.evaluate('!document.getElementById("group-modal").hidden')), dupNote);
    await cdp.click("#group-cancel");

    /* --- 8. move a board with the card select --------------------------- */
    const moveMark = stub.state.log.length;
    await cdp.evaluate(`(() => {
      const card = document.querySelector('.card[data-slug="${slugs[1]}"]');
      const sel = card.querySelector("select.card-group");
      sel.value = "${newGroupId}";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    })()`);
    await cdp.waitFor(
      `document.querySelector('.board-section[data-group="${newGroupId}"] .card[data-slug="${slugs[1]}"]') !== null`,
      { label: "card moved into the new section" },
    );
    const moved = stub.state.log.slice(moveMark).filter(
      (entry) => entry.method === "PATCH" && entry.path === `/api/boards/${slugs[1]}/meta`,
    );
    check(
      "changing the card select PATCHes {groupId} and moves the card without reload",
      moved.length === 1 && moved[0].body.groupId === newGroupId,
      JSON.stringify(moved.map((entry) => entry.body)),
    );
    const afterMove = await cdp.evaluate(`({
      sections: [...document.querySelectorAll(".board-section")].map((section) => [section.dataset.group, section.hidden, section.querySelectorAll(".card").length]),
      counts: [...document.querySelectorAll("#group-chips .chip .n")].map((el) => el.textContent),
      options: [...document.querySelectorAll('.card[data-slug="${slugs[1]}"] select.card-group option')].map((option) => option.value),
      selectValue: document.querySelector('.card[data-slug="${slugs[1]}"] select.card-group').value,
    })`);
    check(
      "chip counts and the new section follow the move",
      afterMove.selectValue === newGroupId &&
        JSON.stringify(afterMove.counts) === JSON.stringify(["3", "1", "0", "1"]),
      JSON.stringify(afterMove.counts),
    );

    /* --- 9. delete the group ------------------------------------------- */
    const delMark = stub.state.log.length;
    await cdp.click(`.sect-btn[data-act="group-del"][data-group="${newGroupId}"]`);
    await cdp.waitFor('!document.getElementById("group-del-modal").hidden', { label: "delete-group dialog" });
    const delText = await cdp.evaluate('document.getElementById("group-del-detail").textContent');
    check(
      "delete dialog explains the boards move to ไม่มีหมวดหมู่",
      delText.includes("ไม่มีหมวดหมู่") && delText.includes("ไม่ถูกลบ"),
      delText,
    );
    await cdp.click("#group-del-confirm");
    await cdp.waitFor('document.querySelectorAll("#group-chips .chip").length === 3', { label: "chip removed" });
    const deleted = stub.state.log.slice(delMark).filter(
      (entry) => entry.method === "DELETE" && entry.path === `/api/groups/${newGroupId}`,
    );
    const afterDelete = await cdp.evaluate(`({
      noneCards: [...document.querySelector('.board-section[data-group="__none__"]').querySelectorAll(".card")].map((card) => card.dataset.slug),
      sections: document.querySelectorAll(".board-section").length,
      toast: document.getElementById("toast").textContent,
    })`);
    check(
      "deleting a group DELETEs it and its boards fall back to ไม่มีหมวดหมู่",
      deleted.length === 1 &&
        afterDelete.noneCards.includes(slugs[1]) &&
        afterDelete.sections === 3,
      `${JSON.stringify(afterDelete.noneCards)} · ${afterDelete.toast}`,
    );

    /* --- 10. search ----------------------------------------------------- */
    await cdp.click("#q");
    await cdp.type("alpha");
    await cdp.waitFor(`document.getElementById("count").textContent.trim() === "1 จาก 3"`, { label: "search counter" });
    const searched = await cdp.evaluate(`({
      counter: document.getElementById("count").textContent.trim(),
      visibleCards: [...document.querySelectorAll(".card")].filter((card) => !card.hidden).map((card) => card.dataset.slug),
      visibleSections: [...document.querySelectorAll(".board-section")].filter((section) => !section.hidden).map((section) => section.dataset.group),
      emptyHidden: document.getElementById("empty").hidden,
    })`);
    check(
      "search hides non-matching cards and their empty sections",
      JSON.stringify(searched.visibleCards) === JSON.stringify([slugs[0]]) &&
        searched.visibleSections.length === 1 &&
        searched.emptyHidden === true &&
        searched.counter === "1 จาก 3",
      JSON.stringify(searched),
    );
    await cdp.backspace(5);
    await cdp.waitFor(`document.getElementById("count").textContent.trim() === "3 กระดาน"`, { label: "search cleared" });
    check(
      "clearing the search brings every card back",
      (await cdp.evaluate('[...document.querySelectorAll(".card")].filter((card) => !card.hidden).length')) === 3,
      "3 cards visible",
    );
    // a search that matches nothing must keep the counter at 0 of N
    await cdp.type("zzzz");
    await cdp.waitFor(`document.getElementById("count").textContent.trim() === "0 จาก 3"`, { label: "empty search" });
    check(
      "a search with no hits shows 0 จาก 3 and the empty note",
      await cdp.evaluate('!document.getElementById("empty").hidden && document.querySelectorAll(".board-section:not([hidden])").length === 0'),
      await cdp.evaluate('document.getElementById("empty").textContent'),
    );
    await cdp.backspace(4);
    await cdp.waitFor(`document.getElementById("count").textContent.trim() === "3 กระดาน"`, { label: "search cleared again" });

    /* --- 11. theme ------------------------------------------------------ */
    const lightTheme = await cdp.evaluate(`({
      theme: document.documentElement.getAttribute("data-theme"),
      stored: localStorage.getItem("boards-theme"),
      glyph: document.querySelector("#theme-toggle .theme-glyph").textContent,
      label: document.getElementById("theme-toggle").getAttribute("aria-label"),
      bg: getComputedStyle(document.documentElement).backgroundColor,
      bodyColor: getComputedStyle(document.body).color,
      cardImage: getComputedStyle(document.querySelector(".card")).backgroundImage,
      chipBg: getComputedStyle(document.querySelector("#group-chips .chip:not([aria-pressed='true'])")).backgroundColor,
      pressedChipBg: getComputedStyle(document.querySelector('#group-chips .chip[aria-pressed="true"]')).backgroundColor,
      headBg: getComputedStyle(document.querySelector("header")).backgroundImage,
      modalBg: getComputedStyle(document.querySelector("#group-modal .modal-card")).backgroundImage,
      inputBg: getComputedStyle(document.getElementById("q")).backgroundColor,
      footer: getComputedStyle(document.querySelector("footer")).color,
    })`);
    check(
      "pages default to the OS scheme (light here), with no stored choice yet",
      lightTheme.theme === "light" && lightTheme.stored === null && lightTheme.glyph === "☾",
      JSON.stringify(lightTheme),
    );
    await cdp.quiet();
    const lightShot = await cdp.screenshot(path.join(OUT, "01-light-groups.png"));
    await cdp.click("#group-new");
    await cdp.waitFor('!document.getElementById("group-modal").hidden', { label: "dialog for the shot" });
    await cdp.quiet();
    const modalShot = await cdp.screenshot(path.join(OUT, "02-light-group-dialog.png"));
    await cdp.click("#group-cancel");

    await cdp.click("#theme-toggle");
    await cdp.waitFor(`document.documentElement.getAttribute("data-theme") === "dark"`, { label: "dark theme" });
    await sleep(320); // .chip/.modal backgrounds transition over 120ms
    const darkTheme = await cdp.evaluate(`({
      theme: document.documentElement.getAttribute("data-theme"),
      stored: localStorage.getItem("boards-theme"),
      glyph: document.querySelector("#theme-toggle .theme-glyph").textContent,
      label: document.getElementById("theme-toggle").getAttribute("aria-label"),
      bg: getComputedStyle(document.documentElement).backgroundColor,
      bodyColor: getComputedStyle(document.body).color,
      cardImage: getComputedStyle(document.querySelector(".card")).backgroundImage,
      chipBg: getComputedStyle(document.querySelector("#group-chips .chip:not([aria-pressed='true'])")).backgroundColor,
      pressedChipBg: getComputedStyle(document.querySelector('#group-chips .chip[aria-pressed="true"]')).backgroundColor,
      headBg: getComputedStyle(document.querySelector("header")).backgroundImage,
      modalBg: getComputedStyle(document.querySelector("#group-modal .modal-card")).backgroundImage,
      inputBg: getComputedStyle(document.getElementById("q")).backgroundColor,
      footer: getComputedStyle(document.querySelector("footer")).color,
      bodyShotLum: null,
    })`);
    check(
      "the toggle flips <html data-theme> to dark and stores the choice",
      darkTheme.theme === "dark" && darkTheme.stored === "dark" && darkTheme.glyph === "☀",
      `theme=${darkTheme.theme} stored=${darkTheme.stored} label=${darkTheme.label}`,
    );
    const repainted = ["bg", "cardImage", "chipBg", "pressedChipBg", "headBg", "modalBg", "inputBg", "footer", "bodyColor"].filter(
      (key) => lightTheme[key] !== darkTheme[key],
    );
    check(
      "dark theme really repaints the page, header, cards, chips, inputs and dialogs",
      repainted.length === 9 &&
        darkTheme.cardImage.includes("rgba(32, 37, 58") &&
        !darkTheme.cardImage.includes("rgba(255, 255, 255, 0.42") &&
        darkTheme.inputBg !== "rgb(255, 255, 255)",
      `repainted ${repainted.join(",")} · card ${lightTheme.cardImage} → ${darkTheme.cardImage}`,
    );
    await cdp.quiet();
    const darkShot = await cdp.screenshot(path.join(OUT, "03-dark-groups.png"));
    await cdp.click("#group-new");
    await cdp.waitFor('!document.getElementById("group-modal").hidden', { label: "dark dialog" });
    await cdp.quiet();
    const darkModalShot = await cdp.screenshot(path.join(OUT, "04-dark-group-dialog.png"));
    await cdp.click("#group-cancel");

    /* contrast from computed colours (AA for body text, muted included) */
    const contrast = await cdp.evaluate(`(() => {
      const rgb = (value) => (value.match(/[\\d.]+/g) || []).map(Number);
      const lum = ([r, g, b]) => {
        const f = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const ratio = (fg, bg) => {
        const [hi, lo] = [lum(rgb(fg)), lum(rgb(bg))].sort((a, b) => b - a);
        return Math.round(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
      };
      const bg = getComputedStyle(document.documentElement).backgroundColor;
      const card = document.querySelector(".card");
      return {
        bg,
        body: ratio(getComputedStyle(document.body).color, bg),
        heading: ratio(getComputedStyle(card.querySelector("h2")).color, bg),
        muted: ratio(getComputedStyle(card.querySelector(".meta")).color, bg),
        chip: ratio(getComputedStyle(document.querySelector("#group-chips .chip")).color, bg),
        footer: ratio(getComputedStyle(document.querySelector("footer")).color, bg),
        sectName: ratio(getComputedStyle(document.querySelector(".sect-name")).color, bg),
      };
    })()`);
    check(
      "dark theme keeps every text token above AA (4.5:1) against the page",
      ["body", "heading", "muted", "chip", "footer", "sectName"].every((key) => contrast[key] >= 4.5),
      JSON.stringify(contrast),
    );
    const darkPng = decodePng(await readFile(darkShot));
    const darkLum = meanLuminance(darkPng, {
      x: darkPng.width - 120,
      y: 160,
      width: 90,
      height: 220,
    });
    const lightPng = decodePng(await readFile(lightShot));
    const lightLum = meanLuminance(lightPng, {
      x: lightPng.width - 120,
      y: 160,
      width: 90,
      height: 220,
    });
    check(
      "the painted page is genuinely dark vs light (mean luminance of a card-free strip)",
      darkLum < 0.2 && lightLum > 0.5,
      `dark=${darkLum.toFixed(3)} light=${lightLum.toFixed(3)}`,
    );

    /* survives a reload + no flash before paint */
    await cdp.reload();
    await waitSettled(`${G1}:1|${G2}:0|__none__:2`, "sections after reload");
    const afterReload = await cdp.evaluate(`({
      theme: document.documentElement.getAttribute("data-theme"),
      stored: localStorage.getItem("boards-theme"),
      trace: window.__themeTrace || [],
    })`);
    const firstAttribute = (afterReload.trace || []).find((entry) => entry.theme);
    check(
      "the chosen theme survives a reload",
      afterReload.theme === "dark" && afterReload.stored === "dark",
      `theme=${afterReload.theme} stored=${afterReload.stored}`,
    );
    check(
      "data-theme is set before <body> exists (no flash of the wrong palette)",
      Boolean(firstAttribute) && firstAttribute.bodyExists === false,
      JSON.stringify(firstAttribute || {}),
    );

    /* layout parity between the two palettes */
    const geometryDark = await cdp.evaluate(`(() => {
      const header = document.querySelector("header").getBoundingClientRect();
      const card = document.querySelector(".card").getBoundingClientRect();
      return { header: Math.round(header.height), card: Math.round(card.width), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    })()`);
    await cdp.click("#theme-toggle");
    await cdp.waitFor(`document.documentElement.getAttribute("data-theme") === "light"`, { label: "back to light" });
    await sleep(320);
    const geometryLight = await cdp.evaluate(`(() => {
      const header = document.querySelector("header").getBoundingClientRect();
      const card = document.querySelector(".card").getBoundingClientRect();
      return { header: Math.round(header.height), card: Math.round(card.width), overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    })()`);
    check(
      "both themes keep the same layout and never overflow horizontally",
      geometryDark.header === geometryLight.header &&
        geometryDark.card === geometryLight.card &&
        geometryDark.overflow <= 1 &&
        geometryLight.overflow <= 1,
      `dark=${JSON.stringify(geometryDark)} light=${JSON.stringify(geometryLight)}`,
    );
    check("the light choice is stored as well", (await cdp.evaluate('localStorage.getItem("boards-theme")')) === "light", "");

    /* the OS preference decides when nothing is stored */
    await cdp.evaluate('localStorage.removeItem("boards-theme")');
    await cdp.mediaScheme("dark");
    await cdp.reload();
    await cdp.waitFor(`document.documentElement.getAttribute("data-theme") === "dark"`, { label: "OS dark default" });
    check(
      "with nothing stored the OS preference wins",
      (await cdp.evaluate('localStorage.getItem("boards-theme")')) === null,
      "data-theme=dark, storage untouched",
    );
    await cdp.mediaScheme("light");
    await cdp.reload();
    await cdp.waitFor(`document.documentElement.getAttribute("data-theme") === "light"`, { label: "OS light default" });

    /* --- 12. membership without per-card meta (inline groupId) ---------- */
    stub.state.inlineGroupId = true;
    const inlineMark = stub.state.log.length;
    await cdp.reload();
    await waitSettled(`${G1}:1|${G2}:0|__none__:2`, "sections after inline reload");
    await sleep(400);
    const inlineSections = await cdp.evaluate(`[...document.querySelectorAll(".board-section")].map((section) => [section.dataset.group, [...section.querySelectorAll(".card")].map((card) => card.dataset.slug)])`);
    const inlineMetaCalls = stub.state.log
      .slice(inlineMark)
      .filter((entry) => entry.method === "GET" && /^\/api\/boards\/[^/]+\/meta$/.test(entry.path)).length;
    check(
      "when /api/boards carries groupId the page skips the per-card meta calls",
      inlineMetaCalls === 0 &&
        JSON.stringify(inlineSections) === JSON.stringify([[G1, [slugs[0]]], [G2, []], ["__none__", [slugs[2], slugs[1]]]]),
      `meta calls=${inlineMetaCalls} sections=${JSON.stringify(inlineSections)}`,
    );
    stub.state.inlineGroupId = false;

    /* the documented contract (no groupId in /api/boards) uses per-card meta */
    const metaMark = stub.state.log.length;
    await cdp.reload();
    await waitSettled(`${G1}:1|${G2}:0|__none__:2`, "sections after meta reload");
    await sleep(500);
    const metaCalls = stub.state.log
      .slice(metaMark)
      .filter((entry) => entry.method === "GET" && /^\/api\/boards\/[^/]+\/meta$/.test(entry.path));
    check(
      "without groupId in /api/boards the page falls back to GET /api/boards/:id/meta per card",
      metaCalls.length === 3 && JSON.stringify(metaCalls.map((entry) => entry.path).sort()) === JSON.stringify(slugs.map((slug) => `/api/boards/${slug}/meta`).sort()),
      `${metaCalls.length} meta calls`,
    );

    /* a backend without the groups API must not break the catalogue */
    stub.state.groupsDisabled = true;
    await cdp.reload();
    await sleep(700);
    const flat = await cdp.evaluate(`({
      sections: document.querySelectorAll(".board-section").length,
      cards: document.querySelectorAll(".card").length,
      count: document.getElementById("count").textContent,
      picks: document.querySelectorAll("label.group-pick:not([hidden])").length,
      bar: document.getElementById("groupbar").hidden,
      grid: document.getElementById("grid") !== null,
    })`);
    check(
      "a 404 from /api/groups degrades to the old flat grid",
      flat.sections === 0 && flat.cards === 3 && flat.count === "3 กระดาน" && flat.picks === 0 && flat.bar === true && flat.grid === true,
      JSON.stringify(flat),
    );
    stub.state.groupsDisabled = false;

    /* --- 13. mobile, light + dark -------------------------------------- */
    await cdp.viewport(393, 852);
    await cdp.reload();
    await waitSettled(`${G1}:1|${G2}:0|__none__:2`, "sections on mobile");
    const mobileLight = await cdp.evaluate(`({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      chipsWrapped: document.getElementById("groupbar").getBoundingClientRect().height > 0,
      card: Math.round(document.querySelector(".card").getBoundingClientRect().width),
    })`);
    await cdp.quiet();
    const mobileLightShot = await cdp.screenshot(path.join(OUT, "05-mobile-light.png"));
    await cdp.click("#theme-toggle");
    await cdp.waitFor(`document.documentElement.getAttribute("data-theme") === "dark"`, { label: "mobile dark" });
    await sleep(320);
    const mobileDark = await cdp.evaluate(`({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      card: Math.round(document.querySelector(".card").getBoundingClientRect().width),
    })`);
    await cdp.quiet();
    const mobileDarkShot = await cdp.screenshot(path.join(OUT, "06-mobile-dark.png"));
    check(
      "the mobile layout keeps the group bar usable and never scrolls sideways",
      mobileLight.overflow <= 1 && mobileDark.overflow <= 1 && mobileLight.card === mobileDark.card,
      `light=${JSON.stringify(mobileLight)} dark=${JSON.stringify(mobileDark)}`,
    );
    await cdp.viewport(1440, 900);

    /* --- 14. the untouched card actions still work --------------------- */
    const titleMark = stub.state.log.length;
    await cdp.click(`.card[data-slug="${slugs[2]}"] .rename`);
    await cdp.waitFor(`document.getElementById("rename-modal").hidden === false`, { label: "rename dialog" });
    await cdp.type("ชื่อใหม่ Gamma");
    await cdp.click("#rename-save");
    await cdp.waitFor(`document.querySelector('.card[data-slug="${slugs[2]}"] h2').textContent === "ชื่อใหม่ Gamma"`, { label: "card title updated" });
    const titlePatch = stub.state.log
      .slice(titleMark)
      .filter((entry) => entry.method === "PATCH" && entry.path === `/api/boards/${slugs[2]}/meta`);
    check(
      "the existing card rename still PATCHes the title and repaints the heading",
      titlePatch.length === 1 && titlePatch[0].body.title === "ชื่อใหม่ Gamma",
      JSON.stringify(titlePatch.map((entry) => entry.body)),
    );

    const deleteMark = stub.state.log.length;
    await cdp.click(`.card[data-slug="${slugs[1]}"] .del`);
    await cdp.waitFor(`document.getElementById("del-modal").hidden === false`, { label: "delete dialog" });
    await cdp.hold("#del-hold", 1350);
    await cdp.waitFor(`document.querySelector('.card[data-slug="${slugs[1]}"]') === null`, { label: "card deleted" });
    const cardDeletes = stub.state.log
      .slice(deleteMark)
      .filter((entry) => entry.method === "DELETE" && entry.path === `/api/boards/${slugs[1]}`);
    const afterCardDelete = await cdp.evaluate(`({
      count: document.getElementById("count").textContent,
      sections: [...document.querySelectorAll(".board-section")].filter((s) => !s.hidden).map((s) => s.dataset.group + ":" + s.querySelectorAll(".card").length),
    })`);
    check(
      "the existing hold-to-delete still removes the card, DELETEs it and keeps the rest coherent",
      cardDeletes.length === 1 && afterCardDelete.count === "2 กระดาน" && JSON.stringify(afterCardDelete.sections) === JSON.stringify([G1 + ":1", "__none__:1"]),
      `delete=${JSON.stringify(cardDeletes.map((entry) => entry.path))} after=${JSON.stringify(afterCardDelete)}`,
    );

    /* --- 15. console hygiene ------------------------------------------- */
    // "Failed to load resource" lines are the 409/404 answers this check
    // provokes on purpose (duplicate name, unknown group); the page handles
    // them inline, which the assertions above already cover
    const errors = cdp.consoleErrors.filter(
      (line) =>
        !/Permissions policy violation/i.test(line) &&
        !/favicon/i.test(line) &&
        !/Failed to load resource/i.test(line),
    );
    check("no console errors or exceptions along the way", errors.length === 0, errors.slice(0, 3).join(" | "));

    /* --- summary -------------------------------------------------------- */
    console.log("\nshots:");
    for (const shot of [lightShot, modalShot, darkShot, darkModalShot, mobileLightShot, mobileDarkShot]) {
      console.log(`  ${shot}`);
    }
    console.log(`\ncontrast (dark): ${JSON.stringify(contrast)}`);
    console.log(`page luminance: light=${lightLum.toFixed(3)} dark=${darkLum.toFixed(3)}`);
    console.log(`body text: light ${lightTheme.bodyColor} on ${lightTheme.bg} · dark ${darkTheme.bodyColor} on ${darkTheme.bg}`);
    console.log(`chips  : light ${lightTheme.chipBg} / pressed ${lightTheme.pressedChipBg} · dark ${darkTheme.chipBg} / pressed ${darkTheme.pressedChipBg}`);
    console.log(`inputs : light ${lightTheme.inputBg} · dark ${darkTheme.inputBg}`);
  } finally {
    await cleanup();
  }

  const passed = results.filter((entry) => entry.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  if (failures) {
    console.log("\nfailures:");
    for (const entry of results.filter((item) => !item.ok)) console.log(`  - ${entry.name} (${entry.detail})`);
  }
  process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.stack || error.message}`);
  process.exitCode = 1;
});

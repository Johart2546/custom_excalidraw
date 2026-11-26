#!/usr/bin/env node
/**
 * scripts/test-live-save.mjs — two tabs, one board: the save pill must settle.
 *
 * The bug this guards: each tab applied the other's scene, Excalidraw bumped
 * versions while applying, both looked dirty and traded the file forever — the
 * pill never left "saving" and the history folder grew a snapshot every second.
 *
 *   node scripts/test-live-save.mjs [--headed]
 *
 * Spawns app/server.mjs on a random port with a throwaway DATA_DIR, drives a
 * real Chrome over CDP, and needs no dependencies beyond Node and Chrome.
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(HERE, "..");
const SERVER = join(ROOT, "app", "server.mjs");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HEADED = process.argv.includes("--headed");
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

let passed = 0;
const failures = [];
async function step(name, fn) {
  try {
    await fn();
    passed += 1;
    process.stdout.write(`  ✓ ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  ✗ ${name}\n    ${error?.message || error}\n`);
  }
}
const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

async function freePort() {
  return new Promise((ok, no) => {
    const probe = createServer();
    probe.on("error", no);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => ok(port));
    });
  });
}

async function waitServer(base) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${base}/api/boards`);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error("server did not start");
}

/* ------------------------------------------------------------------- chrome */

async function attach(url) {
  const socket = new WebSocket(url);
  await new Promise((ok, no) => {
    socket.addEventListener("open", ok, { once: true });
    socket.addEventListener("error", () => no(new Error("cdp socket failed")), { once: true });
  });
  let next = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    const waiter = pending.get(message.id);
    if (waiter) {
      pending.delete(message.id);
      waiter(message);
    }
  });
  const send = (method, params = {}) => {
    const id = (next += 1);
    socket.send(JSON.stringify({ id, method, params }));
    return new Promise((ok) => pending.set(id, ok));
  };
  const evaluate = async (expression) => {
    const reply = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (reply.result?.exceptionDetails) {
      throw new Error(`page error: ${reply.result.exceptionDetails.exception?.description || reply.result.exceptionDetails.text}`);
    }
    return reply.result?.result?.value;
  };
  return { socket, send, evaluate };
}

const PILL = `(() => {
  const el = document.querySelector(".save-pill");
  if (!el) return null;
  return { kind: el.className.replace("save-pill", "").trim(), text: el.textContent };
})()`;

/** Wait until the visible pill lands on a kind ("saved" / "saving" / "error"). */
async function waitPill(page, kind, timeout = 15000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    last = await page.evaluate(PILL);
    if (last && last.kind === kind) return last;
    await sleep(120);
  }
  throw new Error(`pill never reached "${kind}" (last ${JSON.stringify(last)})`);
}

/** Draw a rectangle straight on the canvas with real mouse input. */
async function drawRect(page, x, y) {
  const before = await page.evaluate(`window.__boardsApi.getSceneElements().length`);
  // A background tab still takes pointer input but swallows the "r" shortcut,
  // so pick the rectangle tool the way a person would: click its button.
  await page.evaluate(`window.focus()`);
  const tool = await page.evaluate(`(() => {
    const nodes = [...document.querySelectorAll(".App-toolbar label, .App-toolbar button, .App-toolbar .ToolIcon")];
    const target = nodes.find((node) => /Rectangle/i.test(node.title || node.getAttribute("aria-label") || ""));
    return target ? (target.click(), true) : false;
  })()`);
  assert(tool, "the rectangle tool is not in the toolbar");
  await sleep(150);
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: x + 110, y: y + 80, button: "left", buttons: 1 });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: x + 110, y: y + 80, button: "left", clickCount: 1 });
  for (let i = 0; i < 40; i += 1) {
    if ((await page.evaluate(`window.__boardsApi.getSceneElements().length`)) > before) return true;
    await sleep(100);
  }
  throw new Error("the canvas did not take the rectangle");
}

/* --------------------------------------------------------------------- main */

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const dataDir = await mkdtemp(join(tmpdir(), "live-save-"));
const server = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  stdio: "ignore",
  env: { ...process.env, PORT: String(port), DATA_DIR: join(dataDir, "scenes"), GALLERY_DIR: join(dataDir, "site"), APP_DIR: join(ROOT, "app", "dist") },
});
const debugPort = await freePort();
const profile = await mkdtemp(join(tmpdir(), "live-save-chrome-"));
const chrome = spawn(
  CHROME,
  [
    HEADED ? "--headless=false" : "--headless=new",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--hide-scrollbars",
    "--window-size=1200,820",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);
const cleanup = () => {
  try {
    chrome.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  try {
    server.kill("SIGKILL");
  } catch {
    /* already gone */
  }
};
process.on("exit", cleanup);

try {
  await waitServer(base);
  const board = await (await fetch(`${base}/api/boards`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "live-save" }) })).json();
  const url = `${base}/b/${board.id}`;

  await sleep(1400);
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const first = await attach(targets.find((t) => t.type === "page").webSocketDebuggerUrl);
  await first.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await first.send("Page.navigate", { url });
  await first.send("Target.createTarget", { url });
  await sleep(2500);

  const tabs = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const second = await attach(tabs.filter((t) => t.type === "page" && t.url.includes(`/b/${board.id}`)).pop().webSocketDebuggerUrl);
  await second.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  for (const page of [first, second]) {
    for (let i = 0; i < 80; i += 1) {
      if (await page.evaluate(`!!window.__boardsApi && !!document.querySelector(".save-pill")`)) break;
      await sleep(100);
    }
  }

  const newest = async () => {
    const history = await (await fetch(`${base}/api/boards/${board.id}/history`)).json();
    return (history.history || [])[0]?.name || "";
  };

  await step("both tabs settle on saved before anything happens", async () => {
    await waitPill(first, "saved");
    await waitPill(second, "saved");
  });

  await step("a rectangle in one tab is written once and both pills settle", async () => {
    const before = await newest();
    await drawRect(first, 320, 260);
    await waitPill(first, "saved");
    await waitPill(second, "saved");
    const after = await newest();
    assert(after !== before || before === "", "the write never reached the board file");
  });

  await step("the two tabs stop rewriting each other", async () => {
    const settled = await newest();
    await sleep(4000);
    assert((await newest()) === settled, "the history kept growing: the tabs are still trading the file");
    assert((await first.evaluate(PILL)).kind === "saved", "tab A is not saved");
    assert((await second.evaluate(PILL)).kind === "saved", "tab B is not saved");
  });

  await step("the other tab can still save its own edit", async () => {
    const before = await newest();
    await drawRect(second, 700, 420);
    await waitPill(second, "saved");
    await waitPill(first, "saved");
    const after = await newest();
    assert(after !== before, "the second tab's edit never reached the board file");
  });
} finally {
  cleanup();
  await rm(dataDir, { recursive: true, force: true });
  await rm(profile, { recursive: true, force: true });
}

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) process.exit(1);

#!/usr/bin/env node
/**
 * End-to-end check for the glass UI, board rename, presence and catalog.
 *
 * Needs the app server and a headless Chrome. Usage:
 *   node scripts/e2e-ui.mjs [baseUrl]
 * default baseUrl: http://127.0.0.1:5792
 *
 * Exits non-zero on the first failing assertion group and prints every failure.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import WebSocket from "../app/node_modules/ws/index.js";

const BASE = (process.argv[2] || "http://127.0.0.1:5792").replace(/\/$/, "");
const CHROME =
  process.env.CHROME ||
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BOARD = "e2e-ui-probe";
const results = [];
let browser;
let cdp;
let deleteProbe = null;

function check(name, ok, detail = "") {
  results.push({ name, ok: Boolean(ok), detail: String(detail || "") });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return Boolean(ok);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    this.consoleErrors = [];
    ws.on("message", (raw) => {
      const message = JSON.parse(raw.toString());
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${message.error.code}: ${message.error.message}`));
        else pending.resolve(message.result || {});
        return;
      }
      this.events.push(message);
      if (message.method === "Runtime.exceptionThrown") {
        const details = message.params?.exceptionDetails;
        this.consoleErrors.push(details?.exception?.description || details?.text || "exception");
      }
      if (message.method === "Runtime.consoleAPICalled" && message.params?.type === "error") {
        this.consoleErrors.push(
          (message.params.args || [])
            .map((arg) => arg.value ?? arg.description ?? arg.type)
            .join(" "),
        );
      }
      if (message.method === "Log.entryAdded" && message.params?.entry?.level === "error") {
        this.consoleErrors.push(message.params.entry.text);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.nextId;
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
      const text =
        result.exceptionDetails.exception?.description ||
        result.exceptionDetails.text ||
        "evaluate failed";
      throw new Error(text);
    }
    return result.result?.value;
  }

  async waitFor(expression, { timeout = 12000, interval = 120, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    let lastError = "";
    while (Date.now() < deadline) {
      try {
        if (await this.evaluate(expression)) return true;
      } catch (error) {
        lastError = error.message;
      }
      await sleep(interval);
    }
    throw new Error(`timeout waiting for ${label}${lastError ? ` (last: ${lastError})` : ""}`);
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
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);
    if (!box) throw new Error(`cannot click missing/invisible element ${selector}`);
    await sleep(80);
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

  async clickPoint(x, y) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
      await this.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button: type === "mouseMoved" ? "none" : "left",
        buttons: type === "mousePressed" ? 1 : 0,
        clickCount: 1,
      });
    }
  }

  async hold(selector, ms) {
    const box = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`cannot hold missing/invisible element ${selector}`);
    await sleep(80);
    const base = { x: box.x, y: box.y, button: "left", clickCount: 1 };
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...base, button: "none", buttons: 0 });
    await this.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base, buttons: 1 });
    await sleep(ms);
    await this.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base, buttons: 0 });
    return box;
  }

  async drag(selector, dx, dy) {
    const box = await this.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!box) throw new Error(`drag: no box for ${selector}`);
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: box.x,
      y: box.y,
      button: "none",
      buttons: 0,
    });
    await this.send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: box.x,
      y: box.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    for (let step = 1; step <= 8; step += 1) {
      await this.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: box.x + (dx * step) / 8,
        y: box.y + (dy * step) / 8,
        button: "left",
        buttons: 1,
      });
      await sleep(16);
    }
    await this.send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: box.x + dx,
      y: box.y + dy,
      button: "left",
      buttons: 0,
      clickCount: 1,
    });
    return box;
  }

  async type(text) {
    await this.send("Input.insertText", { text });
  }

  async key(key, code, vk) {
    const base = {
      key,
      code,
      windowsVirtualKeyCode: vk,
      nativeVirtualKeyCode: vk,
    };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...base });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async navigate(url) {
    await this.send("Page.navigate", { url });
    await this.waitFor("document.readyState === 'complete'", { label: `load ${url}` });
  }

  async screenshot(file) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    await writeFile(file, Buffer.from(data, "base64"));
  }

  async viewport(width, height, mobile = false) {
    if (width == null) {
      await this.send("Emulation.clearDeviceMetricsOverride");
      return;
    }
    await this.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
    });
  }
}

async function api(pathname, options) {
  const response = await fetch(`${BASE}${pathname}`, options);
  const text = await response.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { status: response.status, body };
}

async function deleteBoard(id) {
  await api(`/api/boards/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
}

function metaTitle(id) {
  return api(`/api/boards/${encodeURIComponent(id)}/meta`).then((r) => r.body?.title);
}

async function boardElementCount() {
  const response = await api(`/api/boards/${encodeURIComponent(BOARD)}`);
  return Array.isArray(response.body?.elements) ? response.body.elements.length : -1;
}

async function waitForBoardCount(min, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let count = -1;
  while (Date.now() < deadline) {
    count = await boardElementCount();
    if (count >= min) return count;
    await sleep(200);
  }
  return count;
}

async function readTitleText() {
  return cdp.evaluate(
    `document.querySelector(".title-btn .title-text")?.textContent ?? null`,
  );
}

async function openEditor() {
  await cdp.navigate(`${BASE}/b/${BOARD}`);
  await cdp.waitFor(
    `!!document.querySelector(".title-btn") && !!document.querySelector(".presence") && !!document.querySelector(".tools-table")`,
    { label: "editor ready" },
  );
}

async function saveTitleWith(trigger) {
  await cdp.click(".title-btn");
  await cdp.waitFor(`!!document.querySelector(".title-input")`, {
    label: "title input",
  });
  await cdp.evaluate(`document.querySelector(".title-input").select()`);
  if (trigger === "button") {
    await cdp.type(`ชื่อจากปุ่ม ${Date.now()}`);
    await cdp.click(".title-save");
  } else if (trigger === "enter") {
    await cdp.type(`ชื่อจาก Enter ${Date.now()}`);
    await cdp.key("Enter", "Enter", 13);
  } else if (trigger === "blur") {
    await cdp.type(`ชื่อจาก Blur ${Date.now()}`);
    await cdp.clickPoint(900, 500);
  }
  await cdp.waitFor(`!document.querySelector(".title-input")`, {
    label: "title input closed",
  });
  await sleep(250);
  return readTitleText();
}

(async () => {
  const port = await freePort();
  const profile = await mkdtemp(path.join(os.tmpdir(), "dsh-e2e-chrome-"));
  browser = spawn(
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

  try {
    let targets;
    for (let i = 0; i < 100; i += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        targets = await response.json();
        if (targets.length) break;
      } catch {
        /* chrome still starting */
      }
      await sleep(100);
    }
    const page = targets?.find((target) => target.type === "page");
    if (!page) throw new Error("headless Chrome did not expose a page target");

    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    cdp = new CDP(ws);
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Network.enable");

    await deleteBoard(BOARD);
    const created = await api("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: BOARD }),
    });
    if (created.status !== 200 && created.status !== 201) {
      throw new Error(`cannot create test board: ${created.status} ${JSON.stringify(created.body)}`);
    }

    /* ------------------------------------------------------------ editor */
    await openEditor();
    check("editor opens with title", (await readTitleText()) === BOARD);
    const editorGlass = await cdp.evaluate(`(() => {
      const bar = document.querySelector(".bar");
      const canvas = document.querySelector(".canvas");
      return {
        bodyMesh: getComputedStyle(document.body).backgroundImage.includes("radial-gradient"),
        barBlur: getComputedStyle(bar).backdropFilter || getComputedStyle(bar).webkitBackdropFilter,
        barBg: getComputedStyle(bar).backgroundImage,
        canvasRadius: getComputedStyle(canvas).borderRadius,
        pencilOpacity: getComputedStyle(document.querySelector(".title-btn svg")).opacity,
      };
    })()`);
    check("editor body has glass mesh", editorGlass.bodyMesh, JSON.stringify(editorGlass.bodyMesh));
    check(
      "editor bar is frosted",
      /blur/.test(editorGlass.barBlur || "") && /rgba\(255, 255, 255/.test(editorGlass.barBg),
      `${editorGlass.barBlur} / ${editorGlass.barBg}`,
    );
    const canvasRect = await cdp.evaluate(`(() => {
      const r = document.querySelector(".canvas").getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height, vw: innerWidth, vh: innerHeight };
    })()`);
    check(
      "canvas fills the page",
      canvasRect.left === 0 &&
        canvasRect.top === 0 &&
        Math.abs(canvasRect.width - canvasRect.vw) <= 1 &&
        Math.abs(canvasRect.height - canvasRect.vh) <= 1,
      JSON.stringify(canvasRect),
    );

    const barRect = await cdp.evaluate(`(() => {
      const r = document.querySelector(".bar").getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, right: r.right, vw: innerWidth };
    })()`);
    check(
      "editor top bar is a compact floating toolbar",
      barRect.left >= 8 && barRect.top >= 8 && barRect.width < barRect.vw * 0.75 && barRect.right < barRect.vw - 8,
      JSON.stringify(barRect),
    );

    const overlay = await cdp.evaluate(`(() => {
      const bar = document.querySelector(".bar").getBoundingClientRect();
      const canvas = document.querySelector(".canvas").getBoundingClientRect();
      const menu = document.querySelector(".FixedSideContainer_side_top")?.getBoundingClientRect();
      return { barBottom: bar.bottom, canvasTop: canvas.top, menuTop: menu ? menu.top : null };
    })()`);
    check(
      "toolbar floats over the canvas",
      overlay.canvasTop < overlay.barBottom - 8,
      JSON.stringify(overlay),
    );
    check(
      "floating toolbar clears the Excalidraw menu",
      overlay.menuTop !== null && overlay.barBottom <= overlay.menuTop - 4,
      JSON.stringify(overlay),
    );
    check("rename pencil is visible", Number(editorGlass.pencilOpacity) >= 0.65, editorGlass.pencilOpacity);

    const toolbarBefore = await cdp.evaluate(`(() => {
      const r = document.querySelector(".bar").getBoundingClientRect();
      return { left: r.left, top: r.top };
    })()`);
    await cdp.drag(".bar-grip", 90, 60);
    await sleep(180);
    const toolbarAfter = await cdp.evaluate(`(() => {
      const r = document.querySelector(".bar").getBoundingClientRect();
      return { left: r.left, top: r.top, vw: innerWidth, vh: innerHeight, w: r.width, h: r.height };
    })()`);
    check(
      "floating toolbar can be dragged",
      toolbarAfter.left > toolbarBefore.left + 40 && toolbarAfter.top > toolbarBefore.top + 30,
      JSON.stringify({ toolbarBefore, toolbarAfter }),
    );
    check(
      "dragged toolbar stays on screen",
      toolbarAfter.left >= 0 &&
        toolbarAfter.top >= 0 &&
        toolbarAfter.left + toolbarAfter.w <= toolbarAfter.vw &&
        toolbarAfter.top + toolbarAfter.h <= toolbarAfter.vh,
      JSON.stringify(toolbarAfter),
    );

    await cdp.click(".bar-toggle");
    await cdp.waitFor(`document.querySelector(".bar").classList.contains("collapsed")`, {
      label: "toolbar fold",
    });
    const folded = await cdp.evaluate(`(() => {
      const bar = document.querySelector(".bar");
      const r = bar.getBoundingClientRect();
      return {
        width: r.width,
        left: r.left,
        top: r.top,
        content: getComputedStyle(bar.querySelector(".bar-content")).display,
        label: bar.querySelector(".bar-toggle").getAttribute("aria-label"),
      };
    })()`);
    check(
      "floating toolbar folds into a small pill",
      folded.width < 110 && folded.content === "none" && folded.left > 40,
      JSON.stringify(folded),
    );
    await cdp.drag(".bar-grip", 32, 22);
    await sleep(160);
    const foldedMoved = await cdp.evaluate(`(() => {
      const r = document.querySelector(".bar").getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, collapsed: document.querySelector(".bar").classList.contains("collapsed") };
    })()`);
    check(
      "folded toolbar can still be moved",
      foldedMoved.collapsed && foldedMoved.left > folded.left + 15 && foldedMoved.top > folded.top + 10,
      JSON.stringify({ folded, foldedMoved }),
    );
    await cdp.click(".bar-toggle");
    await cdp.waitFor(`!document.querySelector(".bar").classList.contains("collapsed")`, {
      label: "toolbar unfold",
    });
    const unfolded = await cdp.evaluate(`(() => {
      const bar = document.querySelector(".bar");
      return {
        width: bar.getBoundingClientRect().width,
        content: getComputedStyle(bar.querySelector(".bar-content")).display,
      };
    })()`);
    check(
      "floating toolbar expands again",
      unfolded.width > 300 && unfolded.content !== "none",
      JSON.stringify(unfolded),
    );

    await cdp.evaluate(`document.querySelector(".bar-grip").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
    await sleep(300);
    const backButton = await cdp.evaluate(`(() => {
      const back = document.querySelector(".back-fab");
      const old = document.querySelector('.bar-content a[href="/"]');
      const r = back?.getBoundingClientRect();
      return {
        exists: !!back,
        href: back?.getAttribute("href") || null,
        left: r?.left ?? null,
        top: r?.top ?? null,
        oldInBar: !!old,
      };
    })()`);
    check(
      "back button is a separate top-left control",
      backButton.exists && backButton.href === "/" && !backButton.oldInBar &&
        backButton.left <= 16 && backButton.top <= 16,
      JSON.stringify(backButton),
    );

    const toolsBefore = await cdp.evaluate(`(() => {
      const tools = document.querySelector(".App-toolbar");
      const grip = tools?.querySelector(".tools-grip");
      const fold = tools?.querySelector(".tools-fold");
      const r = tools?.getBoundingClientRect();
      return {
        exists: !!tools,
        floating: tools?.classList.contains("tools-floating") || false,
        position: tools ? getComputedStyle(tools).position : null,
        grip: !!grip,
        fold: !!fold,
        left: r?.left ?? null,
        top: r?.top ?? null,
        bottom: r?.bottom ?? null,
        barBottom: document.querySelector(".bar").getBoundingClientRect().bottom,
      };
    })()`);
    check(
      "drawing tools are a separate floating island",
      toolsBefore.exists && toolsBefore.floating && toolsBefore.position === "fixed" &&
        toolsBefore.grip && toolsBefore.fold && toolsBefore.top > toolsBefore.barBottom,
      JSON.stringify(toolsBefore),
    );

    await cdp.drag(".tools-grip", 70, 40);
    await sleep(200);
    const toolsAfter = await cdp.evaluate(`(() => {
      const r = document.querySelector(".App-toolbar").getBoundingClientRect();
      const saved = JSON.parse(localStorage.getItem("boards-tools") || "null");
      return { left: r.left, top: r.top, vw: innerWidth, vh: innerHeight, w: r.width, h: r.height, saved };
    })()`);
    check(
      "drawing tools can be dragged and remember their spot",
      toolsAfter.left > toolsBefore.left + 30 && toolsAfter.top > toolsBefore.top + 20 &&
        toolsAfter.left + toolsAfter.w <= toolsAfter.vw && toolsAfter.top + toolsAfter.h <= toolsAfter.vh &&
        !!toolsAfter.saved,
      JSON.stringify({ toolsBefore, toolsAfter }),
    );

    await cdp.click(".tools-fold");
    await cdp.waitFor(`document.querySelector(".shell").classList.contains("tools-collapsed")`, {
      label: "tools fold",
    });
    const toolsFolded = await cdp.evaluate(`(() => {
      const tools = document.querySelector(".App-toolbar");
      const launcher = document.querySelector(".tools-launcher");
      return {
        display: getComputedStyle(tools).display,
        launcher: !!launcher,
        launcherLabel: launcher?.getAttribute("aria-label") || null,
      };
    })()`);
    check(
      "drawing tools fold into a launcher",
      toolsFolded.display === "none" && toolsFolded.launcher &&
        toolsFolded.launcherLabel === "แสดงเครื่องมือวาด",
      JSON.stringify(toolsFolded),
    );
    await cdp.click(".tools-launcher");
    await cdp.waitFor(`!document.querySelector(".shell").classList.contains("tools-collapsed")`, {
      label: "tools unfold",
    });
    check(
      "the launcher brings the drawing tools back",
      (await cdp.evaluate(`getComputedStyle(document.querySelector(".App-toolbar")).display`)) !== "none",
    );
    await cdp.evaluate(`document.querySelector(".tools-grip").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
    await sleep(250);

    // put it back before the mobile pass so the menu clearance check means something
    await cdp.evaluate(`document.querySelector(".bar-grip").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))`);
    await sleep(300);
    await cdp.evaluate(`localStorage.removeItem("boards-toolbar")`);

    await cdp.click(".title-btn");
    await cdp.waitFor(`!!document.querySelector(".title-input")`, { label: "inline rename" });
    const editorFocus = await cdp.evaluate(`(() => {
      const input = document.querySelector(".title-input");
      return {
        active: document.activeElement === input,
        value: input.value,
        selected: input.selectionStart === 0 && input.selectionEnd === input.value.length,
      };
    })()`);
    check("inline rename focuses and selects the title", editorFocus.active && editorFocus.selected, JSON.stringify(editorFocus));
    await cdp.type("ชื่อแก้จากปุ่ม");
    await cdp.click(".title-save");
    await cdp.waitFor(`!document.querySelector(".title-input")`, { label: "save button close" });
    await sleep(200);
    check("explicit save button renames board", (await readTitleText()) === "ชื่อแก้จากปุ่ม", await readTitleText());
    check("save button persists title", (await metaTitle(BOARD)) === "ชื่อแก้จากปุ่ม", await metaTitle(BOARD));

    await cdp.navigate(`${BASE}/b/${BOARD}`);
    await cdp.waitFor(`!!document.querySelector(".title-btn")`, { label: "editor reload" });
    check("renamed title survives reload", (await readTitleText()) === "ชื่อแก้จากปุ่ม", await readTitleText());

    await cdp.click(".title-btn");
    await cdp.waitFor(`!!document.querySelector(".title-input")`, { label: "escape rename" });
    await cdp.type("ชื่อที่ไม่ควรถูกบันทึก");
    await cdp.key("Escape", "Escape", 27);
    await cdp.waitFor(`!document.querySelector(".title-input")`, { label: "escape close" });
    await sleep(250);
    check("Escape restores the old title", (await readTitleText()) === "ชื่อแก้จากปุ่ม", await readTitleText());
    check("Escape does not persist a title", (await metaTitle(BOARD)) === "ชื่อแก้จากปุ่ม", await metaTitle(BOARD));

    const enterTitle = await saveTitleWith("enter");
    check("Enter persists title", enterTitle.startsWith("ชื่อจาก Enter"), enterTitle);
    check("Enter saved to API", (await metaTitle(BOARD)) === enterTitle, await metaTitle(BOARD));

    const blurTitle = await saveTitleWith("blur");
    check("blur persists title", blurTitle.startsWith("ชื่อจาก Blur"), blurTitle);
    check("blur saved to API", (await metaTitle(BOARD)) === blurTitle, await metaTitle(BOARD));

    const tablePlacement = await cdp.evaluate(`(() => {
      const table = document.querySelector(".tools-table");
      const stack = document.querySelector(".App-toolbar .Stack_horizontal");
      const tools = document.querySelector(".App-toolbar").getBoundingClientRect();
      const native = document.querySelector(".App-toolbar .ToolIcon_size_medium")?.getBoundingClientRect();
      const r = table ? table.getBoundingClientRect() : null;
      return {
        inStack: Boolean(stack && table && stack.contains(table)),
        insideTools: Boolean(r && r.left >= tools.left - 1 && r.right <= tools.right + 1),
        w: r ? r.width : null, h: r ? r.height : null,
        nativeW: native ? native.width : null, nativeH: native ? native.height : null,
        barHasTableButton: !!document.querySelector(".bar .table-btn"),
        label: table ? table.getAttribute("aria-label") : null,
      };
    })()`);
    check("table button moved into the drawing tools row", tablePlacement.inStack && tablePlacement.insideTools, JSON.stringify(tablePlacement));
    check(
      "table button matches the native tool size",
      Math.abs((tablePlacement.w ?? 0) - (tablePlacement.nativeW ?? 29)) < 1.5 &&
        Math.abs((tablePlacement.h ?? 0) - (tablePlacement.nativeH ?? 29)) < 1.5,
      JSON.stringify(tablePlacement),
    );
    check("floating bar no longer carries a table button", tablePlacement.barHasTableButton === false, JSON.stringify(tablePlacement));

    const presenceBox = await cdp.evaluate(`(() => {
      const p = document.querySelector(".presence");
      const r = p.getBoundingClientRect();
      const bar = document.querySelector(".bar").getBoundingClientRect();
      return {
        cls: p.className,
        fromRight: innerWidth - r.right, top: r.top, height: r.height, left: r.left,
        avatars: p.querySelectorAll(".presence-avatar").length,
        avatarInk: p.querySelector(".presence-avatar") ? getComputedStyle(p.querySelector(".presence-avatar")).color : null,
        count: p.querySelector(".presence-count")?.textContent ?? null,
        title: p.getAttribute("title"),
        barHasLiveChip: !!document.querySelector(".bar .live"),
        barRight: bar.right,
      };
    })()`);
    check(
      "presence sits in the top-right corner",
      presenceBox.fromRight <= 24 && presenceBox.top <= 20,
      JSON.stringify(presenceBox),
    );
    check(
      "presence shows an avatar stack with a peer count",
      presenceBox.avatars >= 1 && /\u0e04\u0e19/.test(presenceBox.count || ""),
      JSON.stringify(presenceBox),
    );
    check("floating bar no longer carries the presence chip", presenceBox.barHasLiveChip === false, JSON.stringify(presenceBox));
    check("presence clears the floating bar", presenceBox.barRight < presenceBox.left, JSON.stringify(presenceBox));

    const inertClosed = await cdp.evaluate(`document.querySelector(".panel").hasAttribute("inert")`);
    check("closed table panel is inert", inertClosed === true, inertClosed);
    const beforeTable = await boardElementCount();
    await cdp.click(".tools-table");
    await cdp.waitFor(`document.querySelector(".panel")?.classList.contains("open")`, {
      label: "table panel open",
    });
    await cdp.waitFor(`(() => {
      const p = document.querySelector(".panel");
      const r = p.getBoundingClientRect();
      return r.right <= innerWidth + 1 && r.left >= 0;
    })()`, { label: "table panel slides in" });
    const tableActive = await cdp.evaluate(`(() => {
      const t = document.querySelector(".tools-table");
      return { active: t.classList.contains("active"), pressed: t.getAttribute("aria-pressed"), bg: getComputedStyle(t).backgroundColor };
    })()`);
    check(
      "drawing tools button shows the open panel",
      tableActive.active && tableActive.pressed === "true" && /rgba\(99, 96, 217/.test(tableActive.bg),
      JSON.stringify(tableActive),
    );
    const panelGlass = await cdp.evaluate(`(() => {
      const panel = document.querySelector(".panel");
      const style = getComputedStyle(panel);
      return {
        blur: style.backdropFilter || style.webkitBackdropFilter,
        bg: style.backgroundImage,
        width: style.width,
        hidden: panel.getAttribute("aria-hidden"),
      };
    })()`);
    check("table panel is a glass drawer", /blur/.test(panelGlass.blur || "") && /rgba\(255, 255, 255/.test(panelGlass.bg), `${panelGlass.blur} / ${panelGlass.bg}`);
    check("table panel is open for interaction", panelGlass.hidden === "false", panelGlass.hidden);
    check("open table panel is not inert", (await cdp.evaluate(`document.querySelector(".panel").hasAttribute("inert")`)) === false);
    await cdp.click(".panel.open .panel-body > button.btn.wide");
    await cdp.waitFor(`/แทรกตารางแล้ว/.test(document.querySelector(".panel .note")?.textContent || "")`, {
      label: "table inserted",
    });
    const afterTable = await waitForBoardCount(beforeTable + 5);
    check("table insertion saves elements", afterTable >= beforeTable + 5, `${beforeTable} -> ${afterTable}`);
    await cdp.click(".panel-head .icon-btn");
    await cdp.waitFor(`!document.querySelector(".panel")?.classList.contains("open")`, {
      label: "table panel close",
    });
    check(
      "drawing tools button clears when the panel closes",
      (await cdp.evaluate(`document.querySelector(".tools-table").classList.contains("active")`)) === false,
    );

    // a position saved on a wide screen must be clamped when the editor opens narrow
    await cdp.evaluate(`localStorage.setItem("boards-toolbar", JSON.stringify({ x: 260, y: 10, collapsed: false }))`);
    await cdp.viewport(393, 852, true);
    await cdp.navigate(`${BASE}/b/${BOARD}`);
    await cdp.waitFor(`!!document.querySelector(".title-btn")`, { label: "mobile editor" });
    await sleep(300);
    const mobileBefore = await cdp.evaluate(`(() => {
      const bar = document.querySelector(".bar").getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      return {
        overflow: document.documentElement.scrollWidth - vw,
        title: document.querySelector(".title-btn .title-text").textContent,
        barLeft: bar.left, barRight: bar.right, vw,
      };
    })()`);
    check("mobile editor has no horizontal overflow", mobileBefore.overflow <= 1, JSON.stringify(mobileBefore));
    check(
      "saved toolbar position is clamped on mobile",
      mobileBefore.barLeft >= 0 && mobileBefore.barRight <= mobileBefore.vw + 1,
      JSON.stringify({ left: mobileBefore.barLeft, right: mobileBefore.barRight, vw: mobileBefore.vw }),
    );

    const mobileOverlay = await cdp.evaluate(`(() => {
      const bar = document.querySelector(".bar").getBoundingClientRect();
      const canvas = document.querySelector(".canvas").getBoundingClientRect();
      const menu = document.querySelector(".FixedSideContainer_side_top")?.getBoundingClientRect();
      return { barBottom: bar.bottom, canvasTop: canvas.top, menuTop: menu ? menu.top : null };
    })()`);
    check(
      "mobile toolbar floats over the canvas",
      mobileOverlay.canvasTop < mobileOverlay.barBottom - 8 &&
        mobileOverlay.menuTop !== null &&
        mobileOverlay.barBottom <= mobileOverlay.menuTop - 4,
      JSON.stringify(mobileOverlay),
    );

    const mobileTools = await cdp.evaluate(`(() => {
      const tools = document.querySelector(".App-toolbar");
      const r = tools.getBoundingClientRect();
      const back = document.querySelector(".back-fab").getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      return {
        left: r.left, right: r.right, width: r.width, top: r.top, vw,
        backLeft: back.left, backTop: back.top,
      };
    })()`);
    check(
      "mobile drawing tools stay on screen",
      mobileTools.left >= 0 && mobileTools.right <= mobileTools.vw + 1 &&
        mobileTools.width <= mobileTools.vw && mobileTools.top > 50,
      JSON.stringify(mobileTools),
    );
    const mobilePresence = await cdp.evaluate(`(() => {
      const p = document.querySelector(".presence");
      const r = p.getBoundingClientRect();
      const bar = document.querySelector(".bar").getBoundingClientRect();
      const table = document.querySelector(".tools-table");
      const tools = document.querySelector(".App-toolbar").getBoundingClientRect();
      const t = table ? table.getBoundingClientRect() : null;
      const vw = document.documentElement.clientWidth;
      return {
        fromRight: vw - r.right, top: r.top, left: r.left,
        display: getComputedStyle(p).display,
        avatars: p.querySelectorAll(".presence-avatar").length,
        barRight: bar.right,
        tableInside: Boolean(t && table.closest(".App-toolbar") && t.left >= tools.left - 1 && t.right <= Math.min(tools.right, vw) + 1),
      };
    })()`);
    check(
      "mobile presence stays in the top-right corner",
      mobilePresence.display !== "none" && mobilePresence.fromRight <= 12 && mobilePresence.top <= 12,
      JSON.stringify(mobilePresence),
    );
    check(
      "mobile presence does not cover the floating bar",
      mobilePresence.barRight < mobilePresence.left,
      JSON.stringify(mobilePresence),
    );
    check(
      "mobile drawing tools keep the table button inside the island",
      mobilePresence.tableInside,
      JSON.stringify(mobilePresence),
    );
    const mobileBarText = await cdp.evaluate(`(() => {
      const text = document.querySelector(".title-text").getBoundingClientRect();
      const save = document.querySelector(".save").getBoundingClientRect();
      const saveText = document.querySelector(".save-text");
      return {
        titleText: Math.round(text.width),
        saveW: Math.round(save.width),
        saveText: saveText ? getComputedStyle(saveText).display : null,
      };
    })()`);
    check("mobile bar still shows the board name", mobileBarText.titleText >= 40, JSON.stringify(mobileBarText));
    check(
      "mobile save status shrinks to its dot",
      mobileBarText.saveW <= 20 && mobileBarText.saveText === "none",
      JSON.stringify(mobileBarText),
    );
    check(
      "mobile back button stays in the top-left corner",
      mobileTools.backLeft <= 10 && mobileTools.backTop <= 10,
      JSON.stringify({ left: mobileTools.backLeft, top: mobileTools.backTop }),
    );
    await cdp.click(".tools-fold");
    await cdp.waitFor(`document.querySelector(".shell").classList.contains("tools-collapsed")`, {
      label: "mobile tools fold",
    });
    await cdp.click(".tools-launcher");
    await cdp.waitFor(`!document.querySelector(".shell").classList.contains("tools-collapsed")`, {
      label: "mobile tools unfold",
    });
    check(
      "mobile tools fold and come back",
      (await cdp.evaluate(`getComputedStyle(document.querySelector(".App-toolbar")).display`)) !== "none",
    );

    await cdp.click(".title-btn");
    await cdp.waitFor(`!!document.querySelector(".title-input")`, { label: "mobile rename" });
    const mobileInput = await cdp.evaluate(`(() => {
      const input = document.querySelector(".title-input");
      const save = document.querySelector(".title-save");
      const a = input.getBoundingClientRect(), b = save.getBoundingClientRect();
      const vw = document.documentElement.clientWidth;
      return { inputW: a.width, saveW: b.width, saveLeft: b.left, saveRight: b.right, vw,
        visible: a.width > 80 && b.width > 0 && b.right <= vw };
    })()`);
    check("mobile inline input and save stay visible", mobileInput.visible, JSON.stringify(mobileInput));
    await cdp.evaluate(`document.querySelector(".title-input").select()`);
    await cdp.type("ชื่อบนมือถือ");
    await cdp.key("Enter", "Enter", 13);
    await cdp.waitFor(`!document.querySelector(".title-input")`, { label: "mobile save" });
    await sleep(300);
    check("mobile rename works", (await metaTitle(BOARD)) === "ชื่อบนมือถือ", await metaTitle(BOARD));
    await cdp.viewport(null);

    await cdp.navigate(`${BASE}/b/${BOARD}`);
    await cdp.waitFor(`!!document.querySelector(".presence")`, { label: "presence ready" });
    await sleep(500);
    const live1 = await cdp.evaluate(`document.querySelector(".presence")?.textContent?.trim()`);
    await cdp.navigate(`${BASE}/b/${BOARD}`);
    await cdp.waitFor(`!!document.querySelector(".presence")`, { label: "presence after reload" });
    await sleep(900);
    const live2 = await cdp.evaluate(`document.querySelector(".presence")?.textContent?.trim()`);
    check("presence stays at one peer after reload", /1\s*คน/.test(live1) && /1\s*คน/.test(live2), `${live1} -> ${live2}`);

    // Another client sends a sticky-like text and a pasted image over the board
    // socket. The image binary lives in `files`, outside the element list; if we
    // only merge elements the receiver shows a blank image and loses the file.
    const sender = new WebSocket(`${BASE.replace(/^http/, "ws")}/ws/board/${BOARD}?sid=e2e-sender-1&name=Sender`);
    await new Promise((resolve, reject) => {
      sender.once("open", resolve);
      sender.once("error", reject);
    });
    const before = (await api(`/api/boards/${BOARD}`)).body;
    const stamp = Date.now();
    const stickyRect = {
      id: "e2e-sticky-rect",
      type: "rectangle",
      x: 40,
      y: 320,
      width: 220,
      height: 140,
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "#ffec99",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: { type: 3 },
      seed: 21,
      version: 1,
      versionNonce: 21,
      isDeleted: false,
      boundElements: [{ type: "text", id: "e2e-sticky-text" }],
      updated: stamp,
      link: null,
      locked: false,
    };
    const stickyText = {
      id: "e2e-sticky-text",
      type: "text",
      x: 60,
      y: 345,
      width: 180,
      height: 28,
      angle: 0,
      strokeColor: "#1e1e1e",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 22,
      version: 1,
      versionNonce: 22,
      isDeleted: false,
      boundElements: null,
      updated: stamp,
      link: null,
      locked: false,
      text: "สวัสดีจากอีกเครื่อง",
      fontSize: 20,
      fontFamily: 1,
      textAlign: "left",
      verticalAlign: "top",
      containerId: "e2e-sticky-rect",
      originalText: "สวัสดีจากอีกเครื่อง",
      lineHeight: 1.25,
      baseline: 18,
    };
    const imageFile = {
      id: "e2e-remote-file",
      mimeType: "image/png",
      dataURL: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4m0AAAAASUVORK5CYII=",
      created: stamp,
      lastRetrieved: stamp,
    };
    const image = {
      id: "e2e-remote-image",
      type: "image",
      x: 320,
      y: 320,
      width: 120,
      height: 120,
      angle: 0,
      strokeColor: "transparent",
      backgroundColor: "transparent",
      fillStyle: "solid",
      strokeWidth: 2,
      strokeStyle: "solid",
      roughness: 1,
      opacity: 100,
      groupIds: [],
      frameId: null,
      roundness: null,
      seed: 23,
      version: 1,
      versionNonce: 23,
      isDeleted: false,
      boundElements: null,
      updated: stamp,
      link: null,
      locked: false,
      fileId: imageFile.id,
      status: "saved",
      scale: [1, 1],
      crop: null,
    };
    sender.send(JSON.stringify({
      type: "update",
      scene: {
        ...before,
        elements: [...(before.elements || []), stickyRect, stickyText, image],
        files: { ...(before.files || {}), [imageFile.id]: imageFile },
      },
    }));
    await cdp.waitFor(
      `window.__boardsApi.getSceneElements().some((el) => el.id === "e2e-remote-image")`,
      { label: "remote image element" },
    );
    const remote = await cdp.evaluate(`(() => {
      const api = window.__boardsApi;
      const els = api.getSceneElements();
      const files = api.getFiles() || {};
      return {
        sticky: els.some((el) => el.id === "e2e-sticky-text" && el.text === "สวัสดีจากอีกเครื่อง"),
        image: els.some((el) => el.id === "e2e-remote-image" && el.fileId === "e2e-remote-file"),
        file: Boolean(files["e2e-remote-file"]?.dataURL),
      };
    })()`);
    check("realtime receives a sticky note from another client", remote.sticky, JSON.stringify(remote));
    check("realtime receives a pasted image with its file", remote.image && remote.file, JSON.stringify(remote));
    sender.close();

    /* ----------------------------------------------------------- catalog */
    await cdp.navigate(`${BASE}/`);
    await cdp.waitFor(`!!document.querySelector('.card[data-slug="${BOARD}"]')`, {
      label: "catalog card",
    });
    const catalogGlass = await cdp.evaluate(`(() => {
      const card = document.querySelector('.card[data-slug="${BOARD}"]');
      const header = document.querySelector("header");
      const body = getComputedStyle(document.body).backgroundImage;
      return {
        headerBlur: getComputedStyle(header).backdropFilter || getComputedStyle(header).webkitBackdropFilter,
        cardBlur: getComputedStyle(card).backdropFilter || getComputedStyle(card).webkitBackdropFilter,
        cardBg: getComputedStyle(card).backgroundImage,
        bodyMesh: body.includes("radial-gradient"),
        renameVisible: !!card.querySelector(".rename"),
        shotDecoration: getComputedStyle(document.querySelector(".shot")).textDecorationLine,
      };
    })()`);
    check("catalog has glass header", /blur/.test(catalogGlass.headerBlur || ""), catalogGlass.headerBlur);
    check("catalog cards are frosted", /blur/.test(catalogGlass.cardBlur || "") && /rgba\(255, 255, 255/.test(catalogGlass.cardBg), `${catalogGlass.cardBlur} / ${catalogGlass.cardBg}`);
    check("catalog background has glass mesh", catalogGlass.bodyMesh);
    check("catalog shows rename control", catalogGlass.renameVisible);
    check("catalog placeholder is not underlined", catalogGlass.shotDecoration === "none", catalogGlass.shotDecoration);
    await cdp.screenshot("/tmp/e2e-catalog.png");

    await cdp.click(`.card[data-slug="${BOARD}"] .rename`);
    await cdp.waitFor(`!document.getElementById("rename-modal").hidden`, { label: "rename modal" });
    await cdp.waitFor(`document.activeElement === document.getElementById("rename-input")`, {
      label: "rename input focus",
    });
    const renameFocus = await cdp.evaluate(`(() => {
      const input = document.getElementById("rename-input");
      return { active: document.activeElement === input, value: input.value,
        selected: input.selectionStart === 0 && input.selectionEnd === input.value.length };
    })()`);
    check("catalog rename modal focuses and selects", renameFocus.active && renameFocus.selected && renameFocus.value === "ชื่อบนมือถือ", JSON.stringify(renameFocus));
    await cdp.evaluate(`document.getElementById("rename-input").value = ""`);
    await cdp.click("#rename-save");
    await cdp.waitFor(`document.getElementById("rename-note").hidden === false`, {
      label: "empty rename warning",
    });
    const emptyNote = await cdp.evaluate(`document.getElementById("rename-note").textContent`);
    check("catalog rename rejects an empty name", /ชื่อต้องไม่ว่าง/.test(emptyNote), emptyNote);
    check("catalog rename stays open after a bad name", await cdp.evaluate(`!document.getElementById("rename-modal").hidden`));
    await cdp.evaluate(`document.getElementById("rename-input").value = "ชื่อจากแคตตาล็อก"`);
    await cdp.click("#rename-save");
    await cdp.waitFor(`document.getElementById("rename-modal").hidden`, { label: "rename saved" });
    await sleep(250);
    const cardTitle = await cdp.evaluate(`document.querySelector('.card[data-slug="${BOARD}"] h2').textContent`);
    check("catalog card updates after rename", cardTitle === "ชื่อจากแคตตาล็อก", cardTitle);
    check("catalog rename persists to API", (await metaTitle(BOARD)) === "ชื่อจากแคตตาล็อก", await metaTitle(BOARD));

    await cdp.navigate(`${BASE}/b/${BOARD}`);
    await cdp.waitFor(`!!document.querySelector(".title-btn")`, { label: "editor after catalog rename" });
    check("editor sees catalog rename", (await readTitleText()) === "ชื่อจากแคตตาล็อก", await readTitleText());
    await cdp.screenshot("/tmp/e2e-editor.png");

    await cdp.navigate(`${BASE}/`);
    await cdp.waitFor(`!!document.getElementById("q")`, { label: "catalog search" });
    await cdp.click("#q");
    await cdp.type("ชื่อจากแคตตาล็อก");
    await sleep(350);
    const search = await cdp.evaluate(`(() => {
      const cards = [...document.querySelectorAll(".card")];
      const visible = cards.filter((c) => !c.hidden && getComputedStyle(c).display !== "none");
      return { total: cards.length, visible: visible.length, slugs: visible.map((c) => c.dataset.slug) };
    })()`);
    check("catalog search finds the renamed board", search.visible === 1 && search.slugs[0] === BOARD, JSON.stringify(search));

    await cdp.viewport(393, 852, true);
    await cdp.navigate(`${BASE}/`);
    await cdp.waitFor(`!!document.querySelector(".card")`, { label: "mobile catalog" });
    const mobileCatalog = await cdp.evaluate(`(() => ({
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      headerVisible: !!document.querySelector("header"),
      cardWidth: document.querySelector(".card").getBoundingClientRect().width,
    }))()`);
    check("mobile catalog has no horizontal overflow", mobileCatalog.overflow <= 1, JSON.stringify(mobileCatalog));
    await cdp.screenshot("/tmp/e2e-catalog-mobile.png");
    await cdp.viewport(null);

    deleteProbe = `e2e-delete-${Date.now()}`;
    await api("/api/boards", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: deleteProbe }),
    });
    await cdp.navigate(`${BASE}/`);
    await cdp.waitFor(`!!document.querySelector('[data-slug="${deleteProbe}"]')`, {
      label: "delete probe card",
    });
    await cdp.click(`[data-slug="${deleteProbe}"] .del`);
    await cdp.waitFor(`!document.getElementById("del-modal").hidden`, {
      label: "delete modal",
    });
    await cdp.hold("#del-hold", 1350);
    await cdp.waitFor(`!document.querySelector('[data-slug="${deleteProbe}"]')`, {
      label: "card removed after hold",
    });
    const deleted = await api(`/api/boards/${encodeURIComponent(deleteProbe)}`);
    check("hold-to-confirm deletes a board", deleted.status === 404, `API ${deleted.status}`);
    deleteProbe = null;

    // Excalidraw 0.18 still registers window.unload; Chrome 158 reports the
    // deprecation as a console error even though our app uses pagehide instead.
    const unloadNoise = /Permissions policy violation: unload is not allowed/;
    const ignored = cdp.consoleErrors.filter((text) => unloadNoise.test(text));
    const realErrors = cdp.consoleErrors.filter((text) => !unloadNoise.test(text));
    if (ignored.length) console.log(`NOTE  ignored ${ignored.length} Excalidraw unload-deprecation console messages`);
    check("no browser console errors", realErrors.length === 0, realErrors.slice(0, 4).join(" | "));
  } catch (error) {
    check("e2e harness completed", false, error.stack || error.message);
  } finally {
    try {
      await deleteBoard(BOARD);
      if (deleteProbe) await deleteBoard(deleteProbe);
    } catch {
      /* ignore */
    }
    try {
      cdp?.ws.close();
    } catch {
      /* ignore */
    }
    try {
      browser?.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    await sleep(250);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  const failed = results.filter((item) => !item.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("\nFailures:");
    for (const item of failed) console.log(`- ${item.name}: ${item.detail}`);
    process.exit(1);
  }
})();

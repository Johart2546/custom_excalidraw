#!/usr/bin/env node
/**
 * scripts/test-groups.mjs — end-to-end tests for the board groups API.
 *
 * Built-in test runner: `node scripts/test-groups.mjs` runs the same tests as
 * `node --test scripts/test-groups.mjs`. The suite spawns app/server.mjs on a
 * random port with a throwaway DATA_DIR/GALLERY_DIR under the system temp
 * folder, so it never touches the live container or gallery/scenes.
 *
 * Uses only Node built-ins (fetch is global since Node 22), so it needs no
 * dependencies and does not read node_modules.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = resolve(fileURLToPath(import.meta.url), "..");
const ROOT = resolve(HERE, "..");
const SERVER = join(ROOT, "app", "server.mjs");

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));

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

/* ------------------------------------------------------------------- harness */

let dataDir = "";
let server = null;
let base = "";
const logs = [];

const groupFile = () => join(dataDir, ".groups.json");
const savedGroups = async () => JSON.parse(await readFile(groupFile(), "utf8")).groups;
const savedMeta = async (id) => JSON.parse(await readFile(join(dataDir, id, "meta.json"), "utf8"));

/** One API call; `body` may be an object (JSON-encoded) or a raw string. */
const call = async (path, { method = "GET", body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed };
};

const patchMeta = (id, body) => call(`/api/boards/${encodeURIComponent(id)}/meta`, { method: "PATCH", body });

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "boards-groups-test-"));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;

  server = spawn(process.execPath, [SERVER], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATA_DIR: dataDir,
      APP_DIR: join(dataDir, "app"),
      GALLERY_DIR: join(dataDir, "gallery"),
      HISTORY_KEEP: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  server.stderr.on("data", (chunk) => logs.push(chunk.toString()));

  for (let i = 0; i < 60; i += 1) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) {
        process.stdout.write(`groups API tests — ${base}, DATA_DIR=${dataDir}\n`);
        return;
      }
    } catch {
      /* not listening yet */
    }
    await sleep(100);
  }
  throw new Error(`server did not start:\n${logs.join("")}`);
});

after(async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([new Promise((ok) => server.once("exit", ok)), sleep(2000)]);
    if (server.exitCode === null) server.kill("SIGKILL");
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

/* --------------------------------------------------------------------- tests */

test("groups API", async (t) => {
  const ids = { groupA: "", groupB: "", board: "" };

  await t.test("GET /api/groups — empty list, and a read never creates the file", async () => {
    const res = await call("/api/groups");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { groups: [] });
    await assert.rejects(stat(groupFile()), "reading groups must not create .groups.json");
  });

  await t.test("POST /api/groups — 201, grp_ id, trimmed name, default colour", async () => {
    const res = await call("/api/groups", { method: "POST", body: { name: "  ลูกค้า  " } });
    assert.equal(res.status, 201);
    const group = res.body.group;
    assert.deepEqual(Object.keys(group), ["id", "name", "color", "createdAt", "updatedAt"], "no count on a write");
    assert.match(group.id, /^grp_[0-9a-f]{8}$/);
    assert.equal(group.name, "ลูกค้า");
    assert.equal(group.color, "violet");
    assert.equal(group.createdAt, group.updatedAt);
    assert.ok(!Number.isNaN(Date.parse(group.createdAt)), "createdAt is an ISO date");
    ids.groupA = group.id;

    const saved = JSON.parse(await readFile(groupFile(), "utf8"));
    assert.equal(saved.version, 1);
    assert.deepEqual(saved.groups, [group]);
  });

  await t.test("POST /api/groups — explicit colour is kept, groups append in order", async () => {
    const res = await call("/api/groups", { method: "POST", body: { name: "Design", color: "blue" } });
    assert.equal(res.status, 201);
    assert.equal(res.body.group.color, "blue");
    ids.groupB = res.body.group.id;

    const list = await call("/api/groups");
    assert.deepEqual(
      list.body.groups.map((group) => [group.name, group.color]),
      [
        ["ลูกค้า", "violet"],
        ["Design", "blue"],
      ],
    );
  });

  await t.test("POST /api/groups — duplicate name → 409 (case-insensitive, trimmed)", async () => {
    assert.equal((await call("/api/groups", { method: "POST", body: { name: "ลูกค้า" } })).status, 409);
    assert.equal((await call("/api/groups", { method: "POST", body: { name: "  design " } })).status, 409);
    assert.equal((await savedGroups()).length, 2);
  });

  await t.test("POST /api/groups — bad input → 400", async () => {
    const cases = [
      { name: "Pink group", color: "pink" }, // unknown colour
      { name: "" }, // empty name
      { name: "   " }, // whitespace-only name
      { name: "ก".repeat(41) }, // too long
      { name: 42 }, // not a string
      { color: "blue" }, // no name at all
      "{not json", // not JSON
      "[]", // not an object
    ];
    for (const body of cases) {
      const res = await call("/api/groups", { method: "POST", body });
      assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    }
    assert.equal((await savedGroups()).length, 2);
  });

  await t.test("POST /api/groups — 40 characters is still fine", async () => {
    const res = await call("/api/groups", { method: "POST", body: { name: "x".repeat(40) } });
    assert.equal(res.status, 201);
    assert.equal([...res.body.group.name].length, 40);
    assert.equal((await call(`/api/groups/${res.body.group.id}`, { method: "DELETE" })).status, 200);
  });

  await t.test("GET /api/groups — count is 0 while no board is filed", async () => {
    const res = await call("/api/groups");
    assert.equal(res.status, 200);
    for (const group of res.body.groups) {
      assert.deepEqual(Object.keys(group), ["id", "name", "color", "createdAt", "updatedAt", "count"]);
      assert.equal(group.count, 0);
    }
  });

  await t.test("PATCH /api/groups/:id — rename and recolour", async () => {
    const res = await call(`/api/groups/${ids.groupA}`, {
      method: "PATCH",
      body: { name: "ลูกค้า VIP", color: "amber" },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.group.name, "ลูกค้า VIP");
    assert.equal(res.body.group.color, "amber");
    assert.ok(!("count" in res.body.group));
    assert.equal((await savedGroups()).find((group) => group.id === ids.groupA).name, "ลูกค้า VIP");
  });

  await t.test("PATCH /api/groups/:id — 409 duplicate, 404 unknown, 400 bad input", async () => {
    assert.equal((await call(`/api/groups/${ids.groupA}`, { method: "PATCH", body: { name: "design" } })).status, 409);
    assert.equal((await call("/api/groups/grp_00000000", { method: "PATCH", body: { name: "Nope" } })).status, 404);
    assert.equal((await call(`/api/groups/${ids.groupA}`, { method: "PATCH", body: { color: "pink" } })).status, 400);
    assert.equal((await call(`/api/groups/${ids.groupA}`, { method: "PATCH", body: { nope: true } })).status, 400);
    assert.equal((await call(`/api/groups/${ids.groupA}`, { method: "PATCH", body: { name: "" } })).status, 400);
  });

  await t.test("PATCH /api/boards/:id/meta — groupId files the board, count becomes 1", async () => {
    const created = await call("/api/boards", { method: "POST", body: { name: "groups-board" } });
    assert.equal(created.status, 201);
    ids.board = created.body.id;
    assert.equal((await patchMeta(ids.board, { title: "Board in a group" })).status, 200);

    const res = await patchMeta(ids.board, { groupId: ids.groupA });
    assert.equal(res.status, 200);
    // the meta response echoes the membership so a card can render without a second call
    assert.deepEqual(res.body, {
      id: ids.board,
      title: "Board in a group",
      subtitle: "",
      tags: [],
      groupId: ids.groupA,
    });
    assert.deepEqual(await savedMeta(ids.board), { title: "Board in a group", groupId: ids.groupA });

    // and the board list carries it too, so the catalogue needs one request
    const boards = await call("/api/boards");
    const listed = boards.body.boards.find((board) => board.id === ids.board);
    assert.equal(listed.groupId, ids.groupA);

    const list = await call("/api/groups");
    assert.equal(list.body.groups.find((group) => group.id === ids.groupA).count, 1);
    assert.equal(list.body.groups.find((group) => group.id === ids.groupB).count, 0);
  });

  await t.test("PATCH /api/boards/:id/meta — a title-only patch keeps the group", async () => {
    const res = await patchMeta(ids.board, { title: "Renamed, still filed" });
    assert.equal(res.status, 200);
    assert.equal(res.body.title, "Renamed, still filed");
    assert.deepEqual(await savedMeta(ids.board), { title: "Renamed, still filed", groupId: ids.groupA });
  });

  await t.test("PATCH /api/boards/:id/meta — unknown/malformed groupId is refused", async () => {
    const malformed = await patchMeta(ids.board, { groupId: "not-a-group" });
    assert.equal(malformed.status, 400);
    const unknown = await patchMeta(ids.board, { groupId: "grp_00000000" });
    assert.equal(unknown.status, 404);
    assert.equal((await patchMeta(ids.board, { groupId: 42 })).status, 400);
    // refused writes change nothing
    assert.deepEqual(await savedMeta(ids.board), { title: "Renamed, still filed", groupId: ids.groupA });
  });

  await t.test("PATCH /api/boards/:id/meta — null and \"\" ungroup the board", async () => {
    let res = await patchMeta(ids.board, { groupId: null });
    assert.equal(res.status, 200);
    assert.deepEqual(await savedMeta(ids.board), { title: "Renamed, still filed", groupId: null });
    assert.equal((await call("/api/groups")).body.groups.find((group) => group.id === ids.groupA).count, 0);

    await patchMeta(ids.board, { groupId: ids.groupA });
    res = await patchMeta(ids.board, { groupId: "" });
    assert.equal(res.status, 200);
    assert.equal((await savedMeta(ids.board)).groupId, null);

    await patchMeta(ids.board, { groupId: ids.groupA });
    res = await patchMeta(ids.board, { groupId: "   " });
    assert.equal(res.status, 200);
    assert.equal((await savedMeta(ids.board)).groupId, null);
  });

  await t.test("DELETE /api/groups/:id — boards go back to ungrouped, moved counts them", async () => {
    assert.equal((await patchMeta(ids.board, { groupId: ids.groupA })).status, 200);

    const res = await call(`/api/groups/${ids.groupA}`, { method: "DELETE" });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { deleted: ids.groupA, moved: 1 });
    // only groupId changes: the title (and any other key) stays untouched
    assert.deepEqual(await savedMeta(ids.board), { title: "Renamed, still filed", groupId: null });
    assert.deepEqual(
      (await call("/api/groups")).body.groups.map((group) => group.name),
      ["Design"],
    );
    assert.equal((await call(`/api/groups/${ids.groupA}`, { method: "DELETE" })).status, 404);
  });

  await t.test("a corrupt .groups.json reads as zero groups and the server keeps answering", async () => {
    await writeFile(groupFile(), '{"version":1,"groups":[{"id":"grp_');
    const res = await call("/api/groups");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { groups: [] });
    assert.equal((await call("/api/health")).status, 200);
    await sleep(100); // let the warning reach the pipe
    assert.match(logs.join(""), /groups file is not valid JSON/);

    // a write heals the file
    const created = await call("/api/groups", { method: "POST", body: { name: "Recovered" } });
    assert.equal(created.status, 201);
    assert.deepEqual(
      (await call("/api/groups")).body.groups.map((group) => group.name),
      ["Recovered"],
    );
  });

  await t.test("other methods → 405", async () => {
    assert.equal((await call("/api/groups", { method: "PUT" })).status, 405);
    assert.equal((await call(`/api/groups/${ids.groupB}`)).status, 405);
  });
});

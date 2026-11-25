#!/usr/bin/env node
/**
 * scripts/migrate-scenes.mjs — move flat boards into the per-board folder layout.
 *
 * The server does this by itself the first time a legacy board is written, so
 * this script is for migrating the whole gallery at once (best while the app is
 * stopped, although it is safe to run alongside it):
 *
 *   node scripts/migrate-scenes.mjs                 # DATA_DIR or ./gallery/scenes
 *   DATA_DIR=/data node scripts/migrate-scenes.mjs  # inside the container
 *   node scripts/migrate-scenes.mjs --dry-run       # only print the plan
 *
 * What moves:
 *
 *   <data>/<id>.excalidraw            -> <data>/<id>/scene.excalidraw
 *   <data>/<id>.meta.json             -> <data>/<id>/meta.json
 *   <data>/.history/<id>/*.excalidraw -> <data>/<id>/history/
 *
 * Idempotent: a board already in its folder is left alone and a flat file that
 * duplicates a folder copy is removed (the folder is authoritative). Board ids
 * never change — the folder name IS the public id.
 *
 * Node built-ins only, like the server.
 */

import { copyFile, mkdir, readdir, rename, rmdir, stat, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}$/;
const SCENE_RE = /\.excalidraw$/i;
const DRY_RUN = process.argv.includes("--dry-run");

const DATA_DIR = resolve(process.env.DATA_DIR || "./gallery/scenes");
const rel = (path) => path.slice(DATA_DIR.length + 1);

async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDir(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** Move a file, keeping mtime; copy+unlink when rename crosses a device. */
async function move(from, to) {
  try {
    await rename(from, to);
  } catch {
    await copyFile(from, to);
    await unlink(from).catch(() => {});
  }
}

/** The full plan for one flat board: [{ from, to } | { drop }]. */
async function planBoard(id) {
  const boardDir = join(DATA_DIR, id);
  const scene = join(boardDir, "scene.excalidraw");
  const meta = join(boardDir, "meta.json");
  const legacyScene = join(DATA_DIR, `${id}.excalidraw`);
  const legacyMeta = join(DATA_DIR, `${id}.meta.json`);
  const legacyHistory = join(DATA_DIR, ".history", id);

  const plan = [];
  if (await isFile(scene)) plan.push({ drop: legacyScene }); // stale duplicate
  else plan.push({ from: legacyScene, to: scene });

  if (await isFile(legacyMeta)) {
    if (await isFile(meta)) plan.push({ drop: legacyMeta });
    else plan.push({ from: legacyMeta, to: meta });
  }

  if (await isDir(legacyHistory)) {
    for (const name of (await readdir(legacyHistory)).sort()) {
      if (name.startsWith(".") || !SCENE_RE.test(name)) continue;
      const target = join(boardDir, "history", name);
      if (await isFile(target)) plan.push({ drop: join(legacyHistory, name) });
      else plan.push({ from: join(legacyHistory, name), to: target });
    }
  }
  return plan;
}

async function main() {
  if (!(await isDir(DATA_DIR))) {
    console.error(`data dir not found: ${DATA_DIR}`);
    process.exit(1);
  }

  const names = (await readdir(DATA_DIR)).sort();
  const flat = names.filter((name) => !name.startsWith(".") && SCENE_RE.test(name));
  let moved = 0;
  let dropped = 0;

  for (const name of flat) {
    const id = name.replace(SCENE_RE, "");
    if (!ID_RE.test(id)) {
      process.stdout.write(`  ! skipped ${name} (invalid board id)\n`);
      continue;
    }
    const plan = await planBoard(id);

    if (DRY_RUN) {
      for (const step of plan) {
        process.stdout.write(step.from ? `  would move ${rel(step.from)} -> ${rel(step.to)}\n` : `  would remove ${rel(step.drop)}\n`);
      }
      moved += plan.filter((step) => step.from).length;
      dropped += plan.filter((step) => step.drop).length;
      continue;
    }

    for (const step of plan) {
      if (step.from) {
        await mkdir(dirname(step.to), { recursive: true });
        await move(step.from, step.to);
        process.stdout.write(`  moved ${rel(step.from)} -> ${rel(step.to)}\n`);
        moved += 1;
      } else {
        await unlink(step.drop).catch(() => {});
        dropped += 1;
      }
    }
    await rmdir(join(DATA_DIR, ".history", id)).catch(() => {}); // only when empty
  }

  if (!DRY_RUN) await rmdir(join(DATA_DIR, ".history")).catch(() => {}); // only when empty

  process.stdout.write(
    `${DRY_RUN ? "would migrate" : "migrated"} ${moved} file(s), dropped ${dropped} stale duplicate(s) ` +
      `for ${flat.length} flat board(s) in ${DATA_DIR}\n`,
  );
}

await main();

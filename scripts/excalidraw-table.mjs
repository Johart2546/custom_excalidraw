#!/usr/bin/env node
/**
 * excalidraw-table.mjs — turn tabular data (or a database schema) into Excalidraw tables.
 *
 * Why this exists: `excalidraw mermaid` has no table syntax, and the Excalidraw+ `mcp`
 * table tools need a paid login. This writes the `.excalidraw` scene directly, so tables
 * can be generated from a JSON spec and appended to a board without touching it by hand.
 *
 * Usage
 *   node scripts/excalidraw-table.mjs spec.json -o board.excalidraw
 *   node scripts/excalidraw-table.mjs spec.json --into src/lib/inventory/untitled.excalidraw -o out.excalidraw
 *   node scripts/excalidraw-table.mjs spec.json -o out.excalidraw --columns 2 --gap-x 60
 *   node scripts/excalidraw-table.mjs spec.json -o - | excalidraw render - --out board.png
 *
 * Spec (JSON; a bare array of tables also works)
 *   {
 *     "columns": 3,                       // optional grid layout, overridden by --columns
 *     "defaults": { "color": "blue" },    // optional per-run defaults
 *     "tables": [
 *       {
 *         "title": "inventory.lot",       // optional heading above the card
 *         "subtitle": "1 lot = 1 GR",     // optional smaller line under the heading
 *         "color": "blue",                // gray|blue|green|yellow|orange|red|violet|cyan
 *         "mono": false,                  // monospace cell text (good for type names)
 *         "fontSize": 13,
 *         "columns": [
 *           "Column",                     // plain header, auto width
 *           { "header": "Type", "width": 150, "align": "left" },
 *           { "header": "Key", "width": 70, "align": "center" }
 *         ],
 *         "rows": [
 *           ["id", "uuid", "PK"],
 *           ["item_id", "uuid", "FK → item.id"]
 *         ]
 *       }
 *     ]
 *   }
 *
 * Output is a scene file; render it with the CLI:
 *   excalidraw render out.excalidraw --out out.png
 *
 * Notes
 *   - Elements are plain rectangles/lines/text (no bound containers), so the generated
 *     table is editable text-by-text. Resizing a card does not reflow its cells.
 *   - Output is deterministic (seeded IDs/seeds), so re-running with an unchanged spec
 *     produces a byte-identical file and the diff stays readable.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/* ------------------------------------------------------------------ constants */

const FONT_SANS = 2; // Helvetica
const FONT_MONO = 3; // Cascadia Code
const LINE_HEIGHT = 1.25;
const CELL_PAD_X = 12;
const CELL_PAD_Y = 8;
const HEADER_FONT = 13;
const CELL_FONT = 13;
const TITLE_FONT = 16;
const SUBTITLE_FONT = 12;
const TITLE_GAP = 10;
const MUTED = "#868e96";
const MIN_COL_W = 56;
const MAX_COL_W = 460;
const MIN_ROW_H = 30;
const HEADER_H = 34;

const INK = "#1e1e1e";
const RULE = "#dee2e6";

const PALETTE = {
  gray: { fill: "#f1f3f5", stroke: "#868e96" },
  blue: { fill: "#e7f5ff", stroke: "#1971c2" },
  green: { fill: "#d3f9d8", stroke: "#2f9e44" },
  yellow: { fill: "#fff3bf", stroke: "#f08c00" },
  orange: { fill: "#ffe8cc", stroke: "#e8590c" },
  red: { fill: "#ffe3e3", stroke: "#e03131" },
  violet: { fill: "#f3f0ff", stroke: "#6741d9" },
  cyan: { fill: "#e3fafc", stroke: "#0c8599" },
};

/* ------------------------------------------------------------- text measuring */

// Helvetica advance widths (per 1000 units, /1000 => em fraction), plus fallbacks.
const HELV = {
  " ": 0.278, "!": 0.278, '"': 0.355, "#": 0.556, $: 0.556, "%": 0.889, "&": 0.667,
  "'": 0.191, "(": 0.333, ")": 0.333, "*": 0.389, "+": 0.584, ",": 0.278, "-": 0.333,
  ".": 0.278, "/": 0.278, ":": 0.278, ";": 0.278, "<": 0.584, "=": 0.584, ">": 0.584,
  "?": 0.556, "@": 1.015, "[": 0.278, "\\": 0.278, "]": 0.278, "^": 0.469, _: 0.556,
  "`": 0.333, "{": 0.334, "|": 0.26, "}": 0.334, "~": 0.584,
  a: 0.556, b: 0.556, c: 0.5, d: 0.556, e: 0.556, f: 0.278, g: 0.556, h: 0.556,
  i: 0.222, j: 0.222, k: 0.5, l: 0.222, m: 0.833, n: 0.556, o: 0.556, p: 0.556,
  q: 0.556, r: 0.333, s: 0.5, t: 0.278, u: 0.556, v: 0.5, w: 0.722, x: 0.5,
  y: 0.5, z: 0.5,
  A: 0.667, B: 0.667, C: 0.722, D: 0.722, E: 0.667, F: 0.611, G: 0.778, H: 0.722,
  I: 0.278, J: 0.5, K: 0.667, L: 0.556, M: 0.833, N: 0.722, O: 0.778, P: 0.667,
  Q: 0.778, R: 0.722, S: 0.667, T: 0.611, U: 0.722, V: 0.667, W: 0.944, X: 0.667,
  Y: 0.667, Z: 0.611,
};

const THAI_MARKS = new Set([
  0x0e31, 0x0e34, 0x0e35, 0x0e36, 0x0e37, 0x0e38, 0x0e39, 0x0e3a,
  0x0e47, 0x0e48, 0x0e49, 0x0e4a, 0x0e4b, 0x0e4c, 0x0e4d, 0x0e4e,
]);

function isWideScript(code) {
  return (
    (code >= 0x0e00 && code <= 0x0e7f) || // Thai
    (code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK
    (code >= 0xac00 && code <= 0xd7af) || // Hangul
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60)
  );
}

function charEm(ch) {
  const code = ch.codePointAt(0);
  if (code === undefined) return 0;
  if (THAI_MARKS.has(code)) return 0.32;
  if (isWideScript(code)) return code <= 0x0e7f ? 0.6 : 1;
  if (code >= 0x0300 && code <= 0x036f) return 0.2;
  return HELV[ch] ?? 0.58;
}

function measure(text, fontSize, fontFamily) {
  if (fontFamily === FONT_MONO) return text.length * 0.6 * fontSize;
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em * fontSize;
}

/** Greedy wrap; breaks long tokens (and unspaced Thai) character by character. */
function wrap(text, maxWidth, fontSize, fontFamily) {
  const paragraphs = String(text).split("\n");
  const out = [];
  for (const para of paragraphs) {
    if (para === "") {
      out.push("");
      continue;
    }
    const words = para.split(/(\s+)/).filter((w) => w !== "");
    let line = "";
    for (const word of words) {
      const candidate = line + word;
      if (measure(candidate, fontSize, fontFamily) <= maxWidth || line === "") {
        if (measure(word, fontSize, fontFamily) > maxWidth) {
          // single token wider than the cell: hard-break it
          let chunk = "";
          for (const ch of word) {
            if (measure(chunk + ch, fontSize, fontFamily) > maxWidth && chunk !== "") {
              out.push(chunk);
              chunk = ch;
            } else {
              chunk += ch;
            }
          }
          line = chunk;
        } else {
          line = candidate;
        }
      } else {
        out.push(line.trimEnd());
        line = word.trimStart();
      }
    }
    out.push(line.trimEnd());
  }
  return out.length ? out : [""];
}

/* ------------------------------------------------------------- element output */

let seedState = 0x9e3779b9;
function rnd() {
  seedState = (seedState + 0x6d2b79f5) | 0;
  let t = Math.imul(seedState ^ (seedState >>> 15), 1 | seedState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const randInt = (n) => Math.floor(rnd() * n);

let idSeq = 0;
function nextId(prefix = "t") {
  idSeq += 1;
  return `${prefix}${idSeq.toString(36)}${randInt(1e9).toString(36)}`;
}

const round = (n) => Math.round(n * 100) / 100;
const stamp = Date.now();

function base(type, x, y, width, height, o = {}) {
  return {
    id: o.id ?? nextId(type[0]),
    type,
    x: round(x),
    y: round(y),
    width: round(width),
    height: round(height),
    angle: 0,
    strokeColor: o.strokeColor ?? INK,
    backgroundColor: o.backgroundColor ?? "transparent",
    fillStyle: "solid",
    strokeWidth: o.strokeWidth ?? 1,
    strokeStyle: o.strokeStyle ?? "solid",
    roughness: o.roughness ?? 1,
    opacity: 100,
    groupIds: o.groupIds ?? [],
    frameId: null,
    roundness: o.roundness ?? null,
    seed: randInt(2 ** 31),
    version: 1,
    versionNonce: randInt(2 ** 31),
    isDeleted: false,
    boundElements: null,
    updated: stamp,
    link: null,
    locked: false,
  };
}

function rect(x, y, w, h, o = {}) {
  return base("rectangle", x, y, w, h, o);
}

function line(x, y, w, o = {}) {
  return {
    ...base("line", x, y, w, 0, { strokeWidth: 1, strokeColor: RULE, ...o }),
    points: [
      [0, 0],
      [round(w), 0],
    ],
    lastCommittedPoint: null,
    startBinding: null,
    endBinding: null,
    startArrowhead: null,
    endArrowhead: null,
  };
}

function text(x, y, value, fontSize, fontFamily, o = {}) {
  const lines = value.split("\n");
  const w = Math.max(...lines.map((l) => measure(l, fontSize, fontFamily)));
  const h = lines.length * fontSize * LINE_HEIGHT;
  return {
    ...base("text", x, y, w, h, { strokeColor: o.color ?? INK, roughness: 0, ...o }),
    text: value,
    originalText: value,
    fontSize,
    fontFamily,
    textAlign: "left",
    verticalAlign: "top",
    containerId: null,
    autoResize: true,
    lineHeight: LINE_HEIGHT,
    baseline: Math.round(fontSize * 0.9),
  };
}

/* ------------------------------------------------------------------- building */

function normalizeSpec(raw) {
  const spec = Array.isArray(raw) ? { tables: raw } : raw;
  if (!spec || !Array.isArray(spec.tables) || spec.tables.length === 0) {
    throw new Error("spec must contain a non-empty 'tables' array (or be an array of tables)");
  }
  return spec;
}

function normalizeColumns(table) {
  const cols = table.columns ?? [];
  if (!Array.isArray(cols) || cols.length === 0) {
    throw new Error(`table "${table.title ?? "?"}" has no columns`);
  }
  return cols.map((c) => {
    const col = typeof c === "string" ? { header: c } : { ...c };
    col.header = String(col.header ?? "");
    col.align = col.align ?? "left";
    return col;
  });
}

function buildTable(table, specDefaults) {
  const cols = normalizeColumns(table);
  const rows = (table.rows ?? []).map((r) =>
    cols.map((_, i) => (r[i] === undefined || r[i] === null ? "" : String(r[i]))),
  );
  const colorName = table.color ?? specDefaults.color ?? "gray";
  const palette = PALETTE[colorName] ?? PALETTE.gray;
  const fontSize = table.fontSize ?? specDefaults.fontSize ?? CELL_FONT;
  const fontFamily = (table.mono ?? specDefaults.mono) ? FONT_MONO : FONT_SANS;
  const groupId = nextId("g");
  const rounded = table.round ?? specDefaults.round ?? false;

  // natural column widths from header + cells, honoring explicit widths
  const widths = cols.map((col, i) => {
    if (col.width) return Math.max(MIN_COL_W, Math.min(MAX_COL_W, col.width));
    let widest = measure(col.header, HEADER_FONT, fontFamily);
    for (const row of rows) widest = Math.max(widest, measure(row[i], fontSize, fontFamily));
    return Math.max(MIN_COL_W, Math.min(MAX_COL_W, Math.ceil(widest + CELL_PAD_X * 2 + 6)));
  });

  // wrap every cell once; row height is driven by the tallest cell in the row
  const inner = widths.map((w) => w - CELL_PAD_X * 2);
  const headerLines = cols.map((col, i) => wrap(col.header, inner[i], HEADER_FONT, fontFamily));
  const bodyLines = rows.map((row) =>
    row.map((cell, i) => wrap(cell, inner[i], fontSize, fontFamily)),
  );
  const headerH = Math.max(
    HEADER_H,
    Math.max(...headerLines.map((l) => l.length)) * HEADER_FONT * LINE_HEIGHT + CELL_PAD_Y * 2,
  );
  const rowHeights = bodyLines.map((cells) =>
    Math.max(
      MIN_ROW_H,
      Math.max(...cells.map((l) => l.length)) * fontSize * LINE_HEIGHT + CELL_PAD_Y * 2,
    ),
  );
  const cardW = widths.reduce((a, b) => a + b, 0);
  const cardH = headerH + rowHeights.reduce((a, b) => a + b, 0);

  const elements = [];
  const g = (el) => {
    el.groupIds = [groupId];
    elements.push(el);
    return el;
  };

  const titleText = table.title ? String(table.title) : null;
  const subtitleText = table.subtitle ? String(table.subtitle) : null;
  const titleH =
    (titleText ? TITLE_FONT * LINE_HEIGHT : 0) +
    (subtitleText ? SUBTITLE_FONT * LINE_HEIGHT + 2 : 0) +
    (titleText || subtitleText ? TITLE_GAP : 0);
  const originX = 0;
  const originY = titleH;

  // card + header
  g(
    rect(originX, originY, cardW, cardH, {
      strokeColor: palette.stroke,
      backgroundColor: "#ffffff",
      roundness: rounded ? { type: 3 } : null,
      strokeWidth: 1,
    }),
  );
  g(
    rect(originX, originY, cardW, headerH, {
      strokeColor: palette.stroke,
      backgroundColor: palette.fill,
      roundness: rounded ? { type: 3 } : null,
      strokeWidth: 1,
    }),
  );

  if (titleText) {
    g(text(originX, 0, titleText, TITLE_FONT, FONT_SANS, { color: INK, roughness: 0 }));
  }
  if (subtitleText) {
    const y = titleText ? TITLE_FONT * LINE_HEIGHT : 0;
    g(text(originX, y, subtitleText, SUBTITLE_FONT, FONT_SANS, { color: MUTED, roughness: 0 }));
  }

  // header labels
  let cx = originX;
  cols.forEach((col, i) => {
    const lines = headerLines[i];
    const w = Math.max(...lines.map((l) => measure(l, HEADER_FONT, fontFamily)));
    const x =
      col.align === "right"
        ? cx + widths[i] - CELL_PAD_X - w
        : col.align === "center"
          ? cx + (widths[i] - w) / 2
          : cx + CELL_PAD_X;
    const y = originY + (headerH - lines.length * HEADER_FONT * LINE_HEIGHT) / 2;
    g(text(x, y, lines.join("\n"), HEADER_FONT, fontFamily, { color: INK, roughness: 0 }));
    cx += widths[i];
  });

  // body rows
  let rowTop = originY + headerH;
  bodyLines.forEach((cells, r) => {
    const rowH = rowHeights[r];
    if (r > 0) g(line(originX, rowTop, cardW));
    let x = originX;
    cells.forEach((lines, i) => {
      if (lines.length === 1 && lines[0] === "") {
        x += widths[i];
        return;
      }
      const w = Math.max(...lines.map((l) => measure(l, fontSize, fontFamily)));
      const col = cols[i];
      const tx =
        col.align === "right"
          ? x + widths[i] - CELL_PAD_X - w
          : col.align === "center"
            ? x + (widths[i] - w) / 2
            : x + CELL_PAD_X;
      const ty = rowTop + (rowH - lines.length * fontSize * LINE_HEIGHT) / 2;
      g(text(tx, ty, lines.join("\n"), fontSize, fontFamily, { color: INK, roughness: 0 }));
      x += widths[i];
    });
    rowTop += rowH;
  });

  return {
    elements,
    width: Math.max(
      cardW,
      titleText ? measure(titleText, TITLE_FONT, FONT_SANS) : 0,
      subtitleText ? measure(subtitleText, SUBTITLE_FONT, FONT_SANS) : 0,
    ),
    height: titleH + cardH,
  };
}

function layout(tables, columns, gapX, gapY) {
  const grid = [];
  tables.forEach((t, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    (grid[row] ??= []);
    grid[row][col] = t;
  });

  const colW = new Array(columns).fill(0);
  const rowH = new Array(grid.length).fill(0);
  grid.forEach((row, r) => {
    row.forEach((t, c) => {
      if (!t) return;
      colW[c] = Math.max(colW[c], t.width);
      rowH[r] = Math.max(rowH[r], t.height);
    });
  });

  const xAt = [];
  let acc = 0;
  for (let c = 0; c < columns; c += 1) {
    xAt.push(acc);
    acc += colW[c] + gapX;
  }
  const yAt = [];
  acc = 0;
  for (let r = 0; r < grid.length; r += 1) {
    yAt.push(acc);
    acc += rowH[r] + gapY;
  }

  const placed = [];
  tables.forEach((t, i) => {
    const c = i % columns;
    const r = Math.floor(i / columns);
    placed.push({ ...t, x: xAt[c], y: yAt[r] });
  });
  return placed;
}

/* ---------------------------------------------------------------------- main */

function parseArgs(argv) {
  const opts = {
    spec: null,
    out: null,
    into: null,
    columns: 3,
    gapX: 80,
    gapY: 80,
    appendGap: 120,
    quiet: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`missing value for ${arg}`);
      return argv[i];
    };
    switch (arg) {
      case "-o":
      case "--out":
        opts.out = next();
        break;
      case "--into":
        opts.into = next();
        break;
      case "--columns":
        opts.columns = Number(next());
        opts.columnsExplicit = true;
        break;
      case "--gap-x":
        opts.gapX = Number(next());
        break;
      case "--gap-y":
        opts.gapY = Number(next());
        break;
      case "--append-gap":
        opts.appendGap = Number(next());
        break;
      case "--quiet":
        opts.quiet = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        if (arg.startsWith("-")) throw new Error(`unknown option ${arg}`);
        if (opts.spec) throw new Error(`unexpected extra argument ${arg}`);
        opts.spec = arg;
    }
  }
  return opts;
}

function usage() {
  return [
    "Usage: node scripts/excalidraw-table.mjs <spec.json> -o <out.excalidraw> [options]",
    "",
    "Options:",
    "  -o, --out <file>       scene file to write, or - for stdout (required)",
    "      --into <file>      append the new tables to an existing scene",
    "      --columns <n>      tables per row in the grid layout (default 3)",
    "      --gap-x <px>       horizontal gap between tables (default 80)",
    "      --gap-y <px>       vertical gap between tables (default 80)",
    "      --append-gap <px>  gap from the existing scene's right edge (default 120)",
    "      --quiet            only print errors",
    "  -h, --help             this help",
    "",
    "Render afterwards:  excalidraw render <out.excalidraw> --out <out.png>",
  ].join("\n");
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}\n`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!opts.spec || !opts.out) {
    process.stderr.write(`both a spec file and -o are required\n\n${usage()}\n`);
    process.exit(2);
  }
  if (!Number.isFinite(opts.columns) || opts.columns < 1) {
    process.stderr.write("--columns must be a positive integer\n");
    process.exit(2);
  }

  const specPath = resolve(opts.spec);
  if (!existsSync(specPath)) {
    process.stderr.write(`spec not found: ${specPath}\n`);
    process.exit(2);
  }
  let spec;
  try {
    spec = normalizeSpec(JSON.parse(readFileSync(specPath, "utf8")));
  } catch (error) {
    process.stderr.write(`invalid spec ${specPath}: ${error.message}\n`);
    process.exit(2);
  }
  const defaults = spec.defaults ?? {};
  if (spec.columns && !opts.columnsExplicit) {
    opts.columns = spec.columns;
  }

  const built = spec.tables.map((table) => buildTable(table, defaults));
  const placed = layout(built, opts.columns, opts.gapX, opts.gapY);

  // base scene: either fresh or an existing board we append to
  let scene;
  let offsetX = 0;
  let offsetY = 0;
  if (opts.into) {
    scene = JSON.parse(readFileSync(resolve(opts.into), "utf8"));
    if (!Array.isArray(scene.elements)) throw new Error(`${opts.into} has no elements array`);
    const right = scene.elements.reduce(
      (max, el) => (el.isDeleted ? max : Math.max(max, el.x + el.width)),
      -Infinity,
    );
    offsetX = Number.isFinite(right) ? right + opts.appendGap : 0;
  } else {
    scene = {
      type: "excalidraw",
      version: 2,
      source: "https://excalidraw.com",
      elements: [],
      appState: {
        gridSize: 20,
        gridStep: 5,
        gridModeEnabled: false,
        viewBackgroundColor: "#ffffff",
      },
      files: {},
    };
  }

  let added = 0;
  for (const table of placed) {
    for (const el of table.elements) {
      el.x = round(el.x + table.x + offsetX);
      el.y = round(el.y + table.y + offsetY);
      if (el.type === "line") el.points = el.points.map(([px, py]) => [round(px), round(py)]);
      scene.elements.push(el);
      added += 1;
    }
  }

  // sanity: unique ids, finite geometry
  const ids = new Set();
  for (const el of scene.elements) {
    if (ids.has(el.id)) throw new Error(`duplicate element id ${el.id}`);
    ids.add(el.id);
    for (const key of ["x", "y", "width", "height"]) {
      if (!Number.isFinite(el[key])) throw new Error(`non-finite ${key} on ${el.id}`);
    }
  }

  const json = `${JSON.stringify(scene, null, 2)}\n`;
  if (opts.out === "-") {
    // pipe straight into the renderer: ... -o - | excalidraw render - --out board.png
    process.stdout.write(json);
    return;
  }

  const outPath = resolve(opts.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, json);

  if (!opts.quiet) {
    const rows = spec.tables.reduce((n, t) => n + (t.rows?.length ?? 0), 0);
    process.stdout.write(
      `${outPath}\n  tables: ${spec.tables.length}  rows: ${rows}  elements added: ${added}  ` +
        `total elements: ${scene.elements.length}\n`,
    );
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`error: ${error.message}\n`);
  process.exit(1);
}

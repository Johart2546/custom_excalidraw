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

let seedState = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
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

function vline(x, y, h, o = {}) {
  return {
    ...base("line", x, y, 0, h, { strokeWidth: 1, strokeColor: RULE, ...o }),
    points: [
      [0, 0],
      [0, round(h)],
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

/* ------------------------------------------------------------- browser wrapper */

/**
 * Build a grid of tables as Excalidraw elements.
 *
 * @param {object} input
 * @param {object[]} input.tables   table specs (title/subtitle/color/columns/rows)
 * @param {number} [input.columns]  grid columns for the layout
 * @param {number} [input.gapX]
 * @param {number} [input.gapY]
 * @returns {{elements: object[], width: number, height: number}}
 */
export function buildTables({ tables, columns = 1, gapX = 80, gapY = 60 }) {
  if (!Array.isArray(tables) || tables.length === 0) {
    throw new Error("buildTables needs at least one table");
  }
  const built = tables.map((table) => buildTable(table, {}));
  const placed = layout(built, Math.max(1, columns | 0), gapX, gapY);

  const elements = [];
  let maxX = 0;
  let maxY = 0;
  for (const table of placed) {
    for (const el of table.elements) {
      el.x = round(el.x + table.x);
      el.y = round(el.y + table.y);
      if (el.type === "line") el.points = el.points.map(([px, py]) => [round(px), round(py)]);
      elements.push(el);
      maxX = Math.max(maxX, el.x + (el.width || 0));
      maxY = Math.max(maxY, el.y + (el.height || 0));
    }
  }
  return { elements, width: maxX, height: maxY };
}

/* --------------------------------------------------------------- empty grid */

const clampInt = (value, lo, hi, fallback) => {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
};

/**
 * Build an empty row × column grid with an explicit overall width and height.
 *
 * Cells are plain rectangles in one group: no hidden text element is created up
 * front. Double-clicking a cell (or pressing Enter with it selected) makes
 * Excalidraw create the bound text on demand, so only cells that actually hold
 * something carry a text element.
 *
 * @param {object} input
 * @param {number} [input.columns] 1–20
 * @param {number} [input.rows]    1–50
 * @param {number} [input.width]   overall width in px, 80–4000
 * @param {number} [input.height]  overall height in px, 40–4000
 * @param {string} [input.color]   PALETTE key for the header row
 * @param {boolean}[input.headerRow]
 * @param {string} [input.title]
 * @param {string} [input.subtitle]
 * @returns {{elements: object[], width: number, height: number, columns: number, rows: number}}
 */
/**
 * Bound text element for one cell, used when a grid is rebuilt and its cells
 * already hold text (a cell with no text carries no element at all).
 */
export function attachCellText(cell, value, { groupIds = [], customData } = {}) {
  const fontSize = Math.max(8, Math.min(20, Math.round(cell.height * 0.36)));
  const padX = Math.min(CELL_PAD_X, Math.max(4, cell.width * 0.12));
  const inner = text(cell.x + padX, cell.y + cell.height / 2 - (fontSize * LINE_HEIGHT) / 2, value, fontSize, FONT_SANS, {
    roughness: 0,
    groupIds,
  });
  // text() hardcodes containerId/verticalAlign/autoResize — bind the cell by hand
  inner.containerId = cell.id;
  inner.verticalAlign = "middle";
  inner.autoResize = false;
  inner.textAlign = "left";
  inner.width = round(Math.max(8, cell.width - padX * 2));
  inner.height = round(fontSize * LINE_HEIGHT);
  if (customData) inner.customData = customData;
  cell.boundElements = [{ id: inner.id, type: "text" }];
  return inner;
}

export function buildGrid({
  columns = 3,
  rows = 4,
  width = 520,
  height = 220,
  color = "blue",
  headerRow = true,
  title,
  subtitle,
  gridId,
} = {}) {
  const gid = gridId ?? nextId("grid");
  const meta = { grid: gid, color, headerRow };
  // one group for the whole grid: single click selects / drags the table as a unit
  const groupId = `g${gid}`;
  const cols = clampInt(columns, 1, 20, 3);
  const lines = clampInt(rows, 1, 50, 4);
  const cardW = clampInt(width, 80, 4000, 520);
  const cardH = clampInt(height, 40, 4000, 220);
  const palette = PALETTE[color] ?? PALETTE.gray;

  const titleText = title ? String(title).trim() : "";
  const subtitleText = subtitle ? String(subtitle).trim() : "";
  const titleH =
    (titleText ? TITLE_FONT * LINE_HEIGHT : 0) +
    (subtitleText ? SUBTITLE_FONT * LINE_HEIGHT + 2 : 0) +
    (titleText || subtitleText ? TITLE_GAP : 0);

  const elements = [];
  if (titleText) {
    const head = text(0, 0, titleText, TITLE_FONT, FONT_SANS, { roughness: 0, groupIds: [groupId] });
    head.customData = { grid: gid, title: true };
    elements.push(head);
  }
  if (subtitleText) {
    const sub = text(0, titleText ? TITLE_FONT * LINE_HEIGHT : 0, subtitleText, SUBTITLE_FONT, FONT_SANS, {
      strokeColor: MUTED,
      roughness: 0,
      groupIds: [groupId],
    });
    sub.customData = { grid: gid, subtitle: true };
    elements.push(sub);
  }

  const cellW = cardW / cols;
  const cellH = cardH / lines;

  for (let r = 0; r < lines; r += 1) {
    const header = headerRow && r === 0;
    for (let c = 0; c < cols; c += 1) {
      const x = c * cellW;
      const y = titleH + r * cellH;
      const cell = rect(x, y, cellW, cellH, {
        strokeColor: header ? palette.stroke : RULE,
        backgroundColor: header ? palette.fill : "#ffffff",
        roughness: 0,
        strokeWidth: 1,
        groupIds: [groupId],
      });
      cell.customData = { ...meta, rows: lines, cols, r, c };
      elements.push(cell);
    }
  }

  return { elements, width: cardW, height: titleH + cardH, columns: cols, rows: lines };
}

export { PALETTE };

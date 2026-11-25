/**
 * Mermaid flowchart → Excalidraw element skeleton.
 *
 * Pure module: no React, no DOM, no network. `node --test` imports it directly,
 * and DiagramTool feeds the skeletons to convertToExcalidrawElements().
 */

const DIRECTIONS = new Set(["TD", "TB", "BT", "LR", "RL"]);

// Longest opener first so "[[x]]" is not read as "[" + wasted text.
const SHAPE_OPENERS = [
  { open: "[[", close: "]]", shape: "subroutine" },
  { open: "((", close: "))", shape: "round" },
  { open: "[", close: "]", shape: "rect" },
  { open: "(", close: ")", shape: "round" },
  { open: "{", close: "}", shape: "diamond" },
];

const ID_RE = /^[A-Za-z0-9_.\u0E00-\u0E7F]+(?:-[A-Za-z0-9_.\u0E00-\u0E7F]+)*/;

const SKIP_LINE =
  /^(?:%%|subgraph\b|direction\b|classDef\b|class\b|style\b|linkStyle\b|click\b|accTitle\b|accDescr\b)/i;

// "-- label -->" is tried before the plain forms so the label is not lost.
const LABELED_LINK = /^(?:--|==)\s+(.+?)\s*(-{2,}>|-{3,}|={2,}>|-\.-?>)/;
const PIPED_LINK = /^(-{2,}>|-{3,}|={2,}>|-\.-?>)\s*\|([^|]*)\|/;
const PLAIN_LINK = /^(-{2,}>|-{3,}|={2,}>|-\.-?>)/;

const GAP_X = 48;
const GAP_Y = 76;

function clamp(value, lo, hi) {
  return Math.max(lo, Math.min(hi, value));
}

function round(value) {
  return Math.round(value);
}

function cleanLabel(text) {
  let out = String(text).trim();
  if (out.length > 1 && ((out.startsWith('"') && out.endsWith('"')) || (out.startsWith("'") && out.endsWith("'")))) {
    out = out.slice(1, -1);
  }
  return out
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripFence(text) {
  const source = String(text ?? "");
  const fenced = source.match(/```(?:mermaid)?[ \t]*\r?\n([\s\S]*?)```/i);
  if (fenced) return fenced[1];
  const anyFence = source.match(/```[ \t]*\r?\n([\s\S]*?)```/);
  return anyFence ? anyFence[1] : source;
}

function readNode(text, at) {
  const rest = text.slice(at);
  const idMatch = ID_RE.exec(rest);
  if (!idMatch) return null;

  const id = idMatch[0];
  let cursor = at + id.length;
  let shape = "rect";
  let label = null;

  const opener = SHAPE_OPENERS.find((candidate) => text.startsWith(candidate.open, cursor));
  if (opener) {
    const labelStart = cursor + opener.open.length;
    const closeAt = text.indexOf(opener.close, labelStart);
    if (closeAt === -1) throw new Error(`วงเล็บของ "${id}" ไม่ปิด`);
    label = cleanLabel(text.slice(labelStart, closeAt));
    shape = opener.shape;
    cursor = closeAt + opener.close.length;
  }

  return { id, shape, label, end: cursor };
}

function readLink(text, at) {
  const rest = text.slice(at);
  let match = LABELED_LINK.exec(rest);
  if (match) {
    const token = match[2];
    return {
      length: match[0].length,
      label: cleanLabel(match[1]),
      arrow: token.endsWith(">"),
      strokeStyle: token.startsWith("-.") ? "dotted" : undefined,
    };
  }
  match = PIPED_LINK.exec(rest);
  if (match) {
    const token = match[1];
    return {
      length: match[0].length,
      label: cleanLabel(match[2]),
      arrow: token.endsWith(">"),
      strokeStyle: token.startsWith("-.") ? "dotted" : undefined,
    };
  }
  match = PLAIN_LINK.exec(rest);
  if (match) {
    const token = match[1];
    return {
      length: match[0].length,
      label: "",
      arrow: token.endsWith(">"),
      strokeStyle: token.startsWith("-.") ? "dotted" : undefined,
    };
  }
  return null;
}

function createRegistry() {
  return new Map();
}

function upsertNode(registry, node) {
  const known = registry.get(node.id);
  if (!known) {
    registry.set(node.id, {
      id: node.id,
      label: node.label || node.id,
      shape: node.shape,
      explicit: Boolean(node.label),
    });
    return;
  }
  // A later explicit label/shape wins; a bare reference only fills the gap.
  if (node.label) {
    known.label = node.label;
    known.explicit = true;
  }
  if (node.shape !== "rect" || !known.explicit) {
    known.shape = node.shape;
  }
}

function parseStatement(text, lineNo, registry, edges) {
  let cursor = 0;
  const first = readNode(text, cursor);
  if (!first) throw new Error(`บรรทัด ${lineNo}: อ่านโหนดแรกไม่ได้จาก "${text}"`);
  cursor = first.end;
  upsertNode(registry, first);
  let current = first.id;

  while (cursor < text.length) {
    while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
    if (cursor >= text.length) break;

    const link = readLink(text, cursor);
    if (!link) throw new Error(`บรรทัด ${lineNo}: ไม่เข้าใจ "${text.slice(cursor)}"`);
    cursor += link.length;

    while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
    const next = readNode(text, cursor);
    if (!next) throw new Error(`บรรทัด ${lineNo}: ลิงก์ "${link.label || ""}" ไม่มีปลายทาง`);
    cursor = next.end;
    upsertNode(registry, next);

    const edge = { from: current, to: next.id, label: link.label, arrow: link.arrow };
    if (link.strokeStyle) edge.strokeStyle = link.strokeStyle;
    if (!edges.some((known) => known.from === edge.from && known.to === edge.to && known.label === edge.label)) {
      edges.push(edge);
    }
    current = next.id;
  }
}

/**
 * Parse a Mermaid flowchart into a small node/edge spec.
 * Throws a readable Error when nothing diagram-like is found.
 */
export function mermaidToSpec(text) {
  const source = stripFence(text);
  const registry = createRegistry();
  const edges = [];
  let direction = "TD";

  const lines = source.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    let line = lines[index].trim();
    if (!line) continue;

    const header = /^(?:flowchart|graph)\b\s*(TD|TB|BT|LR|RL)?\b\s*(.*)$/i.exec(line);
    if (header) {
      if (header[1]) direction = header[1].toUpperCase();
      line = header[2].trim();
      if (!line) continue;
    }

    if (SKIP_LINE.test(line)) continue;
    if (/^end\s*$/i.test(line)) continue;
    if (line.endsWith(";")) line = line.replace(/;+\s*$/, "").trim();
    for (const statement of line.split(";")) {
      const piece = statement.trim();
      // A line with neither a link nor a shape is prose, not a flow statement.
      if (!piece || !/[\[\](){}]|--|==|-\./.test(piece)) continue;
      parseStatement(piece, lineNo, registry, edges);
    }
  }

  const nodes = [...registry.values()].map(({ id, label, shape }) => ({ id, label, shape }));
  if (!nodes.length) throw new Error("ไม่พบไดอะแกรมในข้อความ (ต้องมี flowchart และโหนดอย่างน้อยหนึ่งโหนด)");
  if (!DIRECTIONS.has(direction)) direction = "TD";
  return { direction, nodes, edges };
}

function nodeSize(node) {
  const chars = Array.from(node.label || node.id).length;
  let width = clamp(96 + chars * 7, 150, 340);
  let height = 56;
  if (node.shape === "diamond") {
    width += 48;
    height = 88;
  } else if (node.shape === "subroutine") {
    width += 18;
    height = 62;
  } else if (node.shape === "round") {
    width += 10;
  }
  return { width: round(width), height };
}

/**
 * Longest-path rank layout. Deterministic: same spec → same coordinates.
 * Returns boxes keyed by node id plus the diagram's own width/height.
 */
function layout(spec) {
  const nodes = spec.nodes || [];
  const edges = spec.edges || [];
  const direction = DIRECTIONS.has(spec.direction) ? spec.direction : "TD";
  const horizontal = direction === "LR" || direction === "RL";

  const rank = new Map(nodes.map((node) => [node.id, 0]));
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      if (!rank.has(edge.from) || !rank.has(edge.to)) continue;
      const next = rank.get(edge.from) + 1;
      if (next > rank.get(edge.to) && next < nodes.length) {
        rank.set(edge.to, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const buckets = Array.from({ length: Math.max(1, nodes.length) }, () => []);
  for (const node of nodes) buckets[rank.get(node.id) || 0].push(node);
  const groups = buckets.filter((group) => group.length);
  if (direction === "RL" || direction === "BT") groups.reverse();

  const size = new Map(nodes.map((node) => [node.id, nodeSize(node)]));
  const boxes = new Map();

  if (!horizontal) {
    const rowWidths = groups.map((row) =>
      row.reduce((sum, node, index) => sum + size.get(node.id).width + (index ? GAP_X : 0), 0),
    );
    const width = Math.max(0, ...rowWidths);
    let y = 0;
    groups.forEach((row, rowIndex) => {
      const rowHeight = Math.max(...row.map((node) => size.get(node.id).height), 0);
      let x = (width - rowWidths[rowIndex]) / 2;
      for (const node of row) {
        const box = size.get(node.id);
        boxes.set(node.id, { x, y: y + (rowHeight - box.height) / 2, width: box.width, height: box.height });
        x += box.width + GAP_X;
      }
      y += rowHeight + GAP_Y;
    });
    return { boxes, width, height: groups.length ? y - GAP_Y : 0, direction, horizontal };
  }

  const colHeights = groups.map((column) =>
    column.reduce((sum, node, index) => sum + size.get(node.id).height + (index ? GAP_Y : 0), 0),
  );
  const height = Math.max(0, ...colHeights);
  let x = 0;
  groups.forEach((column, columnIndex) => {
    const colWidth = Math.max(...column.map((node) => size.get(node.id).width), 0);
    let y = (height - colHeights[columnIndex]) / 2;
    for (const node of column) {
      const box = size.get(node.id);
      boxes.set(node.id, { x: x + (colWidth - box.width) / 2, y, width: box.width, height: box.height });
      y += box.height + GAP_Y;
    }
    x += colWidth + GAP_X;
  });
  return { boxes, width: groups.length ? x - GAP_X : 0, height, direction, horizontal };
}

/** Size of the laid-out diagram, used to centre it in the viewport. */
export function measureSpec(spec) {
  const { width, height } = layout(spec);
  return { width: round(width), height: round(height) };
}

function edgePoints(fromBox, toBox, horizontal) {
  const fromCx = fromBox.x + fromBox.width / 2;
  const fromCy = fromBox.y + fromBox.height / 2;
  const toCx = toBox.x + toBox.width / 2;
  const toCy = toBox.y + toBox.height / 2;

  if (!horizontal) {
    if (toCy >= fromCy) {
      return [
        [fromCx, fromBox.y + fromBox.height],
        [toCx, toBox.y],
      ];
    }
    return [
      [fromCx, fromBox.y],
      [toCx, toBox.y + toBox.height],
    ];
  }
  if (toCx >= fromCx) {
    return [
      [fromBox.x + fromBox.width, fromCy],
      [toBox.x, toCy],
    ];
  }
  return [
    [fromBox.x, fromCy],
    [toBox.x + toBox.width, toCy],
  ];
}

function selfLoopPoints(box) {
  return [
    [box.x + box.width, box.y + box.height / 2],
    [box.x + box.width + 34, box.y + box.height / 2],
    [box.x + box.width + 34, box.y - 26],
    [box.x + box.width / 2, box.y - 26],
    [box.x + box.width / 2, box.y],
  ];
}

/**
 * Turn a spec into skeletons for convertToExcalidrawElements().
 * Node boxes never overlap: same-rank nodes get their own column (or row),
 * separated by fixed gaps, and every row/column is as tall (wide) as its
 * largest member.
 */
export function specToElements(spec, origin = { x: 0, y: 0 }) {
  const { boxes, direction, horizontal } = layout(spec);
  const ox = Number.isFinite(origin?.x) ? origin.x : 0;
  const oy = Number.isFinite(origin?.y) ? origin.y : 0;
  const nodes = spec.nodes || [];
  const edges = spec.edges || [];
  const ids = new Map(nodes.map((node, index) => [node.id, `n${index}`]));

  const elements = nodes.map((node) => {
    const box = boxes.get(node.id);
    const base = {
      type: node.shape === "diamond" ? "diamond" : "rectangle",
      id: ids.get(node.id),
      x: round(box.x + ox),
      y: round(box.y + oy),
      width: round(box.width),
      height: round(box.height),
      label: { text: node.label || node.id, fontSize: 16 },
    };
    if (node.shape === "round") base.roundness = { type: 3 };
    return base;
  });

  edges.forEach((edge, index) => {
    const fromBox = boxes.get(edge.from);
    const toBox = boxes.get(edge.to);
    const points =
      edge.from === edge.to ? selfLoopPoints(fromBox) : edgePoints(fromBox, toBox, horizontal);
    // convertToExcalidrawElements() assumes points[0] is the element origin,
    // so anchor x/y on the arrow's first point and keep the rest relative.
    const [startX, startY] = points[0];
    const relative = points.map(([x, y]) => [round(x - startX), round(y - startY)]);
    const xs = relative.map(([x]) => x);
    const ys = relative.map(([, y]) => y);
    const skeleton = {
      type: "arrow",
      id: `e${index}`,
      x: round(startX + ox),
      y: round(startY + oy),
      width: round(Math.max(...xs) - Math.min(...xs)),
      height: round(Math.max(...ys) - Math.min(...ys)),
      points: relative,
      start: { id: ids.get(edge.from) },
      end: { id: ids.get(edge.to) },
      endArrowhead: edge.arrow === false ? null : "arrow",
    };
    if (edge.strokeStyle) skeleton.strokeStyle = edge.strokeStyle;
    if (edge.label) skeleton.label = { text: edge.label, fontSize: 14 };
    elements.push(skeleton);
  });

  return elements;
}

/** Parse + lay out in one step; throws a readable Error on bad input. */
export function buildDiagram(mermaidText, origin = { x: 0, y: 0 }) {
  const spec = mermaidToSpec(mermaidText);
  const elements = specToElements(spec, origin);
  return { elements, nodes: spec.nodes, edges: spec.edges, direction: spec.direction };
}

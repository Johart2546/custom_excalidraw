import test from "node:test";
import assert from "node:assert/strict";

import { buildDiagram, measureSpec, mermaidToSpec, specToElements } from "./diagram.js";

const SIMPLE = `flowchart TD
  A[รับใบลา] --> B{ตรวจสอบ}
  B -->|ผ่าน| C[อนุมัติ]
  B -->|ไม่ผ่าน| D[ตีกลับ]
  D --> A`;

function boxOf(elements, label) {
  return elements.find((element) => element.label?.text === label);
}

function overlaps(a, b) {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

test("simple chain keeps nodes and edges in order", () => {
  const spec = mermaidToSpec("flowchart TD\n  A --> B --> C");
  assert.equal(spec.direction, "TD");
  assert.deepEqual(
    spec.nodes.map((node) => node.id),
    ["A", "B", "C"],
  );
  assert.deepEqual(
    spec.edges.map((edge) => [edge.from, edge.to]),
    [
      ["A", "B"],
      ["B", "C"],
    ],
  );
  assert.equal(spec.edges[0].arrow, true);
});

test("edge labels work in both mermaid forms", () => {
  const spec = mermaidToSpec("flowchart TD\n  A -- ไปต่อ --> B\n  B -->|ใช่| C\n  C --- D");
  assert.equal(spec.edges.length, 3);
  assert.equal(spec.edges[0].label, "ไปต่อ");
  assert.equal(spec.edges[1].label, "ใช่");
  assert.equal(spec.edges[2].label, "");
  assert.equal(spec.edges[2].arrow, false);
});

test("shapes survive the parse: box, round, decision, subroutine", () => {
  const spec = mermaidToSpec("flowchart TD\n  A[กล่อง] --> B(กลม)\n  B --> C{ตัดสินใจ}\n  C --> D[[ซับรูทีน]]");
  const shapes = Object.fromEntries(spec.nodes.map((node) => [node.id, node.shape]));
  assert.deepEqual(shapes, { A: "rect", B: "round", C: "diamond", D: "subroutine" });
});

test("comments, classDef and subgraph/end are skipped without losing inner nodes", () => {
  const spec = mermaidToSpec(`%% นี่คือคอมเมนต์
flowchart TD
  subgraph ขั้นตอน
    A[เริ่ม] --> B{ตรวจ}
    B -->|ผ่าน| C[จบ]
  end
  classDef warm fill:#fee
  class A warm
  style B stroke:#333`);
  assert.deepEqual(
    spec.nodes.map((node) => node.id),
    ["A", "B", "C"],
  );
  assert.equal(spec.edges.length, 2);
  assert.ok(!spec.nodes.some((node) => node.id === "subgraph"));
});

test("a fenced mermaid answer is accepted as-is", () => {
  const spec = mermaidToSpec("Here you go:\n```mermaid\nflowchart TD\n  A --> B\n```\nThanks");
  assert.equal(spec.nodes.length, 2);
});

test("unparsable input throws a readable error", () => {
  assert.throws(() => mermaidToSpec("hello world"), /ไม่พบไดอะแกรม/);
  assert.throws(() => mermaidToSpec("flowchart TD\n  A -->"), /บรรทัด 2/);
  assert.throws(() => buildDiagram("flowchart LR\n  A -x-> B"));
});

test("six-node graph lays out without overlapping boxes", () => {
  const spec = mermaidToSpec(`flowchart TD
    A[หนึ่ง] --> B[สอง]
    A --> C[สาม]
    B --> D{สี่}
    C --> D
    D --> E(ห้า)
    E --> F[[หก]]`);
  assert.equal(spec.nodes.length, 6);
  const elements = specToElements(spec, { x: 0, y: 0 });
  const boxes = elements.filter((element) => element.type === "rectangle" || element.type === "diamond");
  assert.equal(boxes.length, 6);
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      assert.ok(!overlaps(boxes[i], boxes[j]), `${boxes[i].label.text} overlaps ${boxes[j].label.text}`);
    }
  }
  const bounds = measureSpec(spec);
  for (const box of boxes) {
    assert.ok(box.x >= 0 && box.y >= 0, "nodes stay inside the measured diagram");
    assert.ok(box.x + box.width <= bounds.width + 1, "no node sticks out to the right");
    assert.ok(box.y + box.height <= bounds.height + 1, "no node sticks out at the bottom");
  }
});

test("arrows attach to node edges, not centres, and carry bindings", () => {
  const spec = mermaidToSpec("flowchart TD\n  A[หนึ่ง] --> B[สอง]");
  const elements = specToElements(spec, { x: 0, y: 0 });
  const arrow = elements.find((element) => element.type === "arrow");
  const from = boxOf(elements, "หนึ่ง");
  const to = boxOf(elements, "สอง");
  assert.equal(arrow.start.id, from.id);
  assert.equal(arrow.end.id, to.id);
  assert.equal(arrow.y, from.y + from.height, "arrow box starts at the source bottom edge");
  assert.equal(arrow.y + arrow.height, to.y, "arrow ends on the target top edge");
  assert.equal(arrow.x + arrow.points[0][0], from.x + from.width / 2);
  assert.equal(arrow.x + arrow.points[1][0], to.x + to.width / 2);
  assert.equal(arrow.endArrowhead, "arrow");
});

test("LR direction ranks left to right", () => {
  const spec = mermaidToSpec("flowchart LR\n  A[หนึ่ง] --> B[สอง] --> C[สาม]");
  const elements = specToElements(spec, { x: 0, y: 0 });
  const a = boxOf(elements, "หนึ่ง");
  const b = boxOf(elements, "สอง");
  const c = boxOf(elements, "สาม");
  assert.ok(a.x < b.x && b.x < c.x, "rank 0 is leftmost");
});

test("buildDiagram returns elements plus the parsed graph", () => {
  const result = buildDiagram(SIMPLE, { x: 10, y: 20 });
  assert.equal(result.nodes.length, 4);
  assert.equal(result.edges.length, 4);
  assert.equal(result.elements.length, 8, "4 containers + 4 arrows");
  assert.ok(result.elements.every((element) => Number.isFinite(element.x) && Number.isFinite(element.y)));
});

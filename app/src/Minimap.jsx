import { useCallback, useEffect, useRef } from "react";

/* A live miniature of the board, in the spirit of excalidraw.com's minimap:
   the whole scene scaled into a small frosted card, with the current viewport
   drawn on top. Clicking or dragging inside the card recentres the board.

   The card owns its own canvas and talks to Excalidraw only through the API
   ref, so panning, zooming and drawing never re-render React: onChange and
   onScrollChange just schedule one requestAnimationFrame redraw. */

const SCENE_PAD = 24; // scene-px breathing room around the content bounds
const INSET = 7; // css-px between the map drawing and the card edge
const MAX_DPR = 2; // a 2x bitmap is plenty for a 200px-wide picture
const ACCENT = "#6360d9"; // the app's accent, same as --accent
const FALLBACK_INK = "#868e96"; // elements that carry no usable colour

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/* Excalidraw stores colours as #rgb / #rrggbb or "transparent". */
function tint(color, alpha) {
  const match = HEX.exec(typeof color === "string" ? color : "");
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3) hex = hex.split("").map((ch) => ch + ch).join("");
  const value = Number.parseInt(hex, 16);
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
}

/* Linear elements keep their points relative to element.x/y and a point may
   sit left of or above that origin, so their box comes from the points. */
function elementBox(element) {
  const linear =
    element.type === "line" || element.type === "arrow" || element.type === "freedraw";
  if (linear && Array.isArray(element.points) && element.points.length) {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const point of element.points) {
      const px = element.x + point[0];
      const py = element.y + point[1];
      if (px < minX) minX = px;
      if (px > maxX) maxX = px;
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }
  return {
    x: element.x,
    y: element.y,
    width: element.width || 0,
    height: element.height || 0,
  };
}

/* The box an element actually covers once its angle is applied. */
function rotatedBox(box, angle) {
  if (!angle) return box;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [px, py] of [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x + box.width, box.y + box.height],
    [box.x, box.y + box.height],
  ]) {
    const dx = px - cx;
    const dy = py - cy;
    const x = cx + dx * cos - dy * sin;
    const y = cy + dx * sin + dy * cos;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/* scrollX/scrollY are scene units in Excalidraw 0.18: a scene point is drawn
   at (scene + scroll) * zoom, so the visible scene box starts at -scroll. */
function viewportRect(appState) {
  const zoom = appState?.zoom?.value || 1;
  const width = appState?.width || 0;
  const height = appState?.height || 0;
  return {
    x: -(appState?.scrollX || 0),
    y: -(appState?.scrollY || 0),
    width: width / zoom,
    height: height / zoom,
  };
}

/* Fit the (padded) content into the drawing area, keeping the aspect ratio. */
function fitMap(bounds, width, height) {
  const spanX = Math.max(1, bounds.maxX - bounds.minX);
  const spanY = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min(
    Math.max(1, width - INSET * 2) / spanX,
    Math.max(1, height - INSET * 2) / spanY,
  );
  const ox = (width - spanX * scale) / 2 - bounds.minX * scale;
  const oy = (height - spanY * scale) / 2 - bounds.minY * scale;
  return { scale, ox, oy, minX: bounds.minX, minY: bounds.minY };
}

function sceneBounds(elements) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const element of elements) {
    const box = rotatedBox(elementBox(element), element.angle);
    if (box.width <= 0 && box.height <= 0) continue;
    if (box.x < minX) minX = box.x;
    if (box.y < minY) minY = box.y;
    if (box.x + box.width > maxX) maxX = box.x + box.width;
    if (box.y + box.height > maxY) maxY = box.y + box.height;
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/* One shape, already in scene coordinates: the caller has applied the map
   scale, so a 1/scale line width is exactly one css pixel. */
function paintElement(ctx, element, scale) {
  const box = elementBox(element);
  if (box.width <= 0 && box.height <= 0) return;
  const px = 0.9 / scale;
  const fill = tint(element.backgroundColor, 0.5);
  const stroke = tint(element.strokeColor, 0.85) || tint(FALLBACK_INK, 0.55);
  const type = element.type;

  ctx.save();
  if (element.angle) {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    ctx.translate(cx, cy);
    ctx.rotate(element.angle);
    ctx.translate(-cx, -cy);
  }
  ctx.lineWidth = px;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  if (type === "line" || type === "arrow" || type === "freedraw") {
    if (!Array.isArray(element.points) || element.points.length < 2) {
      ctx.restore();
      return;
    }
    ctx.beginPath();
    for (let i = 0; i < element.points.length; i += 1) {
      const x = element.x + element.points[i][0];
      const y = element.y + element.points[i][1];
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  } else if (type === "ellipse") {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    ctx.beginPath();
    ctx.ellipse(cx, cy, Math.max(0.1, box.width / 2), Math.max(0.1, box.height / 2), 0, 0, Math.PI * 2);
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  } else if (type === "diamond") {
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    ctx.beginPath();
    ctx.moveTo(cx, box.y);
    ctx.lineTo(box.x + box.width, cy);
    ctx.lineTo(cx, box.y + box.height);
    ctx.lineTo(box.x, cy);
    ctx.closePath();
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
  } else if (type === "text") {
    // text reads as a small bar of ink rather than a glyph at this size
    const ink = tint(element.strokeColor, 0.34) || tint(FALLBACK_INK, 0.28);
    if (ink) {
      ctx.fillStyle = ink;
      ctx.fillRect(box.x, box.y, Math.max(0.6, box.width), Math.max(0.6, box.height));
    }
  } else {
    // rectangle, image, frame, embeddable and anything else box-shaped
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fillRect(box.x, box.y, box.width, box.height);
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      if (type === "frame" || type === "magicframe") {
        ctx.setLineDash([3 / scale, 3 / scale]);
      }
      ctx.strokeRect(box.x, box.y, box.width, box.height);
    }
  }
  ctx.restore();
}

export default function Minimap({ apiRef, visible = true, onDismiss }) {
  const canvasRef = useRef(null);
  const zoomRef = useRef(null);
  const mapRef = useRef(null); // last transform, reused for pointer maths
  const dragRef = useRef(null); // pointerId while dragging inside the card

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const api = apiRef?.current;
    if (!canvas || !api) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const rect = canvas.getBoundingClientRect();
    const width = Math.round(rect.width);
    const height = Math.round(rect.height);
    if (width < 2 || height < 2) return;

    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const bitmapW = Math.max(1, Math.round(width * dpr));
    const bitmapH = Math.max(1, Math.round(height * dpr));
    if (canvas.width !== bitmapW || canvas.height !== bitmapH) {
      canvas.width = bitmapW;
      canvas.height = bitmapH;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const appState = api.getAppState();
    const viewport = viewportRect(appState);
    const elements = api.getSceneElements().filter((element) => !element.isDeleted);
    const bounds =
      sceneBounds(elements) || {
        minX: viewport.x,
        minY: viewport.y,
        maxX: viewport.x + viewport.width,
        maxY: viewport.y + viewport.height,
      };
    const padded = {
      minX: bounds.minX - SCENE_PAD,
      minY: bounds.minY - SCENE_PAD,
      maxX: bounds.maxX + SCENE_PAD,
      maxY: bounds.maxY + SCENE_PAD,
    };
    const map = fitMap(padded, width, height);
    mapRef.current = map;

    ctx.save();
    ctx.translate(map.ox, map.oy);
    ctx.scale(map.scale, map.scale);
    for (const element of elements) paintElement(ctx, element, map.scale);
    ctx.restore();

    // the viewport: where the editor is looking right now
    const vx = viewport.x * map.scale + map.ox;
    const vy = viewport.y * map.scale + map.oy;
    const vw = Math.max(1, viewport.width * map.scale);
    const vh = Math.max(1, viewport.height * map.scale);
    ctx.save();
    ctx.fillStyle = tint(ACCENT, 0.1) || "rgba(99, 96, 217, 0.1)";
    ctx.strokeStyle = tint(ACCENT, 0.85) || ACCENT;
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.rect(vx, vy, vw, vh);
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    if (zoomRef.current) zoomRef.current.textContent = `${Math.round((appState?.zoom?.value || 1) * 100)}%`;
  }, [apiRef]);

  /* Subscribe to the editor once its API ref exists, and redraw at most once
     per animation frame however chatty onChange is. */
  useEffect(() => {
    if (!visible) return undefined;
    let disposed = false;
    let attachFrame = 0;
    let drawFrame = 0;
    let offChange = null;
    let offScroll = null;

    const schedule = () => {
      if (drawFrame) return;
      drawFrame = window.requestAnimationFrame(() => {
        drawFrame = 0;
        if (!disposed) draw();
      });
    };

    const attach = () => {
      if (disposed) return;
      const api = apiRef?.current;
      if (!api) {
        attachFrame = window.requestAnimationFrame(attach);
        return;
      }
      offChange = api.onChange(() => schedule());
      offScroll = typeof api.onScrollChange === "function" ? api.onScrollChange(() => schedule()) : null;
      schedule();
    };
    attach();

    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(() => schedule()) : null;
    if (observer && canvasRef.current) observer.observe(canvasRef.current);
    window.addEventListener("resize", schedule);

    /* A window dragged to another display keeps its css size but changes the
       pixel ratio, so no resize fires; the resolution media query does. */
    let dropDpr = () => {};
    const watchDpr = () => {
      if (typeof window.matchMedia !== "function") return;
      const query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
      const onDpr = () => {
        query.removeEventListener("change", onDpr);
        watchDpr();
        schedule();
      };
      query.addEventListener("change", onDpr);
      dropDpr = () => {
        query.removeEventListener("change", onDpr);
        dropDpr = () => {};
      };
    };
    watchDpr();

    return () => {
      disposed = true;
      window.cancelAnimationFrame(attachFrame);
      window.cancelAnimationFrame(drawFrame);
      if (offChange) offChange();
      if (offScroll) offScroll();
      if (observer) observer.disconnect();
      dropDpr();
      window.removeEventListener("resize", schedule);
    };
  }, [visible, apiRef, draw]);

  /* Click / drag inside the card: put that scene point in the middle of the
     editor without touching the zoom. */
  useEffect(() => {
    if (!visible) return undefined;
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    let frame = 0;
    let pending = null;

    const apply = () => {
      frame = 0;
      const point = pending;
      pending = null;
      const api = apiRef?.current;
      if (!point || !api) return;
      const appState = api.getAppState();
      const zoom = appState?.zoom?.value || 1;
      if (!appState?.width || !appState?.height) return;
      api.updateScene({
        appState: {
          scrollX: appState.width / (2 * zoom) - point.x,
          scrollY: appState.height / (2 * zoom) - point.y,
        },
      });
    };

    const queue = (sceneX, sceneY) => {
      pending = { x: sceneX, y: sceneY };
      if (!frame) frame = window.requestAnimationFrame(apply);
    };

    const toScene = (event) => {
      const map = mapRef.current;
      const rect = canvas.getBoundingClientRect();
      if (!map || !rect.width || !rect.height) return null;
      return {
        x: (event.clientX - rect.left - map.ox) / map.scale,
        y: (event.clientY - rect.top - map.oy) / map.scale,
      };
    };

    const onDown = (event) => {
      if (event.button !== 0) return;
      const point = toScene(event);
      if (!point) return;
      event.preventDefault();
      event.stopPropagation();
      dragRef.current = event.pointerId;
      try {
        canvas.setPointerCapture(event.pointerId);
      } catch {
        /* the next move still recentres */
      }
      canvas.classList.add("dragging");
      queue(point.x, point.y);
    };
    const onMove = (event) => {
      if (dragRef.current !== event.pointerId) return;
      const point = toScene(event);
      if (!point) return;
      event.preventDefault();
      event.stopPropagation();
      queue(point.x, point.y);
    };
    const onUp = (event) => {
      if (dragRef.current !== event.pointerId) return;
      dragRef.current = null;
      try {
        canvas.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
      canvas.classList.remove("dragging");
    };

    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onUp);
    return () => {
      window.cancelAnimationFrame(frame);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      canvas.classList.remove("dragging");
    };
  }, [visible, apiRef]);

  if (!visible) return null;

  return (
    <div className="minimap" title="แผนที่ย่อ · คลิกหรือลากเพื่อเลื่อนมุมมอง">
      <canvas ref={canvasRef} className="minimap-map" role="img" aria-label="แผนที่ย่อของกระดาน · คลิกหรือลากเพื่อเลื่อนมุมมอง" />
      <div className="minimap-foot">
        <span>แผนที่ย่อ</span>
        <span ref={zoomRef} className="minimap-zoom">
          100%
        </span>
      </div>
      {onDismiss && (
        <button type="button" className="minimap-hide" onClick={onDismiss} aria-label="ซ่อนแผนที่ย่อ" title="ซ่อนแผนที่ย่อ">
          ×
        </button>
      )}
    </div>
  );
}

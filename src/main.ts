import { attachPointerInput, type PointerSample } from "./input/pointer";
import { clearCanvas, resizeCanvasToDisplaySize } from "./canvas/surface";
import { StrokeEngine, type BrushDab } from "./engine/stroke";

type Tool = "brush" | "eyedropper";
type DirtyRect = {
  left: number;
  top: number;
  right: number;
  bottom: number;
};

const canvas = document.querySelector<HTMLCanvasElement>("#canvas");
const statusEl = document.querySelector<HTMLElement>("#status");
const clearBtn = document.querySelector<HTMLButtonElement>("#clear");
const toolBrushBtn = document.querySelector<HTMLButtonElement>("#tool-brush");
const toolEyedropperBtn =
  document.querySelector<HTMLButtonElement>("#tool-eyedropper");
const brushSizeInput =
  document.querySelector<HTMLInputElement>("#brush-size");
const brushSizeValue =
  document.querySelector<HTMLOutputElement>("#brush-size-value");
const brushFlowInput =
  document.querySelector<HTMLInputElement>("#brush-flow");
const brushFlowValue =
  document.querySelector<HTMLOutputElement>("#brush-flow-value");
const brushOpacityInput =
  document.querySelector<HTMLInputElement>("#brush-opacity");
const brushOpacityValue =
  document.querySelector<HTMLOutputElement>("#brush-opacity-value");
const brushColorInput =
  document.querySelector<HTMLInputElement>("#brush-color");

if (
  !canvas ||
  !statusEl ||
  !clearBtn ||
  !toolBrushBtn ||
  !toolEyedropperBtn ||
  !brushSizeInput ||
  !brushSizeValue ||
  !brushFlowInput ||
  !brushFlowValue ||
  !brushOpacityInput ||
  !brushOpacityValue ||
  !brushColorInput
) {
  throw new Error("Missing required DOM nodes");
}

const ctx = canvas.getContext("2d", {
  alpha: false,
  desynchronized: true,
});

if (!ctx) {
  throw new Error("2D canvas context unavailable");
}

/**
 * Photoshop / Procreate brush model:
 * - Flow: how much paint each dab deposits onto the *stroke layer* (builds up
 *   when you scribble over the same pixels within one stroke).
 * - Opacity: how strongly that finished stroke layer is composited onto the
 *   document. Overlaps within one stroke never exceed this opacity.
 */
const baseCanvas = document.createElement("canvas");
const strokeCanvas = document.createElement("canvas");
const readbackCanvas = document.createElement("canvas");
const baseCtx = baseCanvas.getContext("2d", { alpha: false });
const strokeCtx = strokeCanvas.getContext("2d", { alpha: true });
const readbackCtx = readbackCanvas.getContext("2d", {
  alpha: false,
  willReadFrequently: true,
});

if (!baseCtx || !strokeCtx || !readbackCtx) {
  throw new Error("Offscreen canvas context unavailable");
}
readbackCanvas.width = 1;
readbackCanvas.height = 1;

const strokeEngine = new StrokeEngine();
let lastDab: BrushDab | null = null;
let brushSize = brushSizeInput.valueAsNumber;
let brushFlow = brushFlowInput.valueAsNumber;
let brushOpacity = brushOpacityInput.valueAsNumber;
let brushColor = brushColorInput.value;
let tool: Tool = "brush";
let drawing = false;
let strokeActive = false;
let resizePending = false;
let statusRaf = 0;
let pendingStatus = "";
let compositeRaf = 0;
let strokeBounds: DirtyRect | null = null;
let pendingDirty: DirtyRect | null = null;
let previewBounds: DirtyRect | null = null;
let pendingPreview: PointerSample[] = [];

function setStatus(text: string): void {
  pendingStatus = text;
  if (statusRaf !== 0) return;
  statusRaf = requestAnimationFrame(() => {
    statusRaf = 0;
    statusEl!.textContent = pendingStatus;
  });
}

function percentLabel(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function setTool(next: Tool): void {
  tool = next;
  toolBrushBtn!.classList.toggle("is-active", next === "brush");
  toolEyedropperBtn!.classList.toggle("is-active", next === "eyedropper");
  toolBrushBtn!.setAttribute("aria-pressed", String(next === "brush"));
  toolEyedropperBtn!.setAttribute(
    "aria-pressed",
    String(next === "eyedropper"),
  );
  canvas!.dataset.tool = next;
  setStatus(next === "eyedropper" ? "Eyedropper · tap to sample" : "Brush");
}

function rgbToHex(r: number, g: number, b: number): string {
  return (
    "#" +
    [r, g, b]
      .map((channel) => channel.toString(16).padStart(2, "0"))
      .join("")
  );
}

function sampleColorAt(x: number, y: number): string | null {
  const px = Math.min(canvas!.width - 1, Math.max(0, Math.floor(x)));
  const py = Math.min(canvas!.height - 1, Math.max(0, Math.floor(y)));
  // Keep frequent readback hints isolated from the latency-sensitive display
  // canvas so painting can remain hardware accelerated.
  readbackCtx!.drawImage(canvas!, px, py, 1, 1, 0, 0, 1, 1);
  const [r, g, b] = readbackCtx!.getImageData(0, 0, 1, 1).data;
  if (r === undefined || g === undefined || b === undefined) return null;
  return rgbToHex(r, g, b);
}

function syncOffscreenSize(): void {
  const { width, height } = canvas!;
  if (baseCanvas.width !== width || baseCanvas.height !== height) {
    baseCanvas.width = width;
    baseCanvas.height = height;
  }
  if (strokeCanvas.width !== width || strokeCanvas.height !== height) {
    strokeCanvas.width = width;
    strokeCanvas.height = height;
  }
}

function unionRect(
  current: DirtyRect | null,
  next: DirtyRect | null,
): DirtyRect | null {
  if (!next) return current;
  if (!current) return next;
  return {
    left: Math.min(current.left, next.left),
    top: Math.min(current.top, next.top),
    right: Math.max(current.right, next.right),
    bottom: Math.max(current.bottom, next.bottom),
  };
}

function segmentBounds(
  from: BrushDab,
  to: BrushDab,
  lineWidth: number,
): DirtyRect | null {
  // Include antialiasing fringe around the round cap/join.
  const padding = lineWidth * 0.5 + 2;
  const left = Math.max(0, Math.floor(Math.min(from.x, to.x) - padding));
  const top = Math.max(0, Math.floor(Math.min(from.y, to.y) - padding));
  const right = Math.min(
    canvas!.width,
    Math.ceil(Math.max(from.x, to.x) + padding),
  );
  const bottom = Math.min(
    canvas!.height,
    Math.ceil(Math.max(from.y, to.y) + padding),
  );
  return right > left && bottom > top
    ? { left, top, right, bottom }
    : null;
}

function drawCropped(
  destination: CanvasRenderingContext2D,
  source: HTMLCanvasElement,
  rect: DirtyRect,
): void {
  const width = rect.right - rect.left;
  const height = rect.bottom - rect.top;
  destination.drawImage(
    source,
    rect.left,
    rect.top,
    width,
    height,
    rect.left,
    rect.top,
    width,
    height,
  );
}

function clearDocument(): void {
  clearCanvas(baseCtx!);
  clearCanvas(ctx!);
  strokeCtx!.clearRect(0, 0, strokeCanvas.width, strokeCanvas.height);
  strokeBounds = null;
  pendingDirty = null;
}

function dabSpacing(): number {
  // Resampling must not scale with brush diameter. Large spacing caused visible
  // dots, especially when Pencil pressure made the actual diameter smaller.
  return 2.5 * devicePixelRatio;
}

function beginStrokeLayer(): void {
  syncOffscreenSize();
  lastDab = null;
  strokeBounds = null;
  pendingDirty = null;
  previewBounds = null;
  pendingPreview = [];
  strokeActive = true;
}

/**
 * Paint one continuous section onto the stroke layer. Flow controls the paint
 * deposited by a pass; crossing the same area again builds it up. Opacity is
 * deliberately not used here—it is applied to the complete stroke below.
 */
function paintStrokeDabs(dabs: BrushDab[]): void {
  if (dabs.length === 0) return;

  strokeCtx!.save();
  strokeCtx!.globalCompositeOperation = "source-over";
  strokeCtx!.globalAlpha = brushFlow;
  strokeCtx!.strokeStyle = brushColor;
  strokeCtx!.lineCap = "round";
  strokeCtx!.lineJoin = "round";

  for (const dab of dabs) {
    const from = lastDab ?? dab;
    const pressure = (from.pressure + dab.pressure) * 0.5;
    const pressureScale = 0.15 + pressure * 0.85;
    const lineWidth = brushSize * devicePixelRatio * pressureScale;
    strokeCtx!.lineWidth = lineWidth;
    strokeCtx!.beginPath();
    strokeCtx!.moveTo(from.x, from.y);
    strokeCtx!.lineTo(dab.x, dab.y);
    strokeCtx!.stroke();

    const dirty = segmentBounds(from, dab, lineWidth);
    strokeBounds = unionRect(strokeBounds, dirty);
    pendingDirty = unionRect(pendingDirty, dirty);
    lastDab = dab;
  }

  strokeCtx!.restore();
}

/**
 * document = base (pre-stroke) + strokeLayer * opacity.
 * Within one stroke, scribbling denser only fills the stroke layer — opacity
 * still caps how strong it appears on the document.
 */
function compositeStrokeToDocument(rect: DirtyRect | null): void {
  if (!strokeActive || !rect) return;
  ctx!.save();
  ctx!.globalAlpha = 1;
  ctx!.globalCompositeOperation = "source-over";
  drawCropped(ctx!, baseCanvas, rect);
  ctx!.globalAlpha = brushOpacity;
  drawCropped(ctx!, strokeCanvas, rect);
  ctx!.restore();
}

function paintPredictedTail(samples: PointerSample[]): DirtyRect | null {
  if (!strokeActive || !lastDab || samples.length === 0) return null;

  let from = lastDab;
  let bounds: DirtyRect | null = null;
  ctx!.save();
  ctx!.globalCompositeOperation = "source-over";
  ctx!.globalAlpha = brushOpacity * brushFlow;
  ctx!.strokeStyle = brushColor;
  ctx!.lineCap = "round";
  ctx!.lineJoin = "round";

  for (const sample of samples) {
    const to: BrushDab = {
      x: sample.x,
      y: sample.y,
      pressure: sample.pressure,
    };
    const pressure = (from.pressure + to.pressure) * 0.5;
    const pressureScale = 0.15 + pressure * 0.85;
    const lineWidth = brushSize * devicePixelRatio * pressureScale;
    ctx!.lineWidth = lineWidth;
    ctx!.beginPath();
    ctx!.moveTo(from.x, from.y);
    ctx!.lineTo(to.x, to.y);
    ctx!.stroke();
    bounds = unionRect(bounds, segmentBounds(from, to, lineWidth));
    from = to;
  }

  ctx!.restore();
  return bounds;
}

function requestComposite(): void {
  if (compositeRaf !== 0) return;
  compositeRaf = requestAnimationFrame(() => {
    compositeRaf = 0;
    // Restoring the old preview region erases speculative ink. The latest
    // actual stroke data is already present on strokeCanvas.
    const dirty = unionRect(pendingDirty, previewBounds);
    pendingDirty = null;
    compositeStrokeToDocument(dirty);
    previewBounds = paintPredictedTail(pendingPreview);
  });
}

function endStrokeLayer(): void {
  if (compositeRaf !== 0) {
    cancelAnimationFrame(compositeRaf);
    compositeRaf = 0;
  }

  if (strokeBounds) {
    const displayBounds = unionRect(strokeBounds, previewBounds)!;
    // Bake the completed stroke into the authoritative document, then update
    // only the touched display region.
    baseCtx!.save();
    baseCtx!.globalCompositeOperation = "source-over";
    baseCtx!.globalAlpha = brushOpacity;
    drawCropped(baseCtx!, strokeCanvas, strokeBounds);
    baseCtx!.restore();

    ctx!.save();
    ctx!.globalAlpha = 1;
    ctx!.globalCompositeOperation = "source-over";
    drawCropped(ctx!, baseCanvas, displayBounds);
    ctx!.restore();

    strokeCtx!.clearRect(
      strokeBounds.left,
      strokeBounds.top,
      strokeBounds.right - strokeBounds.left,
      strokeBounds.bottom - strokeBounds.top,
    );
  }

  strokeActive = false;
  lastDab = null;
  strokeBounds = null;
  pendingDirty = null;
  previewBounds = null;
  pendingPreview = [];
}

function fit(): void {
  if (drawing) {
    resizePending = true;
    return;
  }
  const changed = resizeCanvasToDisplaySize(canvas!);
  if (changed) {
    syncOffscreenSize();
    clearDocument();
    setStatus(
      `Canvas ${canvas!.width}×${canvas!.height} (dpr ${devicePixelRatio})`,
    );
  }
}

fit();
window.addEventListener("resize", fit);
window.addEventListener("orientationchange", fit);
window.visualViewport?.addEventListener("resize", fit);

clearBtn.addEventListener("click", () => {
  if (strokeActive) endStrokeLayer();
  clearDocument();
  setStatus("Cleared");
});

toolBrushBtn.addEventListener("click", () => setTool("brush"));
toolEyedropperBtn.addEventListener("click", () => setTool("eyedropper"));

brushSizeInput.addEventListener("input", () => {
  brushSize = brushSizeInput.valueAsNumber;
  brushSizeValue.value = String(brushSize);
  setStatus(`Brush size ${brushSize}px`);
});

brushFlowInput.addEventListener("input", () => {
  brushFlow = brushFlowInput.valueAsNumber;
  brushFlowValue.value = percentLabel(brushFlow);
  setStatus(`Flow ${percentLabel(brushFlow)}`);
});

brushOpacityInput.addEventListener("input", () => {
  brushOpacity = brushOpacityInput.valueAsNumber;
  brushOpacityValue.value = percentLabel(brushOpacity);
  // Live-update the in-progress stroke composite if opacity changes mid-stroke.
  if (strokeActive) {
    pendingDirty = unionRect(pendingDirty, strokeBounds);
    requestComposite();
  }
  setStatus(`Opacity ${percentLabel(brushOpacity)}`);
});

brushColorInput.addEventListener("input", () => {
  brushColor = brushColorInput.value;
  setStatus(`Brush color ${brushColor}`);
});

const detach = attachPointerInput(canvas, {
  onStrokeStart(sample) {
    drawing = true;

    if (tool === "eyedropper") {
      const hex = sampleColorAt(sample.x, sample.y);
      if (hex) {
        brushColor = hex;
        brushColorInput!.value = hex;
        setStatus(`Picked ${hex}`);
      }
      return;
    }

    beginStrokeLayer();
    const dabs = strokeEngine.start(sample, dabSpacing());
    if (dabs.length > 0) {
      paintStrokeDabs(dabs);
      requestComposite();
    }
    setStatus(
      `${sample.pointerType} · p ${sample.pressure.toFixed(2)} · tilt ${sample.tiltX}/${sample.tiltY}`,
    );
  },
  onStrokeMove(samples) {
    if (tool === "eyedropper") {
      const tip = samples.at(-1);
      if (!tip) return;
      const hex = sampleColorAt(tip.x, tip.y);
      if (hex) {
        brushColor = hex;
        brushColorInput!.value = hex;
        setStatus(`Picked ${hex}`);
      }
      return;
    }

    const dabs = strokeEngine.push(samples, dabSpacing());
    if (dabs.length === 0) return;
    paintStrokeDabs(dabs);
    requestComposite();
  },
  onStrokePreview(samples) {
    if (tool !== "brush" || !strokeActive) return;
    pendingPreview = samples;
    requestComposite();
  },
  onStrokeEnd(sample) {
    if (tool === "brush" && strokeActive) {
      paintStrokeDabs(strokeEngine.finish(sample, dabSpacing()));
      endStrokeLayer();
    }
    drawing = false;
    if (tool === "eyedropper") {
      setTool("brush");
    }
    if (resizePending) {
      resizePending = false;
      fit();
    }
  },
});

void detach;

setTool("brush");
setStatus("Ready · draw with mouse, finger, or Apple Pencil");

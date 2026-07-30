import { attachPointerInput } from "./input/pointer";
import { clearCanvas, resizeCanvasToDisplaySize } from "./canvas/surface";
import {
  initializeRustEngine,
  type BrushDab,
} from "./engine/stroke";

const canvas = document.querySelector<HTMLCanvasElement>("#canvas");
const statusEl = document.querySelector<HTMLElement>("#status");
const clearBtn = document.querySelector<HTMLButtonElement>("#clear");
const brushSizeInput =
  document.querySelector<HTMLInputElement>("#brush-size");
const brushSizeValue =
  document.querySelector<HTMLOutputElement>("#brush-size-value");
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
  !brushSizeInput ||
  !brushSizeValue ||
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

const strokeEngine = await initializeRustEngine();
let lastDab: BrushDab | null = null;
let brushSize = brushSizeInput.valueAsNumber;
let brushOpacity = brushOpacityInput.valueAsNumber;
let brushColor = brushColorInput.value;

function setStatus(text: string): void {
  statusEl!.textContent = text;
}

function paintSegment(from: BrushDab, to: BrushDab): void {
  const pressureScale = 0.15 + to.pressure * 0.85;
  const diameter = brushSize * devicePixelRatio * pressureScale;
  ctx!.beginPath();
  ctx!.moveTo(from.x, from.y);
  ctx!.lineTo(to.x, to.y);
  ctx!.strokeStyle = brushColor;
  ctx!.globalAlpha = brushOpacity;
  ctx!.lineWidth = diameter;
  ctx!.lineCap = "round";
  ctx!.lineJoin = "round";
  ctx!.stroke();
  ctx!.globalAlpha = 1;
}

function fit(): void {
  const changed = resizeCanvasToDisplaySize(canvas!);
  if (changed) {
    clearCanvas(ctx!);
    setStatus(`Canvas ${canvas!.width}×${canvas!.height} (dpr ${devicePixelRatio})`);
  }
}

fit();
window.addEventListener("resize", fit);

clearBtn.addEventListener("click", () => {
  clearCanvas(ctx!);
  lastDab = null;
  setStatus("Cleared");
});

brushSizeInput.addEventListener("input", () => {
  brushSize = brushSizeInput.valueAsNumber;
  brushSizeValue.value = String(brushSize);
  setStatus(`Brush size ${brushSize}px`);
});

brushOpacityInput.addEventListener("input", () => {
  brushOpacity = brushOpacityInput.valueAsNumber;
  const percentage = Math.round(brushOpacity * 100);
  brushOpacityValue.value = `${percentage}%`;
  setStatus(`Brush opacity ${percentage}%`);
});

brushColorInput.addEventListener("input", () => {
  brushColor = brushColorInput.value;
  setStatus(`Brush color ${brushColor}`);
});

const detach = attachPointerInput(canvas, {
  onStrokeStart(sample) {
    const [firstDab] = strokeEngine.start(sample, 2.5 * devicePixelRatio);
    if (firstDab) {
      paintSegment(firstDab, firstDab);
      lastDab = firstDab;
    }
    setStatus(
      `Rust/WASM · ${sample.pointerType} · p ${sample.pressure.toFixed(2)} · tilt ${sample.tiltX}/${sample.tiltY}`,
    );
  },
  onStrokeMove(samples) {
    const dabs = strokeEngine.push(samples, 2.5 * devicePixelRatio);
    for (const dab of dabs) {
      if (lastDab) paintSegment(lastDab, dab);
      lastDab = dab;
    }
    const tip = samples.at(-1);
    if (tip) {
      setStatus(
        `Rust/WASM · ${tip.pointerType} · p ${tip.pressure.toFixed(2)} · ${samples.length} input → ${dabs.length} dab(s)`,
      );
    }
  },
  onStrokeEnd() {
    lastDab = null;
  },
});

// Keep detach reachable for hot-reload / future teardown.
void detach;

setStatus("Rust/WASM engine ready · draw with mouse, finger, or Apple Pencil");

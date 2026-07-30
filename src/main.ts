import { attachPointerInput } from "./input/pointer";
import { clearCanvas, resizeCanvasToDisplaySize } from "./canvas/surface";
import {
  initializeRustEngine,
  type BrushDab,
} from "./engine/stroke";

const canvas = document.querySelector<HTMLCanvasElement>("#canvas");
const statusEl = document.querySelector<HTMLElement>("#status");
const clearBtn = document.querySelector<HTMLButtonElement>("#clear");

if (!canvas || !statusEl || !clearBtn) {
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

function setStatus(text: string): void {
  statusEl!.textContent = text;
}

function paintSegment(from: BrushDab, to: BrushDab): void {
  const radius = 1.5 + to.pressure * 14;
  ctx!.beginPath();
  ctx!.moveTo(from.x, from.y);
  ctx!.lineTo(to.x, to.y);
  ctx!.strokeStyle = "#1a1a1a";
  ctx!.lineWidth = radius * 2;
  ctx!.lineCap = "round";
  ctx!.lineJoin = "round";
  ctx!.stroke();
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

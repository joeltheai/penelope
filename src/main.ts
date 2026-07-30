import { attachPointerInput, type PointerSample } from "./input/pointer";
import { clearCanvas, resizeCanvasToDisplaySize } from "./canvas/surface";

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

let lastSample: PointerSample | null = null;

function setStatus(text: string): void {
  statusEl!.textContent = text;
}

function paintSegment(from: PointerSample, to: PointerSample): void {
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
  lastSample = null;
  setStatus("Cleared");
});

const detach = attachPointerInput(canvas, {
  onStrokeStart(sample) {
    lastSample = sample;
    setStatus(
      `${sample.pointerType} · p ${sample.pressure.toFixed(2)} · tilt ${sample.tiltX}/${sample.tiltY}`,
    );
  },
  onStrokeMove(samples) {
    for (const sample of samples) {
      if (lastSample) paintSegment(lastSample, sample);
      lastSample = sample;
    }
    const tip = samples.at(-1);
    if (tip) {
      setStatus(
        `${tip.pointerType} · p ${tip.pressure.toFixed(2)} · tilt ${tip.tiltX}/${tip.tiltY} · ${samples.length} sample(s)`,
      );
    }
  },
  onStrokeEnd() {
    lastSample = null;
  },
});

// Keep detach reachable for hot-reload / future teardown.
void detach;

setStatus("Draw with mouse, finger, or Apple Pencil");

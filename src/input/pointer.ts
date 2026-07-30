/** A single stylus/finger/mouse sample for stroke building. */
export type PointerSample = {
  x: number;
  y: number;
  /** Normalized pressure in [0, 1]. Mouse reports 0.5 while down. */
  pressure: number;
  tiltX: number;
  tiltY: number;
  pointerType: PointerEvent["pointerType"];
  pointerId: number;
  timeStamp: number;
};

export type StrokeHandlers = {
  onStrokeStart?: (sample: PointerSample) => void;
  onStrokeMove?: (samples: PointerSample[]) => void;
  /** Temporary browser-predicted samples; never commit these to stroke history. */
  onStrokePreview?: (samples: PointerSample[]) => void;
  onStrokeEnd?: (sample: PointerSample) => void;
};

/** Stable CSS→canvas mapping for one stroke (avoid per-sample getBoundingClientRect). */
type CanvasPointerMap = {
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
};

/**
 * EMA smoother for Pencil noise. High-rate stylus samples include tiny sensor
 * jitter; unsmoothed pressure especially makes lineWidth thrash every dab.
 */
class StrokeSmoother {
  #x = 0;
  #y = 0;
  #pressure = 0;
  #initialized = false;
  #posAlpha: number;
  #pressureAlpha: number;

  constructor(posAlpha: number, pressureAlpha: number) {
    this.#posAlpha = posAlpha;
    this.#pressureAlpha = pressureAlpha;
  }

  reset(): void {
    this.#initialized = false;
  }

  apply(sample: PointerSample): PointerSample {
    if (!this.#initialized) {
      this.#initialized = true;
      this.#x = sample.x;
      this.#y = sample.y;
      this.#pressure = sample.pressure;
      return sample;
    }

    this.#x += (sample.x - this.#x) * this.#posAlpha;
    this.#y += (sample.y - this.#y) * this.#posAlpha;
    this.#pressure +=
      (sample.pressure - this.#pressure) * this.#pressureAlpha;

    return {
      ...sample,
      x: this.#x,
      y: this.#y,
      pressure: this.#pressure,
    };
  }
}

function readPointerMap(canvas: HTMLCanvasElement): CanvasPointerMap {
  const rect = canvas.getBoundingClientRect();
  // Prefer clientWidth/Height (integers matching resize) over fractional rect
  // size so scale stays aligned with the drawing buffer — critical in portrait
  // where subpixel layout is common.
  const cssW = canvas.clientWidth || rect.width;
  const cssH = canvas.clientHeight || rect.height;
  return {
    originX: rect.left,
    originY: rect.top,
    scaleX: canvas.width / Math.max(cssW, 1e-6),
    scaleY: canvas.height / Math.max(cssH, 1e-6),
  };
}

function toSample(
  event: PointerEvent,
  map: CanvasPointerMap,
): PointerSample {
  return {
    x: (event.clientX - map.originX) * map.scaleX,
    y: (event.clientY - map.originY) * map.scaleY,
    // Some browsers report 0 for mouse; treat active mouse as mid pressure.
    pressure:
      event.pointerType === "mouse" && event.pressure === 0
        ? 0.5
        : Math.max(0.01, event.pressure),
    tiltX: event.tiltX,
    tiltY: event.tiltY,
    pointerType: event.pointerType,
    pointerId: event.pointerId,
    timeStamp: event.timeStamp,
  };
}

function smootherFor(pointerType: PointerEvent["pointerType"]): StrokeSmoother {
  // Keep committed geometry stable without making it visibly trail the tip.
  // The live predicted tail below covers the remaining input-to-frame gap.
  if (pointerType === "pen") {
    return new StrokeSmoother(0.7, 0.35);
  }
  if (pointerType === "touch") {
    return new StrokeSmoother(0.7, 0.45);
  }
  return new StrokeSmoother(1, 1);
}

/**
 * Wire Pointer Events for drawing. Uses setPointerCapture + getCoalescedEvents
 * so Apple Pencil's ~240 Hz samples aren't collapsed to one per animation frame.
 */
export function attachPointerInput(
  canvas: HTMLCanvasElement,
  handlers: StrokeHandlers,
): () => void {
  let activePointerId: number | null = null;
  let pointerMap: CanvasPointerMap | null = null;
  let smoother: StrokeSmoother | null = null;

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" && event.cancelable) {
      event.preventDefault();
    }
    // Ignore secondary buttons / palm when a stroke is already active.
    if (activePointerId !== null) return;
    if (event.button !== 0 && event.pointerType === "mouse") return;

    activePointerId = event.pointerId;
    pointerMap = readPointerMap(canvas);
    smoother = smootherFor(event.pointerType);
    smoother.reset();
    canvas.setPointerCapture(event.pointerId);

    const sample = smoother.apply(toSample(event, pointerMap));
    handlers.onStrokeStart?.(sample);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" && event.cancelable) {
      event.preventDefault();
    }
    if (event.pointerId !== activePointerId || !pointerMap || !smoother) return;

    // Prefer coalesced samples (high-frequency stylus). Fall back to the event itself.
    const coalesced = event.getCoalescedEvents?.() ?? [];
    const events = coalesced.length > 0 ? coalesced : [event];
    const samples = events.map((e) =>
      smoother!.apply(toSample(e, pointerMap!)),
    );
    handlers.onStrokeMove?.(samples);

    // Predictions reduce perceived tip lag, but they are speculative. Callers
    // render them on a replaceable overlay and never feed them to the engine.
    const predicted = event.getPredictedEvents?.() ?? [];
    handlers.onStrokePreview?.(
      predicted.map((predictedEvent) => toSample(predictedEvent, pointerMap!)),
    );
  };

  const endStroke = (event: PointerEvent) => {
    if (event.pointerType !== "mouse" && event.cancelable) {
      event.preventDefault();
    }
    if (event.pointerId !== activePointerId || !pointerMap || !smoother) return;
    handlers.onStrokePreview?.([]);
    const rawSample = toSample(event, pointerMap);
    const smoothedSample = smoother.apply(rawSample);
    // Finish at the physical release coordinate. Retain smoothed pressure to
    // avoid a width spike, but do not let the position filter truncate ink.
    handlers.onStrokeEnd?.({
      ...smoothedSample,
      x: rawSample.x,
      y: rawSample.y,
    });
    activePointerId = null;
    pointerMap = null;
    smoother = null;
  };

  const onPointerCancel = (event: PointerEvent) => {
    if (event.pointerId !== activePointerId) return;
    handlers.onStrokePreview?.([]);
    // Still notify end so callers can clear drawing locks / pending resize.
    if (pointerMap && smoother) {
      const rawSample = toSample(event, pointerMap);
      const smoothedSample = smoother.apply(rawSample);
      handlers.onStrokeEnd?.({
        ...smoothedSample,
        x: rawSample.x,
        y: rawSample.y,
      });
    } else {
      handlers.onStrokeEnd?.({
        x: 0,
        y: 0,
        pressure: 0,
        tiltX: 0,
        tiltY: 0,
        pointerType: event.pointerType,
        pointerId: event.pointerId,
        timeStamp: event.timeStamp,
      });
    }
    activePointerId = null;
    pointerMap = null;
    smoother = null;
  };

  canvas.addEventListener("pointerdown", onPointerDown, { passive: false });
  canvas.addEventListener("pointermove", onPointerMove, { passive: false });
  canvas.addEventListener("pointerup", endStroke, { passive: false });
  canvas.addEventListener("pointercancel", onPointerCancel);
  // Prevent context menu / long-press on stylus/touch.
  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  return () => {
    canvas.removeEventListener("pointerdown", onPointerDown);
    canvas.removeEventListener("pointermove", onPointerMove);
    canvas.removeEventListener("pointerup", endStroke);
    canvas.removeEventListener("pointercancel", onPointerCancel);
  };
}

export type PenPoint = {
  x: number;
  y: number;
  /** 0–1 from the pointer; mouse typically reports 0.5 */
  pressure: number;
  /** Degrees, −90…90 (Pointer Events) */
  tiltX: number;
  /** Degrees, −90…90 (Pointer Events) */
  tiltY: number;
  /** Radians; π/2 = perpendicular to surface */
  altitudeAngle: number;
  /** Radians; direction of the stylus projection on the surface */
  azimuthAngle: number;
  pointerType: PointerEvent['pointerType'];
  timeStamp: number;
};

export type PenStrokeHandlers = {
  onStrokeStart?: (point: PenPoint) => void;
  onStrokeMove?: (from: PenPoint, to: PenPoint) => void;
  onStrokeEnd?: (point: PenPoint) => void;
};

export type AttachPenOptions = PenStrokeHandlers & {
  /**
   * Map a PointerEvent into sketch coordinates.
   * For q5 WebGPU this should be center-origin canvas space.
   */
  toSketchPoint: (e: PointerEvent) => { x: number; y: number };
  /** Accept pen/touch/mouse. Default: all. */
  accept?: ReadonlyArray<PointerEvent['pointerType']>;
  /**
   * Exponential smoothing of pressure (0 = raw, 1 = frozen).
   * Softens jagged radius changes when the stylus reports noisy pressure.
   */
  pressureSmoothing?: number;
  /** Exponential smoothing for tilt / azimuth / altitude (0 = raw, 1 = frozen). */
  tiltSmoothing?: number;
};

const HALF_PI = Math.PI / 2;

function lerpAngle(a: number, b: number, t: number) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** Derive spherical angles when the browser only exposes tiltX/tiltY. */
export function anglesFromTilt(tiltXDeg: number, tiltYDeg: number) {
  const tx = (tiltXDeg * Math.PI) / 180;
  const ty = (tiltYDeg * Math.PI) / 180;
  const tanX = Math.tan(tx);
  const tanY = Math.tan(ty);
  const r = Math.hypot(tanX, tanY);
  return {
    altitudeAngle: r < 1e-6 ? HALF_PI : Math.max(0, HALF_PI - Math.atan(r)),
    azimuthAngle: Math.atan2(tanX, tanY),
  };
}

/**
 * Pen/stylus (and mouse/touch) input that does not rely on q5's mouse API.
 * q5 clears mouseIsPressed on any pointerup/cancel, which breaks stylus strokes.
 */
export function attachPenInput(canvas: HTMLCanvasElement, options: AttachPenOptions) {
  const accept = options.accept ?? ['pen', 'touch', 'mouse'];
  const pressureSmoothing = Math.min(0.95, Math.max(0, options.pressureSmoothing ?? 0.55));
  const tiltSmoothing = Math.min(0.95, Math.max(0, options.tiltSmoothing ?? 0.35));
  let activeId: number | null = null;
  let prev: PenPoint | null = null;
  let smoothPressure = 0;
  let smoothTiltX = 0;
  let smoothTiltY = 0;
  let smoothAltitude = HALF_PI;
  let smoothAzimuth = 0;

  function sample(e: PointerEvent, reset: boolean): PenPoint {
    const { x, y } = options.toSketchPoint(e);
    // Some mice report pressure 0; treat that as a full press while buttons are down.
    const rawPressure = e.pressure > 0 ? e.pressure : e.buttons ? 0.5 : 0;
    const tiltX = Number.isFinite(e.tiltX) ? e.tiltX : 0;
    const tiltY = Number.isFinite(e.tiltY) ? e.tiltY : 0;
    const fromTilt = anglesFromTilt(tiltX, tiltY);
    const rawAltitude =
      typeof e.altitudeAngle === 'number' && Number.isFinite(e.altitudeAngle)
        ? e.altitudeAngle
        : fromTilt.altitudeAngle;
    const rawAzimuth =
      typeof e.azimuthAngle === 'number' && Number.isFinite(e.azimuthAngle)
        ? e.azimuthAngle
        : fromTilt.azimuthAngle;

    if (reset) {
      smoothPressure = rawPressure;
      smoothTiltX = tiltX;
      smoothTiltY = tiltY;
      smoothAltitude = rawAltitude;
      smoothAzimuth = rawAzimuth;
    } else {
      const pT = 1 - pressureSmoothing;
      const tT = 1 - tiltSmoothing;
      smoothPressure += (rawPressure - smoothPressure) * pT;
      smoothTiltX += (tiltX - smoothTiltX) * tT;
      smoothTiltY += (tiltY - smoothTiltY) * tT;
      smoothAltitude += (rawAltitude - smoothAltitude) * tT;
      smoothAzimuth = lerpAngle(smoothAzimuth, rawAzimuth, tT);
    }

    return {
      x,
      y,
      pressure: smoothPressure,
      tiltX: smoothTiltX,
      tiltY: smoothTiltY,
      altitudeAngle: smoothAltitude,
      azimuthAngle: smoothAzimuth,
      pointerType: e.pointerType,
      timeStamp: e.timeStamp,
    };
  }

  function onPointerDown(e: PointerEvent) {
    if (activeId != null) return;
    if (!accept.includes(e.pointerType)) return;
    e.preventDefault();
    activeId = e.pointerId;
    canvas.setPointerCapture(e.pointerId);
    prev = sample(e, true);
    options.onStrokeStart?.(prev);
  }

  function onPointerMove(e: PointerEvent) {
    if (e.pointerId !== activeId || !prev) return;
    e.preventDefault();

    const events =
      typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length > 0
        ? e.getCoalescedEvents()
        : [e];

    for (const ce of events) {
      const next = sample(ce, false);
      options.onStrokeMove?.(prev, next);
      prev = next;
    }
  }

  function onPointerUp(e: PointerEvent) {
    if (e.pointerId !== activeId) return;
    const point = sample(e, false);
    if (prev) options.onStrokeMove?.(prev, point);
    options.onStrokeEnd?.(point);
    prev = null;
    activeId = null;
    if (canvas.hasPointerCapture(e.pointerId)) {
      canvas.releasePointerCapture(e.pointerId);
    }
  }

  canvas.style.touchAction = 'none';
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerUp);
  canvas.addEventListener('lostpointercapture', onPointerUp);

  return () => {
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('lostpointercapture', onPointerUp);
  };
}

/** q5 WebGPU uses a centered coordinate system. */
export function q5WebGpuPoint(q: { canvas: HTMLCanvasElement; width: number; height: number }) {
  return (e: PointerEvent) => {
    const rect = q.canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / (rect.width || 1)) * q.width;
    const y = ((e.clientY - rect.top) / (rect.height || 1)) * q.height;
    return {
      x: x - q.width / 2,
      y: y - q.height / 2,
    };
  };
}

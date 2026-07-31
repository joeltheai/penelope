import type { PenPoint } from './pen';
import type { Q5Instance } from './q5-instance';

export type BrushKind = 'round' | 'rect';

export type BrushSettings = {
  kind: BrushKind;
  /** Base diameter in sketch units */
  size: number;
  /**
   * Stamp spacing as a fraction of the current stamp radius.
   * Lower = denser. Typical useful range ~0.05–1.
   */
  spacing: number;
  /** 0–1 fill opacity */
  opacity: number;
  color: string;
};

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

export function stampRadius(size: number, pressure: number) {
  // Mice (~0.5) stay near the base size; full press ≈ 2× base radius.
  return Math.max(0.5, (size / 2) * pressure * 2);
}

function applyFill(q: Q5Instance, color: string, opacity: number) {
  const c = q.color(color);
  c.a = opacity;
  q.fill(c);
}

function stampRound(q: Q5Instance, p: PenPoint, settings: BrushSettings) {
  const r = stampRadius(settings.size, p.pressure);
  applyFill(q, settings.color, settings.opacity);
  q.circle(p.x, p.y, r * 2);
}

/**
 * Flat rectangular tip. Azimuth rotates the stamp; altitude flattens it
 * when the stylus leans (so tilt is obvious in the stroke).
 */
function stampRect(q: Q5Instance, p: PenPoint, settings: BrushSettings) {
  const base = stampRadius(settings.size, p.pressure) * 2;
  const lean = 1 - Math.min(1, Math.max(0, p.altitudeAngle / (Math.PI / 2)));
  const w = base * (1.1 + lean * 0.6);
  const h = base * (0.28 + (1 - lean) * 0.5);

  applyFill(q, settings.color, settings.opacity);
  q.push();
  q.translate(p.x, p.y);
  q.rotate(p.azimuthAngle);
  q.rectMode('center');
  q.rect(0, 0, w, h);
  q.pop();
}

function stampAt(q: Q5Instance, p: PenPoint, settings: BrushSettings) {
  if (settings.kind === 'rect') stampRect(q, p, settings);
  else stampRound(q, p, settings);
}

/**
 * Paint along a segment with lerped size/tilt so pressure ramps stay smooth.
 */
export function strokeSegment(
  q: Q5Instance,
  from: PenPoint,
  to: PenPoint,
  settings: BrushSettings,
) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy);
  const midPressure = (from.pressure + to.pressure) / 2;
  const spacing = Math.max(0.25, stampRadius(settings.size, midPressure) * settings.spacing);
  const steps = dist < 1e-4 ? 1 : Math.max(1, Math.ceil(dist / spacing));

  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    stampAt(
      q,
      {
        x: lerp(from.x, to.x, t),
        y: lerp(from.y, to.y, t),
        pressure: lerp(from.pressure, to.pressure, t),
        tiltX: lerp(from.tiltX, to.tiltX, t),
        tiltY: lerp(from.tiltY, to.tiltY, t),
        altitudeAngle: lerp(from.altitudeAngle, to.altitudeAngle, t),
        azimuthAngle: lerp(from.azimuthAngle, to.azimuthAngle, t),
        pointerType: to.pointerType,
        timeStamp: to.timeStamp,
      },
      settings,
    );
  }
}

export function strokeDot(q: Q5Instance, p: PenPoint, settings: BrushSettings) {
  stampAt(q, p, settings);
}

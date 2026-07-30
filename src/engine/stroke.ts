import type { PointerSample } from "../input/pointer";

export type BrushDab = {
  x: number;
  y: number;
  pressure: number;
};

export class StrokeEngine {
  #initialized = false;
  #lastX = 0;
  #lastY = 0;
  #lastPressure = 0;
  #lastOutputX = 0;
  #lastOutputY = 0;
  #distanceToNext = 0;

  start(sample: PointerSample, spacing: number): BrushDab[] {
    this.#initialized = false;
    this.#distanceToNext = 0;
    return this.push([sample], spacing);
  }

  push(samples: PointerSample[], spacing: number): BrushDab[] {
    const safeSpacing = Math.max(spacing, 0.25);
    const dabs: BrushDab[] = [];

    for (const sample of samples) {
      const targetX = sample.x;
      const targetY = sample.y;
      const targetPressure = Math.min(1, Math.max(0, sample.pressure));

      if (!this.#initialized) {
        this.#initialized = true;
        this.#lastX = targetX;
        this.#lastY = targetY;
        this.#lastPressure = targetPressure;
        this.#lastOutputX = targetX;
        this.#lastOutputY = targetY;
        this.#distanceToNext = safeSpacing;
        dabs.push({ x: targetX, y: targetY, pressure: targetPressure });
        continue;
      }

      let startX = this.#lastX;
      let startY = this.#lastY;
      let startPressure = this.#lastPressure;
      let dx = targetX - startX;
      let dy = targetY - startY;
      let segmentLength = Math.hypot(dx, dy);

      while (segmentLength >= this.#distanceToNext) {
        const t = this.#distanceToNext / segmentLength;
        startX += dx * t;
        startY += dy * t;
        startPressure += (targetPressure - startPressure) * t;
        dabs.push({ x: startX, y: startY, pressure: startPressure });
        this.#lastOutputX = startX;
        this.#lastOutputY = startY;

        dx = targetX - startX;
        dy = targetY - startY;
        segmentLength = Math.hypot(dx, dy);
        this.#distanceToNext = safeSpacing;
      }

      this.#distanceToNext -= segmentLength;
      this.#lastX = targetX;
      this.#lastY = targetY;
      this.#lastPressure = targetPressure;
    }

    return dabs;
  }

  /**
   * Process the terminal sample and always emit the exact endpoint. Regular
   * spacing intentionally trails by less than one interval; that is useful
   * during motion but should never truncate the completed stroke.
   */
  finish(sample: PointerSample, spacing: number): BrushDab[] {
    const dabs = this.push([sample], spacing);
    const endpointAlreadyEmitted =
      Math.abs(this.#lastOutputX - sample.x) < 0.001 &&
      Math.abs(this.#lastOutputY - sample.y) < 0.001;

    if (!endpointAlreadyEmitted) {
      dabs.push({
        x: sample.x,
        y: sample.y,
        pressure: Math.min(1, Math.max(0, sample.pressure)),
      });
      this.#lastOutputX = sample.x;
      this.#lastOutputY = sample.y;
    }

    return dabs;
  }
}

import initWasm, {
  StrokeResampler,
} from "../../crate/pkg/penelope_engine";
import type { PointerSample } from "../input/pointer";

export type BrushDab = {
  x: number;
  y: number;
  pressure: number;
};

export class RustStrokeEngine {
  readonly #resampler = new StrokeResampler();

  start(sample: PointerSample, spacing: number): BrushDab[] {
    this.#resampler.reset();
    return this.#push([sample], spacing);
  }

  push(samples: PointerSample[], spacing: number): BrushDab[] {
    return this.#push(samples, spacing);
  }

  #push(samples: PointerSample[], spacing: number): BrushDab[] {
    const packed = new Float32Array(samples.length * 3);

    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      if (!sample) continue;
      packed[index * 3] = sample.x;
      packed[index * 3 + 1] = sample.y;
      packed[index * 3 + 2] = sample.pressure;
    }

    const result = this.#resampler.push(packed, spacing);
    const dabs: BrushDab[] = [];

    for (let index = 0; index < result.length; index += 3) {
      dabs.push({
        x: result[index] ?? 0,
        y: result[index + 1] ?? 0,
        pressure: result[index + 2] ?? 0,
      });
    }

    return dabs;
  }
}

export async function initializeRustEngine(): Promise<RustStrokeEngine> {
  await initWasm();
  return new RustStrokeEngine();
}

import { describe, expect, it } from "vitest";
import type { PointerSample } from "../input/pointer";
import { StrokeEngine } from "./stroke";

function sample(
  x: number,
  y: number,
  pressure = 0.5,
): PointerSample {
  return {
    x,
    y,
    pressure,
    tiltX: 0,
    tiltY: 0,
    pointerType: "pen",
    pointerId: 1,
    timeStamp: x,
  };
}

describe("StrokeEngine", () => {
  it("preserves even spacing across input batches", () => {
    const engine = new StrokeEngine();

    expect(engine.start(sample(0, 0), 2)).toEqual([
      { x: 0, y: 0, pressure: 0.5 },
    ]);
    expect(engine.push([sample(3, 0)], 2)).toEqual([
      { x: 2, y: 0, pressure: 0.5 },
    ]);
    expect(engine.push([sample(5, 0)], 2)).toEqual([
      { x: 4, y: 0, pressure: 0.5 },
    ]);
  });

  it("emits the exact terminal point below normal spacing", () => {
    const engine = new StrokeEngine();
    engine.start(sample(0, 0), 2.5);

    expect(engine.finish(sample(1, 0, 0.8), 2.5)).toEqual([
      { x: 1, y: 0, pressure: 0.8 },
    ]);
  });

  it("does not duplicate an endpoint already emitted on spacing", () => {
    const engine = new StrokeEngine();
    engine.start(sample(0, 0), 2);

    expect(engine.finish(sample(2, 0), 2)).toEqual([
      { x: 2, y: 0, pressure: 0.5 },
    ]);
  });
});

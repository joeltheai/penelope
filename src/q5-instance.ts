/**
 * Local typing for q5 namespace/instance mode.
 *
 * Upstream `q5.d.ts` targets global mode and is incomplete for instances:
 * missing `createCanvas` / `remove` / mouse state, broken color overloads,
 * and `Q5.WebGPU()` typed as sync with 0 args.
 *
 * Docs: https://q5js.org/learn/?webgpu#coreSection
 * Instance mode: https://github.com/q5js/q5.js/wiki/Instance-Mode
 */

export type Q5ColorArg = string | number;

/** Typed surface for a namespaced q5 sketch instance. */
export interface Q5Instance {
  createCanvas(
    w?: number,
    h?: number,
    options?: object,
  ): HTMLCanvasElement | Promise<HTMLCanvasElement>;
  Canvas: Q5Instance['createCanvas'];

  background(c: Q5ColorArg, c1?: number, c2?: number, c3?: number): void;
  fill(c: Q5ColorArg, c1?: number, c2?: number, c3?: number): void;
  stroke(c: Q5ColorArg, c1?: number, c2?: number, c3?: number): void;
  noStroke(): void;
  noFill(): void;
  strokeWeight(weight: number): void;

  circle(x: number, y: number, diameter: number): void;
  ellipse(x: number, y: number, w: number, h?: number): void;
  rect(x: number, y: number, w: number, h?: number): void;
  line(x1: number, y1: number, x2: number, y2: number): void;
  point(x: number, y: number): void;
  capsule(x1: number, y1: number, x2: number, y2: number, r: number): void;
  clear(): void;

  mouseIsPressed: boolean;
  mouseX: number;
  mouseY: number;
  pmouseX: number;
  pmouseY: number;
  width: number;
  height: number;

  draw: (() => void | Promise<void>) | null;
  ready: Promise<void>;
  remove(): Promise<void>;
  noLoop(): void;
  loop(): void;
  resizeCanvas(w: number, h: number): void;
}

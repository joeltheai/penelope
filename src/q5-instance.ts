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

export type Q5ColorArg = string | number | Q5Color;

export type Q5Color = {
  r: number;
  g: number;
  b: number;
  a: number;
  alpha: number;
};

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
  color(c: Q5ColorArg, c1?: number, c2?: number, c3?: number): Q5Color;

  circle(x: number, y: number, diameter: number): void;
  ellipse(x: number, y: number, w: number, h?: number): void;
  rect(x: number, y: number, w: number, h?: number): void;
  rectMode(mode: string): void;
  line(x1: number, y1: number, x2: number, y2: number): void;
  point(x: number, y: number): void;
  capsule(x1: number, y1: number, x2: number, y2: number, r: number): void;
  clear(): void;

  push(): void;
  pop(): void;
  translate(x: number, y: number): void;
  rotate(angle: number): void;

  createGraphics(w: number, h: number, opt?: string | object): Q5Instance;
  image(
    img: Q5Instance | HTMLCanvasElement | object,
    dx?: number,
    dy?: number,
    dw?: number,
    dh?: number,
  ): void;
  imageMode(mode: string): void;
  /** Global alpha for subsequent drawing / images (0–1 in WebGPU). */
  opacity(a: number): void;
  tint(c: Q5ColorArg, c1?: number, c2?: number, c3?: number): void;
  noTint(): void;
  /** When true, WebGPU re-uploads this graphics/image on next `image()`. */
  modified?: boolean;

  mouseIsPressed: boolean;
  mouseX: number;
  mouseY: number;
  pmouseX: number;
  pmouseY: number;
  width: number;
  height: number;
  canvas: HTMLCanvasElement;

  mousePressed: ((e?: PointerEvent) => void) | null;
  mouseDragged: ((e?: PointerEvent) => void) | null;
  mouseReleased: ((e?: PointerEvent) => void) | null;

  draw: (() => void | Promise<void>) | null;
  ready: Promise<void>;
  remove(): Promise<void>;
  noLoop(): void;
  loop(): void;
  resizeCanvas(w: number, h: number): void;
}

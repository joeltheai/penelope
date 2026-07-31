import 'q5';
import type { Q5Instance } from './q5-instance';

type WebGPUFactory = (scope?: string, parent?: HTMLElement) => Promise<Q5Instance>;

/** Create a WebGPU q5 sketch parented to an element (Canvas2D fallback if needed). */
export function createSketch(parent: HTMLElement): Promise<Q5Instance> {
  // q5.d.ts types WebGPU as sync with 0 args; runtime is async (scope, parent).
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return (Q5.WebGPU as unknown as WebGPUFactory)('namespace', parent);
}

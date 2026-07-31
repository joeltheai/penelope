<script lang="ts">
  import { strokeDot, strokeSegment, type BrushKind } from './brush';
  import { attachPenInput, q5WebGpuPoint } from './pen';
  import { createSketch } from './q5';
  import type { Q5Instance } from './q5-instance';

  let color = $state('#1a1a1a');
  let brushSize = $state(24);
  let opacity = $state(1);
  /** Fraction of stamp radius between stamps */
  let spacing = $state(0.28);
  let brushKind = $state<BrushKind>('round');

  function sketch(el: HTMLElement) {
    let q: Q5Instance | undefined;
    let cancelled = false;
    let detachPen: (() => void) | undefined;

    function brush() {
      return { kind: brushKind, size: brushSize, spacing, opacity, color };
    }

    (async () => {
      q = await createSketch(el);
      if (cancelled) {
        await q.remove();
        return;
      }

      q.createCanvas(el.clientWidth, el.clientHeight);
      q.background('#f4f4f4');
      q.noStroke();
      q.canvas.style.cursor = 'crosshair';

      detachPen = attachPenInput(q.canvas, {
        toSketchPoint: q5WebGpuPoint(q),
        pressureSmoothing: 0.55,
        onStrokeStart: (p) => {
          if (!q) return;
          strokeDot(q, p, brush());
        },
        onStrokeMove: (from, to) => {
          if (!q) return;
          strokeSegment(q, from, to, brush());
        },
      });
    })();

    return () => {
      cancelled = true;
      detachPen?.();
      void q?.remove();
    };
  }
</script>

<div class="relative h-full w-full bg-neutral-200">
  <div class="h-full w-full [&_canvas]:block [&_canvas]:touch-none" {@attach sketch}></div>

  <div
    class="absolute bottom-4 left-4 z-1 flex max-w-[min(100%-2rem,22rem)] flex-col gap-3 rounded-xl bg-white/90 px-4 py-3 text-sm text-neutral-800 shadow-sm backdrop-blur-sm"
  >
    <div class="flex gap-2">
      <button
        type="button"
        class="flex-1 rounded-md px-2 py-1.5 {brushKind === 'round'
          ? 'bg-neutral-900 text-white'
          : 'bg-neutral-100 text-neutral-700'}"
        onclick={() => (brushKind = 'round')}
      >
        Round
      </button>
      <button
        type="button"
        class="flex-1 rounded-md px-2 py-1.5 {brushKind === 'rect'
          ? 'bg-neutral-900 text-white'
          : 'bg-neutral-100 text-neutral-700'}"
        onclick={() => (brushKind = 'rect')}
      >
        Rectangle
      </button>
    </div>

    <label class="flex flex-col gap-1">
      <span class="flex justify-between text-xs text-neutral-500">
        <span>Size</span>
        <span>{Math.round(brushSize)}</span>
      </span>
      <input type="range" min="2" max="400" step="1" bind:value={brushSize} class="w-full" />
    </label>

    <label class="flex flex-col gap-1">
      <span class="flex justify-between text-xs text-neutral-500">
        <span>Opacity</span>
        <span>{Math.round(opacity * 100)}%</span>
      </span>
      <input type="range" min="0.05" max="1" step="0.01" bind:value={opacity} class="w-full" />
    </label>

    <label class="flex flex-col gap-1">
      <span class="flex justify-between text-xs text-neutral-500">
        <span>Spacing</span>
        <span>{spacing.toFixed(2)}</span>
      </span>
      <input type="range" min="0.05" max="1.5" step="0.01" bind:value={spacing} class="w-full" />
    </label>
  </div>

  <label class="absolute right-4 bottom-4 z-1">
    <span class="sr-only">Brush color</span>
    <input
      type="color"
      bind:value={color}
      class="h-12 w-12 cursor-pointer overflow-hidden rounded-full border-2 border-neutral-800 bg-transparent p-0 [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0"
    />
  </label>
</div>

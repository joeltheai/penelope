<script lang="ts">
  import 'q5';

  const BRUSH_RADIUS = 12;

  let color = $state('#1a1a1a');

  function sketch(el: HTMLElement) {
    // q5 instance typings are incomplete for namespace mode — treat as any for now.
    let q: any;
    let cancelled = false;

    (async () => {
      q = await (Q5.WebGPU as any)('namespace', el);
      if (cancelled) {
        await q.remove();
        return;
      }

      q.createCanvas(el.clientWidth, el.clientHeight);
      q.background('#f4f4f4');
      q.noStroke();

      q.draw = () => {
        if (!q.mouseIsPressed) return;
        q.fill(color);
        q.capsule(q.pmouseX, q.pmouseY, q.mouseX, q.mouseY, BRUSH_RADIUS);
      };
    })();

    return () => {
      cancelled = true;
      void q?.remove();
    };
  }
</script>

<div class="relative h-full w-full bg-neutral-200">
  <div class="h-full w-full [&_canvas]:block [&_canvas]:touch-none" {@attach sketch}></div>
  <label class="absolute right-4 bottom-4 z-1">
    <span class="sr-only">Brush color</span>
    <input
      type="color"
      bind:value={color}
      class="h-12 w-12 cursor-pointer overflow-hidden rounded-full border-2 border-neutral-800 bg-transparent p-0 [&::-webkit-color-swatch]:rounded-full [&::-webkit-color-swatch]:border-none [&::-webkit-color-swatch-wrapper]:p-0"
    />
  </label>
</div>

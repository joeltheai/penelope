<script lang="ts">
	import 'q5';

	const BRUSH_RADIUS = 12;

	let color = $state('#1a1a1a');

	function sketch(el: HTMLElement) {
		// q5 instance typings are incomplete for namespace mode — treat as any for now.
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
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

<div class="app">
	<div class="stage" {@attach sketch}></div>
	<label class="picker">
		<span class="visually-hidden">Brush color</span>
		<input type="color" bind:value={color} />
	</label>
</div>

<style>
	.app {
		position: relative;
		width: 100%;
		height: 100%;
	}

	.stage {
		width: 100%;
		height: 100%;
	}

	.stage :global(canvas) {
		display: block;
		touch-action: none;
	}

	.picker {
		position: absolute;
		right: 1rem;
		bottom: 1rem;
		z-index: 1;
	}

	.picker input {
		width: 3rem;
		height: 3rem;
		padding: 0;
		border: 2px solid #333;
		border-radius: 50%;
		background: transparent;
		cursor: pointer;
		overflow: hidden;
	}

	.picker input::-webkit-color-swatch-wrapper {
		padding: 0;
	}

	.picker input::-webkit-color-swatch {
		border: none;
		border-radius: 50%;
	}

	.visually-hidden {
		position: absolute;
		width: 1px;
		height: 1px;
		padding: 0;
		margin: -1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
		border: 0;
	}
</style>

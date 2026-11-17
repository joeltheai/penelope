<script lang="ts">
	const LOUPE_RADIUS = 11;
	const LOUPE_SIZE = 120;
	const LOUPE_OFFSET_Y = 74;

	let {
		color = $bindable('#000000'),
		active = $bindable(false),
		sample
	}: {
		color?: string;
		active?: boolean;
		sample: (sx: number, sy: number) => Promise<{
			width: number;
			height: number;
			pixels: Uint8ClampedArray;
			hex: string;
		} | null>;
	} = $props();

	let loupeActive = $state(false);
	let loupeX = $state(0);
	let loupeY = $state(0);
	let loupeHex = $state('#000000');
	let loupeCanvasEl: HTMLCanvasElement | undefined = $state();
	let loupeBusy = false;
	let loupePending: { sx: number; sy: number } | null = null;

	const loupeLeft = $derived(loupeX - LOUPE_SIZE / 2);
	const loupeTop = $derived(loupeY - LOUPE_OFFSET_Y - LOUPE_SIZE / 2);

	async function updateLoupe(sx: number, sy: number) {
		if (loupeBusy) {
			loupePending = { sx, sy };
			return;
		}
		loupeBusy = true;
		loupeX = sx;
		loupeY = sy;
		loupeActive = true;
		try {
			do {
				const next = loupePending ?? { sx, sy };
				loupePending = null;
				sx = next.sx;
				sy = next.sy;
				loupeX = sx;
				loupeY = sy;

				const patch = await sample(sx, sy);
				const canvas = loupeCanvasEl;
				const ctx = canvas?.getContext('2d');
				const full = LOUPE_RADIUS * 2 + 1;

				if (!patch) {
					loupeHex = '#131215';
					if (ctx && canvas) {
						ctx.fillStyle = '#131215';
						ctx.fillRect(0, 0, full, full);
					}
					continue;
				}

				loupeHex = patch.hex;
				color = patch.hex;

				if (ctx && canvas) {
					const img = ctx.createImageData(patch.width, patch.height);
					img.data.set(patch.pixels);
					ctx.putImageData(img, 0, 0);
				}
			} while (loupePending);
		} finally {
			loupeBusy = false;
		}
	}

	function onLoupePointerDown(e: PointerEvent) {
		if (e.button !== 0 && e.pointerType === 'mouse') return;
		e.preventDefault();
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture(e.pointerId);
		void updateLoupe(e.clientX, e.clientY);
	}

	function onLoupePointerMove(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		if (!el.hasPointerCapture(e.pointerId)) return;
		void updateLoupe(e.clientX, e.clientY);
	}

	function onLoupePointerUp(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		if (el.hasPointerCapture(e.pointerId)) {
			el.releasePointerCapture(e.pointerId);
		}
		if (loupeActive) {
			color = loupeHex;
		}
		loupeActive = false;
		active = false;
	}
</script>

<div
	class="surface"
	style:cursor="none"
	role="presentation"
	aria-label="Eyedropper"
	onpointerdown={onLoupePointerDown}
	onpointermove={onLoupePointerMove}
	onpointerup={onLoupePointerUp}
	onpointercancel={onLoupePointerUp}
>
	{#if loupeActive}
		<div
			class="loupe"
			style:transform="translate3d({loupeLeft}px, {loupeTop}px, 0)"
			style:width="{LOUPE_SIZE}px"
			style:height="{LOUPE_SIZE}px"
			aria-hidden="true"
		>
			<span class="glass">
				<canvas
					bind:this={loupeCanvasEl}
					width={LOUPE_RADIUS * 2 + 1}
					height={LOUPE_RADIUS * 2 + 1}
					class="canvas"
				></canvas>
				<span class="cross" style:background={loupeHex}></span>
				<span class="vignette"></span>
			</span>
			<span class="readout pl-mono">{loupeHex.toUpperCase()}</span>
		</div>
	{/if}
</div>

<style>
	.surface {
		position: fixed;
		inset: 0;
		z-index: 50;
		touch-action: none;
	}

	.loupe {
		position: fixed;
		top: 0;
		left: 0;
		pointer-events: none;
		border-radius: 50%;
		background: var(--pl-bg);
		box-shadow:
			0 0 0 2px var(--pl-accent),
			0 0 0 3px var(--pl-dock),
			0 12px 28px rgba(0, 0, 0, 0.45);
		z-index: 60;
	}

	.glass {
		position: absolute;
		inset: 0;
		display: block;
		border-radius: 50%;
		overflow: hidden;
	}

	.canvas {
		display: block;
		width: 100%;
		height: 100%;
		image-rendering: pixelated;
	}

	.cross {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 15px;
		height: 15px;
		translate: -50% -50%;
		border-radius: 50%;
		border: 2px solid #ffffff;
		box-shadow:
			0 0 0 1px rgba(0, 0, 0, 0.7),
			0 1px 3px rgba(0, 0, 0, 0.4);
	}

	.vignette {
		position: absolute;
		inset: 0;
		border-radius: 50%;
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.28);
		pointer-events: none;
	}

	.readout {
		position: absolute;
		left: 50%;
		bottom: -30px;
		translate: -50% 0;
		padding: 3px 8px;
		font-size: 11px;
		color: var(--pl-ink);
		background: var(--pl-panel);
		border: 1px solid var(--pl-line);
		border-radius: 6px;
		white-space: nowrap;
	}
</style>

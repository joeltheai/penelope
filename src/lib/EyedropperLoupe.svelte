<script lang="ts">
	const LOUPE_RADIUS = 11;
	const LOUPE_SIZE = 118;
	const LOUPE_OFFSET_Y = 72;

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
					loupeHex = '#1c1c1d';
					if (ctx && canvas) {
						ctx.fillStyle = '#1c1c1d';
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
	class="fixed inset-0 z-50 touch-none"
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
			class="loupe pointer-events-none"
			style:left="{loupeX}px"
			style:top="{loupeY - LOUPE_OFFSET_Y}px"
			style:width="{LOUPE_SIZE}px"
			style:height="{LOUPE_SIZE}px"
			aria-hidden="true"
		>
			<canvas
				bind:this={loupeCanvasEl}
				width={LOUPE_RADIUS * 2 + 1}
				height={LOUPE_RADIUS * 2 + 1}
				class="loupe-canvas"
			></canvas>
			<div class="loupe-cross" style:background={loupeHex}></div>
			<div class="loupe-ring"></div>
		</div>
	{/if}
</div>

<style>
	.loupe {
		position: fixed;
		translate: -50% -50%;
		border-radius: 9999px;
		overflow: hidden;
		box-shadow:
			0 8px 28px rgba(0, 0, 0, 0.45),
			0 0 0 3px #fff,
			0 0 0 4px rgba(0, 0, 0, 0.35);
		background: #111;
		z-index: 60;
	}

	.loupe-canvas {
		width: 100%;
		height: 100%;
		image-rendering: pixelated;
		display: block;
	}

	.loupe-cross {
		position: absolute;
		top: 50%;
		left: 50%;
		width: 14px;
		height: 14px;
		translate: -50% -50%;
		border-radius: 9999px;
		border: 2px solid #fff;
		box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
	}

	.loupe-ring {
		position: absolute;
		inset: 0;
		border-radius: 9999px;
		box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.25);
		pointer-events: none;
	}
</style>

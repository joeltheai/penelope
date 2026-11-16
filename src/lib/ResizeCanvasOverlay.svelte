<script lang="ts">
	import {
		applyHandleDelta,
		cropToScreen,
		cursorForHandle,
		hitResizeHandle,
		screenToDocCam,
		type ResizeDrag
	} from '$lib/docResize';

	let {
		cropX = $bindable(0),
		cropY = $bindable(0),
		cropW = $bindable(2000),
		cropH = $bindable(2000),
		camX,
		camY,
		zoom,
		surfaceW,
		surfaceH,
		docW,
		docH,
		space = false,
		onPan,
		onZoom,
		onCancel,
		onApply
	}: {
		cropX?: number;
		cropY?: number;
		cropW?: number;
		cropH?: number;
		camX: number;
		camY: number;
		zoom: number;
		surfaceW: number;
		surfaceH: number;
		docW: number;
		docH: number;
		space?: boolean;
		onPan: (dx: number, dy: number) => void;
		onZoom: (sx: number, sy: number, factor: number) => void;
		onCancel: () => void;
		onApply: () => void;
	} = $props();

	let resizeDrag: ResizeDrag | null = $state(null);
	let resizePanCam: { lastX: number; lastY: number } | null = $state(null);

	const HANDLES: Array<[string, string, string]> = [
		['nw', '0', '0'],
		['ne', '100%', '0'],
		['sw', '0', '100%'],
		['se', '100%', '100%'],
		['n', '50%', '0'],
		['s', '50%', '100%'],
		['w', '0', '50%'],
		['e', '100%', '50%']
	];

	const cropScreen = $derived(
		cropToScreen(
			{ x: cropX, y: cropY, w: cropW, h: cropH },
			{ x: camX, y: camY, zoom },
			{ w: surfaceW, h: surfaceH },
			{ w: docW, h: docH }
		)
	);

	const cropLabel = $derived(`${Math.round(cropW)} × ${Math.round(cropH)}`);

	function onResizePointerDown(e: PointerEvent) {
		if (e.button !== 0 && e.pointerType === 'mouse') return;
		e.preventDefault();
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture(e.pointerId);

		if (space || e.button === 1) {
			resizePanCam = { lastX: e.clientX, lastY: e.clientY };
			return;
		}

		const handle = hitResizeHandle(e.clientX, e.clientY, cropScreen);
		if (!handle) return;
		const p = screenToDocCam(
			e.clientX,
			e.clientY,
			{ x: camX, y: camY, zoom },
			{ w: surfaceW, h: surfaceH },
			{ w: docW, h: docH }
		);
		resizeDrag = {
			handle,
			startDocX: p.x,
			startDocY: p.y,
			origX: cropX,
			origY: cropY,
			origW: cropW,
			origH: cropH
		};
	}

	function onResizePointerMove(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		if (resizePanCam && el.hasPointerCapture(e.pointerId)) {
			onPan(e.clientX - resizePanCam.lastX, e.clientY - resizePanCam.lastY);
			resizePanCam = { lastX: e.clientX, lastY: e.clientY };
			return;
		}
		if (resizeDrag && el.hasPointerCapture(e.pointerId)) {
			const p = screenToDocCam(
				e.clientX,
				e.clientY,
				{ x: camX, y: camY, zoom },
				{ w: surfaceW, h: surfaceH },
				{ w: docW, h: docH }
			);
			const next = applyHandleDelta(resizeDrag.handle, p.x, p.y, resizeDrag);
			cropX = next.x;
			cropY = next.y;
			cropW = next.w;
			cropH = next.h;
			return;
		}
		el.style.cursor = space
			? 'grab'
			: cursorForHandle(hitResizeHandle(e.clientX, e.clientY, cropScreen));
	}

	function onResizePointerUp(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		if (el.hasPointerCapture(e.pointerId)) {
			el.releasePointerCapture(e.pointerId);
		}
		resizeDrag = null;
		resizePanCam = null;
	}

	function onResizeWheel(e: WheelEvent) {
		e.preventDefault();
		let dy = e.deltaY;
		if (e.deltaMode === 1) dy *= 16;
		else if (e.deltaMode === 2) dy *= surfaceH || 800;
		const factor = Math.max(0.01, 1 - dy * 0.001);
		onZoom(e.clientX, e.clientY, factor);
	}
</script>

<div
	class="surface"
	role="presentation"
	aria-label="Resize canvas"
	onpointerdown={onResizePointerDown}
	onpointermove={onResizePointerMove}
	onpointerup={onResizePointerUp}
	onpointercancel={onResizePointerUp}
	onwheel={onResizeWheel}
>
	<div
		class="scrim"
		style:top="0"
		style:left="0"
		style:width="100%"
		style:height="{Math.max(0, cropScreen.top)}px"
	></div>
	<div
		class="scrim"
		style:left="0"
		style:top="{cropScreen.top + cropScreen.height}px"
		style:width="100%"
		style:bottom="0"
	></div>
	<div
		class="scrim"
		style:left="0"
		style:top="{cropScreen.top}px"
		style:width="{Math.max(0, cropScreen.left)}px"
		style:height="{cropScreen.height}px"
	></div>
	<div
		class="scrim"
		style:left="{cropScreen.left + cropScreen.width}px"
		style:top="{cropScreen.top}px"
		style:right="0"
		style:height="{cropScreen.height}px"
	></div>

	<div
		class="crop"
		style:left="{cropScreen.left}px"
		style:top="{cropScreen.top}px"
		style:width="{cropScreen.width}px"
		style:height="{cropScreen.height}px"
	>
		{#each HANDLES as [name, l, t] (name)}
			<div class="handle" style:left={l} style:top={t}></div>
		{/each}
	</div>

	<div
		class="bar"
		role="toolbar"
		tabindex="-1"
		aria-label="Confirm canvas size"
		onpointerdown={(e) => e.stopPropagation()}
	>
		<span class="readout pl-mono">{cropLabel}</span>
		<span class="bar-rule" aria-hidden="true"></span>
		<button type="button" class="btn" title="Cancel (Esc)" onclick={onCancel}>Cancel</button>
		<button type="button" class="btn btn--primary" title="Apply (Enter)" onclick={onApply}>
			Apply
		</button>
	</div>
</div>

<style>
	.surface {
		position: fixed;
		inset: 0;
		z-index: 40;
		touch-action: none;
	}

	.scrim {
		position: absolute;
		pointer-events: none;
		background: rgba(4, 3, 13, 0.78);
	}

	.crop {
		position: absolute;
		pointer-events: none;
		border: 1px solid var(--pl-accent);
		box-shadow:
			0 0 0 1px rgba(0, 0, 0, 0.55),
			0 0 18px rgba(87, 247, 255, 0.5),
			inset 0 0 22px rgba(87, 247, 255, 0.14);
	}

	.handle {
		position: absolute;
		width: 11px;
		height: 11px;
		translate: -50% -50%;
		border-radius: 3px;
		background: radial-gradient(circle at 35% 30%, #ffffff, #b8fdff 55%, #57f7ff);
		box-shadow:
			0 0 0 1px rgba(0, 0, 0, 0.55),
			0 0 10px rgba(87, 247, 255, 0.85),
			0 0 20px rgba(87, 247, 255, 0.35);
	}

	.bar {
		position: absolute;
		left: 50%;
		bottom: calc(16px + env(safe-area-inset-bottom, 0px));
		translate: -50% 0;
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 5px;
		background: var(--pl-panel-bg);
		border: 1px solid var(--pl-line-strong);
		border-radius: 999px;
		box-shadow:
			var(--pl-shadow),
			var(--pl-top-highlight),
			0 0 24px rgba(87, 247, 255, 0.18);
		pointer-events: auto;
	}

	.readout {
		min-width: 104px;
		padding: 0 8px;
		text-align: center;
		font-size: 12px;
		letter-spacing: 0.06em;
		color: var(--pl-accent);
		text-shadow: 0 0 12px rgba(87, 247, 255, 0.45);
		white-space: nowrap;
	}

	.bar-rule {
		width: 1px;
		height: 24px;
		background: linear-gradient(180deg, transparent, var(--pl-line-strong), transparent);
		margin: 0 3px;
	}

	.btn {
		height: var(--pl-tap);
		padding: 0 16px;
		border-radius: 999px;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--pl-dim);
		transition: transform 130ms var(--pl-ease);
	}

	.btn:active {
		transform: scale(0.97);
	}

	@media (hover: hover) {
		.btn:hover {
			background: rgba(87, 247, 255, 0.09);
			color: var(--pl-ink);
		}
	}

	.btn--primary,
	.btn--primary:hover {
		background: linear-gradient(180deg, #b6feff 0%, #57e8ff 44%, #3d9bff 100%);
		color: #03101f;
		text-shadow: 0 1px 0 rgba(255, 255, 255, 0.5);
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.6),
			0 0 16px rgba(87, 247, 255, 0.45);
	}
</style>

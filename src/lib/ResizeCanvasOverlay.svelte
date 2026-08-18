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
		// SAFETY: bound to the resize surface element in the template; currentTarget is that HTMLElement.
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
		// SAFETY: bound to the resize surface element in the template; currentTarget is that HTMLElement.
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
		// SAFETY: bound to the resize surface element in the template; currentTarget is that HTMLElement.
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
	class="fixed inset-0 z-40 touch-none"
	role="presentation"
	aria-label="Resize canvas"
	onpointerdown={onResizePointerDown}
	onpointermove={onResizePointerMove}
	onpointerup={onResizePointerUp}
	onpointercancel={onResizePointerUp}
	onwheel={onResizeWheel}
>
	<!-- Dim outside the crop frame -->
	<div
		class="pointer-events-none absolute bg-black/45"
		style:left="0"
		style:top="0"
		style:width="100%"
		style:height="{Math.max(0, cropScreen.top)}px"
	></div>
	<div
		class="pointer-events-none absolute bg-black/45"
		style:left="0"
		style:top="{cropScreen.top + cropScreen.height}px"
		style:width="100%"
		style:bottom="0"
	></div>
	<div
		class="pointer-events-none absolute bg-black/45"
		style:left="0"
		style:top="{cropScreen.top}px"
		style:width="{Math.max(0, cropScreen.left)}px"
		style:height="{cropScreen.height}px"
	></div>
	<div
		class="pointer-events-none absolute bg-black/45"
		style:left="{cropScreen.left + cropScreen.width}px"
		style:top="{cropScreen.top}px"
		style:right="0"
		style:height="{cropScreen.height}px"
	></div>

	<!-- Crop frame -->
	<div
		class="pointer-events-none absolute border border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,0.35)]"
		style:left="{cropScreen.left}px"
		style:top="{cropScreen.top}px"
		style:width="{cropScreen.width}px"
		style:height="{cropScreen.height}px"
	>
		{#each [['nw', '0', '0'], ['ne', '100%', '0'], ['sw', '0', '100%'], ['se', '100%', '100%'], ['n', '50%', '0'], ['s', '50%', '100%'], ['w', '0', '50%'], ['e', '100%', '50%']] as [name, l, t] (name)}
			<div
				class="absolute size-3 rounded-sm border border-black/40 bg-white"
				style:left={l}
				style:top={t}
				style:translate="-50% -50%"
			></div>
		{/each}
	</div>

	<div
		class="pointer-events-auto absolute bottom-6 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-xl bg-[#1e1e22]/95 px-3 py-2 shadow-[0_8px_28px_rgba(0,0,0,0.45),inset_0_1px_0_rgba(255,255,255,0.06)]"
		role="toolbar"
		tabindex="-1"
		aria-label="Confirm canvas size"
		onpointerdown={(e) => e.stopPropagation()}
	>
		<span class="min-w-[7rem] px-1 text-center text-sm tabular-nums text-white/80">{cropLabel}</span>
		<button
			type="button"
			class="rounded-md bg-[#2a2a2e] px-3 py-1.5 text-sm text-white/75 transition hover:bg-[#34343a] hover:text-white"
			onclick={onCancel}
		>
			Cancel
		</button>
		<button
			type="button"
			class="rounded-md bg-[#3a3a42] px-3 py-1.5 text-sm text-white transition hover:bg-[#4a4a52]"
			onclick={onApply}
		>
			Apply
		</button>
	</div>
</div>

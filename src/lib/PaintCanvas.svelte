<script lang="ts">
	import { createGpuPaint, type GpuPaint } from '$lib/gpuPaint';
	import {
		addStrokeDistance,
		createPenPressureState,
		eventLooksLikeRealPressure,
		getStrokePressure,
		mapPressureCurve,
		resetStrokePressure,
		updateHasPressure
	} from '$lib/penPressure';

	let {
		color = $bindable('#1a6cff'),
		size = $bindable(8),
		opacity = $bindable(1),
		spacing = $bindable(0.06)
	}: { color?: string; size?: number; opacity?: number; spacing?: number } = $props();

	let canvasEl: HTMLCanvasElement | undefined = $state();
	let gpuError = $state<string | null>(null);

	let space = false;
	let alt = false;
	let rotateKey = false;

	function onKeyDown(e: KeyboardEvent) {
		if (e.code === 'Space') {
			e.preventDefault();
			space = true;
		}
		if (e.code === 'AltLeft' || e.code === 'AltRight') alt = true;
		if (e.code === 'KeyR') rotateKey = true;
	}

	function onKeyUp(e: KeyboardEvent) {
		if (e.code === 'Space') space = false;
		if (e.code === 'AltLeft' || e.code === 'AltRight') alt = false;
		if (e.code === 'KeyR') rotateKey = false;
	}

	$effect(() => {
		if (!canvasEl) return;
		const surface = canvasEl;

		let cancelled = false;
		let gpu: GpuPaint | null = null;

		const view = { x: 0, y: 0, zoom: 0.5, rotation: 0 };
		let cssW = 0;
		let cssH = 0;

		let drawing = false;
		let strokeActive = false;
		let panning = false;
		let rotating = false;
		let lastX = 0;
		let lastY = 0;
		let rotatePivot = { x: 0, y: 0 };
		let lastRotateAngle: number | null = null;
		const penState = createPenPressureState();
		let lastPaintScreen: { x: number; y: number } | null = null;

		const touches: Record<number, { x: number; y: number }> = {};
		let pinch: {
			docPoint: { x: number; y: number };
			startDist: number;
			startAngle: number;
			startZoom: number;
			startRotation: number;
		} | null = null;

		function touchList() {
			return Object.values(touches);
		}

		function touchCount() {
			return Object.keys(touches).length;
		}

		function screenToDoc(sx: number, sy: number) {
			if (!gpu) return { x: 0, y: 0 };
			const DOC_W = gpu.docW;
			const DOC_H = gpu.docH;
			const cx = cssW / 2;
			const cy = cssH / 2;
			let x = sx - cx - view.x;
			let y = sy - cy - view.y;
			const cos = Math.cos(-view.rotation);
			const sin = Math.sin(-view.rotation);
			const ux = x * cos - y * sin;
			const uy = x * sin + y * cos;
			return {
				x: ux / view.zoom + DOC_W / 2,
				y: uy / view.zoom + DOC_H / 2
			};
		}

		function present() {
			gpu?.present(view, cssW, cssH, opacity, strokeActive);
		}

		/** Keep the doc point under `pivot` fixed when zoom/rotation change. */
		function setViewAroundPivot(pivotX: number, pivotY: number, newZoom: number, newRotation: number) {
			const MIN_Z = 0.05;
			const MAX_Z = 20;
			if (!gpu) return;
			const before = screenToDoc(pivotX, pivotY);
			view.zoom = Math.min(MAX_Z, Math.max(MIN_Z, newZoom));
			view.rotation = newRotation;

			const cos = Math.cos(view.rotation);
			const sin = Math.sin(view.rotation);
			const dx = (before.x - gpu.docW / 2) * view.zoom;
			const dy = (before.y - gpu.docH / 2) * view.zoom;
			const rx = dx * cos - dy * sin;
			const ry = dx * sin + dy * cos;
			view.x = pivotX - cssW / 2 - rx;
			view.y = pivotY - cssH / 2 - ry;
			present();
		}

		function placeDocAtScreen(docPoint: { x: number; y: number }, screenX: number, screenY: number) {
			if (!gpu) return;
			const cos = Math.cos(view.rotation);
			const sin = Math.sin(view.rotation);
			const dx = (docPoint.x - gpu.docW / 2) * view.zoom;
			const dy = (docPoint.y - gpu.docH / 2) * view.zoom;
			const rx = dx * cos - dy * sin;
			const ry = dx * sin + dy * cos;
			view.x = screenX - cssW / 2 - rx;
			view.y = screenY - cssH / 2 - ry;
		}

		function beginStroke() {
			gpu?.beginStroke();
			strokeActive = true;
		}

		function endStroke() {
			if (!strokeActive || !gpu) return;
			gpu.endStroke(opacity);
			strokeActive = false;
			present();
		}

		function resize() {
			cssW = surface.clientWidth;
			cssH = surface.clientHeight;
			gpu?.resize(cssW, cssH);
			present();
		}

		function samplePressure(e: PointerEvent) {
			return mapPressureCurve(getStrokePressure(e, penState));
		}

		function paintAt(sx: number, sy: number, pressure: number) {
			if (!gpu || pressure <= 0) return;
			const p = screenToDoc(sx, sy);
			// `size` is radius in the old 2d path; stamps use diameter
			gpu.addSample(p.x, p.y, size * 2, pressure, color, spacing);
			gpu.flushStamps(color);
			present();
		}

		function paintPointerSamples(e: PointerEvent) {
			if (!penState.hasPressure && eventLooksLikeRealPressure(e)) {
				penState.hasPressure = true;
			}

			const samples =
				typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
			const events = samples.length > 0 ? samples : [e];

			for (const ce of events) {
				if (lastPaintScreen) {
					addStrokeDistance(
						penState,
						Math.hypot(ce.clientX - lastPaintScreen.x, ce.clientY - lastPaintScreen.y)
					);
				}
				const pressure = samplePressure(ce);
				lastPaintScreen = { x: ce.clientX, y: ce.clientY };
				paintAt(ce.clientX, ce.clientY, pressure);
			}
		}

		function wantsRotate(e: PointerEvent) {
			return alt || e.altKey || rotateKey;
		}

		function onPointerDown(e: PointerEvent) {
			e.preventDefault();
			const active = document.activeElement;
			if (active instanceof HTMLElement && active !== surface) active.blur();

			if (e.pointerType === 'touch') {
				touches[e.pointerId] = { x: e.clientX, y: e.clientY };
				if (touchCount() === 2) {
					if (drawing || strokeActive) endStroke();
					drawing = false;
					const [a, b] = touchList();
					const midX = (a.x + b.x) / 2;
					const midY = (a.y + b.y) / 2;
					pinch = {
						docPoint: screenToDoc(midX, midY),
						startDist: Math.hypot(a.x - b.x, a.y - b.y),
						startAngle: Math.atan2(b.y - a.y, b.x - a.x),
						startZoom: view.zoom,
						startRotation: view.rotation
					};
				}
			}

			surface.setPointerCapture(e.pointerId);
			lastX = e.clientX;
			lastY = e.clientY;

			if (touchCount() >= 2) return;

			if (wantsRotate(e)) {
				rotating = true;
				rotatePivot = { x: e.clientX, y: e.clientY };
				lastRotateAngle = null;
				return;
			}

			if (space || e.button === 1) {
				panning = true;
				return;
			}

			if (e.button === 0 || e.pointerType === 'touch' || e.pointerType === 'pen') {
				drawing = true;
				beginStroke();
				updateHasPressure(e, penState);
				resetStrokePressure(penState);
				lastPaintScreen = null;
				const pressure = samplePressure(e);
				lastPaintScreen = { x: e.clientX, y: e.clientY };
				paintAt(e.clientX, e.clientY, pressure);
			}
		}

		function onPointerMove(e: PointerEvent) {
			if (e.pointerType === 'touch' && touches[e.pointerId]) {
				touches[e.pointerId] = { x: e.clientX, y: e.clientY };
				if (touchCount() === 2 && pinch) {
					const MIN_Z = 0.05;
					const MAX_Z = 20;
					const [a, b] = touchList();
					const dist = Math.hypot(a.x - b.x, a.y - b.y);
					const angle = Math.atan2(b.y - a.y, b.x - a.x);
					const midX = (a.x + b.x) / 2;
					const midY = (a.y + b.y) / 2;

					view.zoom = Math.min(
						MAX_Z,
						Math.max(MIN_Z, pinch.startZoom * (dist / Math.max(pinch.startDist, 1e-6)))
					);
					view.rotation = pinch.startRotation + (angle - pinch.startAngle);
					placeDocAtScreen(pinch.docPoint, midX, midY);
					present();
					return;
				}
			}

			if (rotating) {
				const ang = Math.atan2(e.clientY - rotatePivot.y, e.clientX - rotatePivot.x);
				const dist = Math.hypot(e.clientX - rotatePivot.x, e.clientY - rotatePivot.y);
				if (dist >= 8) {
					if (lastRotateAngle === null) {
						lastRotateAngle = ang;
					} else {
						let dAng = ang - lastRotateAngle;
						if (dAng > Math.PI) dAng -= Math.PI * 2;
						if (dAng < -Math.PI) dAng += Math.PI * 2;
						lastRotateAngle = ang;
						setViewAroundPivot(rotatePivot.x, rotatePivot.y, view.zoom, view.rotation + dAng);
					}
				}
				return;
			}

			if (panning) {
				view.x += e.clientX - lastX;
				view.y += e.clientY - lastY;
				lastX = e.clientX;
				lastY = e.clientY;
				present();
				return;
			}

			// Pen lift often sends a trailing move with buttons=0 / pressure=0
			if (drawing && e.buttons !== 0) {
				paintPointerSamples(e);
			}
		}

		function onPointerUp(e: PointerEvent) {
			delete touches[e.pointerId];
			if (touchCount() < 2) pinch = null;

			if (drawing || strokeActive) endStroke();
			drawing = false;
			panning = false;
			rotating = false;
			lastRotateAngle = null;
			resetStrokePressure(penState);
			lastPaintScreen = null;

			if (surface.hasPointerCapture(e.pointerId)) {
				surface.releasePointerCapture(e.pointerId);
			}
		}

		function onWheel(e: WheelEvent) {
			e.preventDefault();
			const factor = e.deltaY < 0 ? 1.1 : 0.9;
			setViewAroundPivot(e.clientX, e.clientY, view.zoom * factor, view.rotation);
		}

		function onContextMenu(e: Event) {
			e.preventDefault();
		}

		function onSelectStart(e: Event) {
			e.preventDefault();
		}

		function onTouchStart(e: TouchEvent) {
			e.preventDefault();
		}

		const ro = new ResizeObserver(resize);

		surface.addEventListener('pointerdown', onPointerDown);
		surface.addEventListener('pointermove', onPointerMove);
		surface.addEventListener('pointerup', onPointerUp);
		surface.addEventListener('pointercancel', onPointerUp);
		surface.addEventListener('wheel', onWheel, { passive: false });
		surface.addEventListener('contextmenu', onContextMenu);
		surface.addEventListener('selectstart', onSelectStart);
		surface.addEventListener('touchstart', onTouchStart, { passive: false });
		window.addEventListener('resize', resize);

		(async () => {
			try {
				const painter = await createGpuPaint(surface);
				if (cancelled) {
					painter.destroy();
					return;
				}
				gpu = painter;
				gpuError = null;
				ro.observe(surface);
				resize();
			} catch (err) {
				if (cancelled) return;
				gpuError = err instanceof Error ? err.message : 'WebGPU failed to initialize';
			}
		})();

		return () => {
			cancelled = true;
			ro.disconnect();
			gpu?.destroy();
			gpu = null;
			surface.removeEventListener('pointerdown', onPointerDown);
			surface.removeEventListener('pointermove', onPointerMove);
			surface.removeEventListener('pointerup', onPointerUp);
			surface.removeEventListener('pointercancel', onPointerUp);
			surface.removeEventListener('wheel', onWheel);
			surface.removeEventListener('contextmenu', onContextMenu);
			surface.removeEventListener('selectstart', onSelectStart);
			surface.removeEventListener('touchstart', onTouchStart);
			window.removeEventListener('resize', resize);
		};
	});
</script>

<svelte:window onkeydown={onKeyDown} onkeyup={onKeyUp} />

<canvas
	bind:this={canvasEl}
	class="fixed inset-0 block h-full w-full touch-none select-none [-webkit-touch-callout:none]"
	style:background="#1c1c1d"
></canvas>

{#if gpuError}
	<div class="pointer-events-none fixed inset-0 z-20 flex items-center justify-center p-6 text-center">
		<p class="max-w-md rounded-lg bg-black/70 px-4 py-3 text-sm text-white">
			{gpuError}
		</p>
	</div>
{/if}

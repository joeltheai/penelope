<script lang="ts">
	import { createGpuPaint, type GpuPaint } from '$lib/gpuPaint';
	import {
		addStrokeDistance,
		createPenPressureState,
		eventLooksLikeRealPressure,
		getStrokePressure,
		mapPressureCurveForOpacity,
		mapPressureCurveForSize,
		resetStrokePressure,
		updateHasPressure
	} from '$lib/penPressure';

	type HistoryApi = { undo: () => void; redo: () => void };

	let {
		color = $bindable('#1a6cff'),
		size = $bindable(8),
		opacity = $bindable(1),
		spacing = $bindable(0.005),
		pressureSize = $bindable(false),
		pressureOpacity = $bindable(true),
		canUndo = $bindable(false),
		canRedo = $bindable(false),
		historyApi = $bindable(null as null | HistoryApi),
		zoom = $bindable(1)
	}: {
		color?: string;
		size?: number;
		opacity?: number;
		spacing?: number;
		pressureSize?: boolean;
		pressureOpacity?: boolean;
		canUndo?: boolean;
		canRedo?: boolean;
		historyApi?: null | HistoryApi;
		zoom?: number;
	} = $props();

	let canvasEl: HTMLCanvasElement | undefined = $state();
	let gpuError = $state<string | null>(null);

	let space = false;
	let alt = false;
	let rotateKey = false;

	let undoFn: (() => void) | null = null;
	let redoFn: (() => void) | null = null;

	function isEditableTarget(target: EventTarget | null) {
		if (!(target instanceof HTMLElement)) return false;
		const tag = target.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
		return target.isContentEditable;
	}

	function onKeyDown(e: KeyboardEvent) {
		if (e.code === 'Space') {
			e.preventDefault();
			space = true;
		}
		if (e.code === 'AltLeft' || e.code === 'AltRight') alt = true;
		if (e.code === 'KeyR') rotateKey = true;

		const mod = e.metaKey || e.ctrlKey;
		if (!mod || isEditableTarget(e.target)) return;

		if (e.code === 'KeyZ' && !e.shiftKey) {
			e.preventDefault();
			undoFn?.();
			return;
		}
		if ((e.code === 'KeyZ' && e.shiftKey) || e.code === 'KeyY') {
			e.preventDefault();
			redoFn?.();
		}
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

		const view = { x: 0, y: 0, zoom: 1, rotation: 0 };
		let cssW = 0;
		let cssH = 0;
		let fittedOnce = false;

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
		let strokeStartedAt = 0;
		let strokeTravelPx = 0;

		const touches: Record<number, { x: number; y: number }> = {};
		let pinch: {
			docPoint: { x: number; y: number };
			startDist: number;
			startAngle: number;
			startZoom: number;
			startRotation: number;
		} | null = null;

		/** Multi-finger tap: 2 → undo, 3 → redo (must stay still; distinct from pinch). */
		const TAP_SLOP_PX = 14;
		const TAP_MAX_MS = 400;
		/** First finger alone briefly before others — treat as chord, not a paint stroke. */
		const CHORD_MS = 200;
		const CHORD_MOVE_PX = 24;
		let multiTap: {
			startTime: number;
			maxFingers: number;
			origins: Record<number, { x: number; y: number }>;
			moved: boolean;
			/** False if this gesture interrupted a committed paint stroke. */
			eligible: boolean;
		} | null = null;

		function touchList() {
			return Object.values(touches);
		}

		function touchCount() {
			return Object.keys(touches).length;
		}

		function rebaselinePinch() {
			if (touchCount() !== 2) return;
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

		function markMultiTapMoved() {
			if (!multiTap || multiTap.moved) return;
			multiTap.moved = true;
			rebaselinePinch();
		}

		function updateMultiTapMoved() {
			if (!multiTap || multiTap.moved) return;
			for (const id of Object.keys(touches)) {
				const cur = touches[Number(id)];
				const origin = multiTap.origins[Number(id)];
				if (!cur || !origin) continue;
				if (Math.hypot(cur.x - origin.x, cur.y - origin.y) > TAP_SLOP_PX) {
					markMultiTapMoved();
					return;
				}
			}
			if (touchCount() === 2 && pinch) {
				const [a, b] = touchList();
				const dist = Math.hypot(a.x - b.x, a.y - b.y);
				if (Math.abs(dist - pinch.startDist) > TAP_SLOP_PX) {
					markMultiTapMoved();
				}
			}
		}

		function beginOrUpdateMultiTap(committedStroke: boolean) {
			const count = touchCount();
			if (count < 2) return;
			if (!multiTap) {
				multiTap = {
					startTime: performance.now(),
					maxFingers: count,
					origins: {},
					moved: false,
					eligible: !committedStroke
				};
			} else {
				multiTap.maxFingers = Math.max(multiTap.maxFingers, count);
				if (committedStroke) multiTap.eligible = false;
			}
			for (const id of Object.keys(touches)) {
				const pid = Number(id);
				if (!multiTap.origins[pid]) {
					multiTap.origins[pid] = { ...touches[pid]! };
				}
			}
		}

		function finishMultiTap() {
			const tap = multiTap;
			multiTap = null;
			if (!tap || !tap.eligible || tap.moved) return;
			if (performance.now() - tap.startTime > TAP_MAX_MS) return;
			if (tap.maxFingers === 2) runUndo();
			else if (tap.maxFingers === 3) runRedo();
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
			syncZoom();

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
			strokeStartedAt = performance.now();
			strokeTravelPx = 0;
		}

		function syncHistoryFlags() {
			if (!gpu) {
				canUndo = false;
				canRedo = false;
				return;
			}
			canUndo = gpu.canUndo();
			canRedo = gpu.canRedo();
		}

		function syncZoom() {
			zoom = view.zoom;
		}

		function runUndo() {
			if (!gpu || drawing || strokeActive) return;
			gpu.undo();
			present();
			syncHistoryFlags();
		}

		function runRedo() {
			if (!gpu || drawing || strokeActive) return;
			gpu.redo();
			present();
			syncHistoryFlags();
		}

		function endStroke() {
			if (!strokeActive || !gpu) return;
			gpu.endStroke(opacity);
			strokeActive = false;
			present();
			syncHistoryFlags();
		}

		function cancelStroke() {
			if (!strokeActive || !gpu) return;
			gpu.cancelStroke();
			strokeActive = false;
			drawing = false;
			present();
		}

		/** End or discard the current stroke when a 2nd/3rd finger lands. */
		function resolveStrokeForMultiTouch(): boolean {
			if (!drawing && !strokeActive) return false;
			const nascent =
				performance.now() - strokeStartedAt < CHORD_MS && strokeTravelPx < CHORD_MOVE_PX;
			if (nascent) cancelStroke();
			else {
				endStroke();
				drawing = false;
			}
			return !nascent;
		}

		/** Zoom so the full document fits in the viewport (centered). */
		function fitDocumentToScreen() {
			if (!gpu || cssW < 1 || cssH < 1) return;
			const MIN_Z = 0.05;
			const MAX_Z = 20;
			const margin = 0.92;
			const nextZoom = Math.min(cssW / gpu.docW, cssH / gpu.docH) * margin;
			view.zoom = Math.min(MAX_Z, Math.max(MIN_Z, nextZoom));
			view.x = 0;
			view.y = 0;
			view.rotation = 0;
			syncZoom();
		}

		function resize() {
			cssW = surface.clientWidth;
			cssH = surface.clientHeight;
			gpu?.resize(cssW, cssH);
			if (gpu && !fittedOnce && cssW > 0 && cssH > 0) {
				fitDocumentToScreen();
				fittedOnce = true;
			}
			present();
		}

		function samplePressures(e: PointerEvent) {
			if (!pressureSize && !pressureOpacity) {
				return { sizeP: 1, opacP: 1 };
			}
			const raw = getStrokePressure(e, penState);
			return {
				sizeP: pressureSize ? mapPressureCurveForSize(raw, penState) : 1,
				opacP: pressureOpacity ? mapPressureCurveForOpacity(raw) : 1
			};
		}

		function queuePaintAt(sx: number, sy: number, sizeP: number, opacP: number) {
			if (!gpu) return;
			const p = screenToDoc(sx, sy);
			gpu.addSample(p.x, p.y, size * 2, sizeP, opacP, color, spacing);
		}

		function paintPointerSamples(e: PointerEvent) {
			if (!gpu) return;
			if (!penState.hasPressure && eventLooksLikeRealPressure(e)) {
				penState.hasPressure = true;
			}

			const samples =
				typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [];
			const events = samples.length > 0 ? samples : [e];

			// Queue all coalesced samples first, then one GPU flush + present.
			// Flushing/presenting per sample was thrashing low-power mobile GPUs.
			for (const ce of events) {
				if (lastPaintScreen) {
					const step = Math.hypot(ce.clientX - lastPaintScreen.x, ce.clientY - lastPaintScreen.y);
					addStrokeDistance(penState, step);
					strokeTravelPx += step;
				}
				const { sizeP, opacP } = samplePressures(ce);
				lastPaintScreen = { x: ce.clientX, y: ce.clientY };
				queuePaintAt(ce.clientX, ce.clientY, sizeP, opacP);
			}
			gpu.flushStamps(color);
			present();
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
				const committedStroke = resolveStrokeForMultiTouch();

				if (touchCount() >= 2) {
					beginOrUpdateMultiTap(committedStroke);
					if (touchCount() === 2) {
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
					} else {
						// 3+ fingers: tap candidate for redo, not a pinch.
						pinch = null;
					}
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
				const { sizeP, opacP } = samplePressures(e);
				lastPaintScreen = { x: e.clientX, y: e.clientY };
				queuePaintAt(e.clientX, e.clientY, sizeP, opacP);
				gpu?.flushStamps(color);
				present();
			}
		}

		function onPointerMove(e: PointerEvent) {
			if (e.pointerType === 'touch' && touches[e.pointerId]) {
				touches[e.pointerId] = { x: e.clientX, y: e.clientY };
				updateMultiTapMoved();
				if (touchCount() === 2 && pinch && multiTap?.moved) {
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
					syncZoom();
					view.rotation = pinch.startRotation + (angle - pinch.startAngle);
					placeDocAtScreen(pinch.docPoint, midX, midY);
					present();
					return;
				}
				if (touchCount() >= 2) return;
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
			if (touchCount() === 0) finishMultiTap();

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
				undoFn = runUndo;
				redoFn = runRedo;
				historyApi = { undo: runUndo, redo: runRedo };
				syncHistoryFlags();
				ro.observe(surface);
				resize();
			} catch (err) {
				if (cancelled) return;
				gpuError = err instanceof Error ? err.message : 'WebGPU failed to initialize';
			}
		})();

		return () => {
			cancelled = true;
			undoFn = null;
			redoFn = null;
			historyApi = null;
			canUndo = false;
			canRedo = false;
			zoom = 1;
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

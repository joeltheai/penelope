<script lang="ts">
	import {
		createGpuPaint,
		sanitizeDocSize,
		MIN_DOC_SIZE,
		MAX_DOC_SIZE,
		type BrushKind,
		type GpuPaint
	} from '$lib/gpuPaint';
	import { untrack } from 'svelte';
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
	type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move';

	let {
		color = $bindable('#1a6cff'),
		size = $bindable(8),
		opacity = $bindable(1),
		spacing = $bindable(0.005),
		brush = $bindable('pen' as BrushKind),
		pressureSize = $bindable(false),
		pressureOpacity = $bindable(true),
		canUndo = $bindable(false),
		canRedo = $bindable(false),
		historyApi = $bindable(null as null | HistoryApi),
		docW = $bindable(2000),
		docH = $bindable(2000),
		zoom = $bindable(1),
		eyedropper = $bindable(false),
		resizeMode = $bindable(false)
	}: {
		color?: string;
		size?: number;
		opacity?: number;
		spacing?: number;
		brush?: BrushKind;
		pressureSize?: boolean;
		pressureOpacity?: boolean;
		canUndo?: boolean;
		canRedo?: boolean;
		historyApi?: null | HistoryApi;
		docW?: number;
		docH?: number;
		zoom?: number;
		eyedropper?: boolean;
		resizeMode?: boolean;
	} = $props();

	let canvasEl: HTMLCanvasElement | undefined = $state();
	let gpuError = $state<string | null>(null);

	let space = false;
	let alt = false;
	let rotateKey = false;

	let undoFn: (() => void) | null = null;
	let redoFn: (() => void) | null = null;

	/** Live refs for eyedropper loupe (wired from the GPU effect). */
	let gpuRef: GpuPaint | null = null;
	let screenToDocRef: ((sx: number, sy: number) => { x: number; y: number }) | null = null;

	/** Camera mirrors for resize overlay (rotation is forced to 0 in resize mode). */
	let camX = $state(0);
	let camY = $state(0);
	let surfaceW = $state(0);
	let surfaceH = $state(0);

	/** New canvas frame in current document space. */
	let cropX = $state(0);
	let cropY = $state(0);
	let cropW = $state(2000);
	let cropH = $state(2000);

	let resizeDrag: {
		handle: ResizeHandle;
		startDocX: number;
		startDocY: number;
		origX: number;
		origY: number;
		origW: number;
		origH: number;
	} | null = $state(null);

	let enterResizeImpl: (() => void) | null = null;
	let applyResizeImpl: (() => void) | null = null;
	let resizeZoomImpl: ((sx: number, sy: number, factor: number) => void) | null = null;
	let resizePanImpl: ((dx: number, dy: number) => void) | null = null;

	let resizePanCam: { lastX: number; lastY: number } | null = $state(null);

	const HANDLE_PX = 14;

	const cropScreen = $derived.by(() => {
		const z = Math.max(zoom, 1e-6);
		const left = surfaceW * 0.5 + camX + (cropX - docW * 0.5) * z;
		const top = surfaceH * 0.5 + camY + (cropY - docH * 0.5) * z;
		return { left, top, width: cropW * z, height: cropH * z };
	});

	const cropLabel = $derived(`${Math.round(cropW)} × ${Math.round(cropH)}`);

	function screenToDocCam(sx: number, sy: number) {
		const z = Math.max(zoom, 1e-6);
		const x = (sx - surfaceW * 0.5 - camX) / z + docW * 0.5;
		const y = (sy - surfaceH * 0.5 - camY) / z + docH * 0.5;
		return { x, y };
	}

	function hitResizeHandle(sx: number, sy: number): ResizeHandle | null {
		const { left, top, width, height } = cropScreen;
		const right = left + width;
		const bottom = top + height;
		const hs = HANDLE_PX;
		const near = (a: number, b: number) => Math.abs(a - b) <= hs;
		const inX = sx >= left - hs && sx <= right + hs;
		const inY = sy >= top - hs && sy <= bottom + hs;
		if (!inX || !inY) return null;

		const onL = near(sx, left);
		const onR = near(sx, right);
		const onT = near(sy, top);
		const onB = near(sy, bottom);
		if (onT && onL) return 'nw';
		if (onT && onR) return 'ne';
		if (onB && onL) return 'sw';
		if (onB && onR) return 'se';
		if (onT && sx >= left && sx <= right) return 'n';
		if (onB && sx >= left && sx <= right) return 's';
		if (onL && sy >= top && sy <= bottom) return 'w';
		if (onR && sy >= top && sy <= bottom) return 'e';
		if (sx >= left && sx <= right && sy >= top && sy <= bottom) return 'move';
		return null;
	}

	function cursorForHandle(h: ResizeHandle | null) {
		switch (h) {
			case 'n':
			case 's':
				return 'ns-resize';
			case 'e':
			case 'w':
				return 'ew-resize';
			case 'ne':
			case 'sw':
				return 'nesw-resize';
			case 'nw':
			case 'se':
				return 'nwse-resize';
			case 'move':
				return 'move';
			default:
				return 'default';
		}
	}

	function applyHandleDelta(
		handle: ResizeHandle,
		docX: number,
		docY: number,
		start: NonNullable<typeof resizeDrag>
	) {
		const dx = docX - start.startDocX;
		const dy = docY - start.startDocY;

		if (handle === 'move') {
			cropX = Math.round(start.origX + dx);
			cropY = Math.round(start.origY + dy);
			return;
		}

		let left = start.origX;
		let right = start.origX + start.origW;
		let top = start.origY;
		let bottom = start.origY + start.origH;

		if (handle.includes('w')) left = start.origX + dx;
		if (handle.includes('e')) right = start.origX + start.origW + dx;
		if (handle.includes('n')) top = start.origY + dy;
		if (handle.includes('s')) bottom = start.origY + start.origH + dy;

		if (left > right) {
			const t = left;
			left = right;
			right = t;
		}
		if (top > bottom) {
			const t = top;
			top = bottom;
			bottom = t;
		}

		let w = right - left;
		let h = bottom - top;

		if (w < MIN_DOC_SIZE) {
			if (handle.includes('w') && !handle.includes('e')) left = right - MIN_DOC_SIZE;
			else right = left + MIN_DOC_SIZE;
			w = MIN_DOC_SIZE;
		} else if (w > MAX_DOC_SIZE) {
			if (handle.includes('w') && !handle.includes('e')) left = right - MAX_DOC_SIZE;
			else right = left + MAX_DOC_SIZE;
			w = MAX_DOC_SIZE;
		}

		if (h < MIN_DOC_SIZE) {
			if (handle.includes('n') && !handle.includes('s')) top = bottom - MIN_DOC_SIZE;
			else bottom = top + MIN_DOC_SIZE;
			h = MIN_DOC_SIZE;
		} else if (h > MAX_DOC_SIZE) {
			if (handle.includes('n') && !handle.includes('s')) top = bottom - MAX_DOC_SIZE;
			else bottom = top + MAX_DOC_SIZE;
			h = MAX_DOC_SIZE;
		}

		cropX = Math.round(left);
		cropY = Math.round(top);
		cropW = Math.round(w);
		cropH = Math.round(h);
	}

	function onResizePointerDown(e: PointerEvent) {
		if (e.button !== 0 && e.pointerType === 'mouse') return;
		e.preventDefault();
		const el = e.currentTarget as HTMLElement;
		el.setPointerCapture(e.pointerId);

		if (space || e.button === 1) {
			resizePanCam = { lastX: e.clientX, lastY: e.clientY };
			return;
		}

		const handle = hitResizeHandle(e.clientX, e.clientY);
		if (!handle) return;
		const p = screenToDocCam(e.clientX, e.clientY);
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
			resizePanImpl?.(e.clientX - resizePanCam.lastX, e.clientY - resizePanCam.lastY);
			resizePanCam = { lastX: e.clientX, lastY: e.clientY };
			return;
		}
		if (resizeDrag && el.hasPointerCapture(e.pointerId)) {
			const p = screenToDocCam(e.clientX, e.clientY);
			applyHandleDelta(resizeDrag.handle, p.x, p.y, resizeDrag);
			return;
		}
		el.style.cursor = space
			? 'grab'
			: cursorForHandle(hitResizeHandle(e.clientX, e.clientY));
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
		resizeZoomImpl?.(e.clientX, e.clientY, factor);
	}

	function cancelResizeMode() {
		resizeMode = false;
		resizeDrag = null;
		resizePanCam = null;
	}

	function applyResizeMode() {
		applyResizeImpl?.();
	}

	$effect(() => {
		if (!resizeMode) return;
		enterResizeImpl?.();
	});

	const LOUPE_RADIUS = 11;
	const LOUPE_SIZE = 118;
	const LOUPE_OFFSET_Y = 72;

	let loupeActive = $state(false);
	let loupeX = $state(0);
	let loupeY = $state(0);
	let loupeHex = $state('#000000');
	let loupeCanvasEl: HTMLCanvasElement | undefined = $state();
	let loupeBusy = false;
	let loupePending: { sx: number; sy: number } | null = null;

	async function updateLoupe(sx: number, sy: number) {
		if (!gpuRef || !screenToDocRef) return;
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

				const p = screenToDocRef(sx, sy);
				const patch = await gpuRef.samplePatch(p.x, p.y, LOUPE_RADIUS);
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
		eyedropper = false;
	}

	function isEditableTarget(target: EventTarget | null) {
		if (!(target instanceof HTMLElement)) return false;
		const tag = target.tagName;
		if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
		return target.isContentEditable;
	}

	function onKeyDown(e: KeyboardEvent) {
		if (e.code === 'Escape' && resizeMode) {
			cancelResizeMode();
			return;
		}
		if (e.code === 'Escape' && eyedropper) {
			eyedropper = false;
			loupeActive = false;
			return;
		}
		if (e.code === 'Enter' && resizeMode) {
			e.preventDefault();
			applyResizeMode();
			return;
		}
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
		/** Last dab site for Krita-style timed airbrush while stationary. */
		let lastAirbrush: {
			x: number;
			y: number;
			sizeP: number;
			opacP: number;
		} | null = null;
		let airbrushTimer: ReturnType<typeof setInterval> | null = null;
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

		let presentRaf = 0;

		function schedulePresent() {
			if (presentRaf) return;
			presentRaf = requestAnimationFrame(() => {
				presentRaf = 0;
				syncZoom();
				present();
			});
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
			schedulePresent();
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

		function stopAirbrushTimer() {
			if (airbrushTimer !== null) {
				clearInterval(airbrushTimer);
				airbrushTimer = null;
			}
		}

		function startAirbrushTimer() {
			stopAirbrushTimer();
			if (brush !== 'airbrush') return;
			// Krita airbrush rate ≈ dabs/sec while held still.
			airbrushTimer = setInterval(() => {
				if (!drawing || !strokeActive || !gpu || !lastAirbrush) return;
				gpu.addSample(
					lastAirbrush.x,
					lastAirbrush.y,
					size * 2,
					lastAirbrush.sizeP,
					lastAirbrush.opacP,
					color,
					spacing
				);
				gpu.flushStamps(color);
				present();
			}, 33);
		}

		function beginStroke() {
			gpu?.setBrush(brush);
			gpu?.beginStroke();
			strokeActive = true;
			strokeStartedAt = performance.now();
			strokeTravelPx = 0;
			lastAirbrush = null;
			startAirbrushTimer();
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
			camX = view.x;
			camY = view.y;
			surfaceW = cssW;
			surfaceH = cssH;
		}

		function runUndo() {
			if (resizeMode || !gpu || drawing || strokeActive) return;
			gpu.undo();
			present();
			syncHistoryFlags();
		}

		function runRedo() {
			if (resizeMode || !gpu || drawing || strokeActive) return;
			gpu.redo();
			present();
			syncHistoryFlags();
		}

		function beginResizeMode() {
			if (!gpu) return;
			if (drawing || strokeActive) {
				cancelStroke();
				drawing = false;
			}
			eyedropper = false;
			loupeActive = false;
			view.rotation = 0;
			cropX = 0;
			cropY = 0;
			cropW = gpu.docW;
			cropH = gpu.docH;
			fitDocumentToScreen();
			present();
		}

		async function commitResizeMode() {
			if (!gpu || drawing || strokeActive) return;
			const nextW = sanitizeDocSize(cropW);
			const nextH = sanitizeDocSize(cropH);
			const changed = await gpu.resizeDocument(nextW, nextH, {
				cropX: Math.round(cropX),
				cropY: Math.round(cropY)
			});
			if (!gpu) return;
			docW = gpu.docW;
			docH = gpu.docH;
			resizeMode = false;
			resizeDrag = null;
			if (changed) {
				fitDocumentToScreen();
			}
			present();
			syncHistoryFlags();
		}

		enterResizeImpl = beginResizeMode;
		applyResizeImpl = commitResizeMode;
		resizeZoomImpl = (sx, sy, factor) => {
			setViewAroundPivot(sx, sy, view.zoom * factor, 0);
		};
		resizePanImpl = (dx, dy) => {
			view.x += dx;
			view.y += dy;
			syncZoom();
			schedulePresent();
		};

		function endStroke() {
			if (!strokeActive || !gpu) return;
			stopAirbrushTimer();
			gpu.endStroke(opacity);
			strokeActive = false;
			lastAirbrush = null;
			present();
			syncHistoryFlags();
		}

		function cancelStroke() {
			if (!strokeActive || !gpu) return;
			stopAirbrushTimer();
			gpu.cancelStroke();
			strokeActive = false;
			drawing = false;
			lastAirbrush = null;
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
			if (brush === 'airbrush') {
				lastAirbrush = { x: p.x, y: p.y, sizeP, opacP };
			}
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
			if (resizeMode) return;
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
					view.rotation = pinch.startRotation + (angle - pinch.startAngle);
					placeDocAtScreen(pinch.docPoint, midX, midY);
					schedulePresent();
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
				schedulePresent();
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
			// Continuous zoom from trackpad/mouse delta (not stepped 1.1/0.9).
			let dy = e.deltaY;
			if (e.deltaMode === 1) dy *= 16;
			else if (e.deltaMode === 2) dy *= cssH || 800;
			const factor = Math.max(0.01, 1 - dy * 0.001);
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
				const initial = untrack(() => ({ width: docW, height: docH }));
				const painter = await createGpuPaint(surface, initial);
				if (cancelled) {
					painter.destroy();
					return;
				}
				gpu = painter;
				gpuRef = painter;
				screenToDocRef = screenToDoc;
				docW = painter.docW;
				docH = painter.docH;
				gpu.setBrush(untrack(() => brush));
				gpuError = null;
				undoFn = runUndo;
				redoFn = runRedo;
				historyApi = { undo: runUndo, redo: runRedo };
				syncHistoryFlags();
				ro.observe(surface);
				resize();
				if (untrack(() => resizeMode)) beginResizeMode();
			} catch (err) {
				if (cancelled) return;
				gpuError = err instanceof Error ? err.message : 'WebGPU failed to initialize';
			}
		})();

		return () => {
			cancelled = true;
			stopAirbrushTimer();
			if (presentRaf) cancelAnimationFrame(presentRaf);
			undoFn = null;
			redoFn = null;
			historyApi = null;
			enterResizeImpl = null;
			applyResizeImpl = null;
			resizeZoomImpl = null;
			resizePanImpl = null;
			canUndo = false;
			canRedo = false;
			zoom = 1;
			ro.disconnect();
			gpu?.destroy();
			gpu = null;
			gpuRef = null;
			screenToDocRef = null;
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

{#if resizeMode}
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
				onclick={cancelResizeMode}
			>
				Cancel
			</button>
			<button
				type="button"
				class="rounded-md bg-[#3a3a42] px-3 py-1.5 text-sm text-white transition hover:bg-[#4a4a52]"
				onclick={applyResizeMode}
			>
				Apply
			</button>
		</div>
	</div>
{/if}

{#if eyedropper}
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
{/if}

{#if gpuError}
	<div class="pointer-events-none fixed inset-0 z-20 flex items-center justify-center p-6 text-center">
		<p class="max-w-md rounded-lg bg-black/70 px-4 py-3 text-sm text-white">
			{gpuError}
		</p>
	</div>
{/if}

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

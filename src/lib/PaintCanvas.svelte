<script lang="ts">
	import {
		DEFAULT_BRUSH_SETTINGS,
		createGpuPaint,
		sanitizeDocSize,
		type BrushKind,
		type BrushSettings,
		type EditApi,
		type GpuPaint,
		type LassoOptions
	} from '$lib/gpuPaint';
	import {
		fitDocumentZoom,
		placeDocAtScreen as placeDocAtScreenCam,
		screenToDoc as screenToDocCamMath,
		setViewAroundPivot as setViewAroundPivotCam
	} from '$lib/canvasCamera';
	import EyedropperLoupe from '$lib/EyedropperLoupe.svelte';
	import ResizeCanvasOverlay from '$lib/ResizeCanvasOverlay.svelte';
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

	let {
		color = $bindable('#1a6cff'),
		brushSettings = $bindable({ ...DEFAULT_BRUSH_SETTINGS }),
		brush = $bindable('pen' as BrushKind),
		lassoOptions = $bindable({
			mode: 'fill',
			splat: false
		} as LassoOptions),
		canUndo = $bindable(false),
		canRedo = $bindable(false),
		editApi = $bindable(null as null | EditApi),
		docW = $bindable(2000),
		docH = $bindable(2000),
		zoom = $bindable(1),
		eyedropper = $bindable(false),
		resizeMode = $bindable(false),
		mirrorView = $bindable(false)
	}: {
		color?: string;
		brushSettings?: BrushSettings;
		brush?: BrushKind;
		lassoOptions?: LassoOptions;
		canUndo?: boolean;
		canRedo?: boolean;
		editApi?: null | EditApi;
		docW?: number;
		docH?: number;
		zoom?: number;
		eyedropper?: boolean;
		resizeMode?: boolean;
		mirrorView?: boolean;
	} = $props();

	let canvasEl: HTMLCanvasElement | undefined = $state();
	let gpuError = $state<string | null>(null);

	let space = $state(false);
	let alt = false;
	let rotateKey = false;

	let undoFn: (() => void) | null = null;
	let redoFn: (() => void) | null = null;

	let gpuRef: GpuPaint | null = null;
	let screenToDocRef: ((sx: number, sy: number) => { x: number; y: number }) | null = null;

	let camX = $state(0);
	let camY = $state(0);
	let surfaceW = $state(0);
	let surfaceH = $state(0);

	let cropX = $state(0);
	let cropY = $state(0);
	let cropW = $state(2000);
	let cropH = $state(2000);

	let docPixels: Uint8Array | null = null;
	let docPixelsRequest: Promise<Uint8Array | null> | null = null;

	let enterResizeImpl: (() => void) | null = null;
	let applyResizeImpl: (() => void) | null = null;
	let resizeZoomImpl: ((sx: number, sy: number, factor: number) => void) | null = null;
	let resizePanImpl: ((dx: number, dy: number) => void) | null = null;
	let presentImpl: (() => void) | null = null;

	function invalidateDocPixels() {
		docPixels = null;
		docPixelsRequest = null;
	}

	function ensureDocPixels() {
		if (docPixels) return Promise.resolve(docPixels);
		if (!docPixelsRequest) {
			const gpu = gpuRef;
			if (!gpu) return Promise.resolve(null);
			docPixelsRequest = gpu.readDocument().then((pixels) => {
				if (pixels) docPixels = pixels;
				docPixelsRequest = null;
				return pixels;
			});
		}
		return docPixelsRequest;
	}

	async function sampleLoupe(sx: number, sy: number) {
		if (!gpuRef || !screenToDocRef) return null;
		const gpu = gpuRef;
		const p = screenToDocRef(sx, sy);
		const pixels = await ensureDocPixels();
		if (!pixels || !gpuRef) return null;

		const radius = 11;
		const full = radius * 2 + 1;
		const cx = Math.floor(p.x);
		const cy = Math.floor(p.y);
		const out = new Uint8ClampedArray(full * full * 4);
		out.fill(255);
		for (let row = 0; row < full; row++) {
			const dy = cy - radius + row;
			if (dy < 0 || dy >= gpu.docH) continue;
			for (let col = 0; col < full; col++) {
				const dx = cx - radius + col;
				if (dx < 0 || dx >= gpu.docW) continue;
				const src = (dy * gpu.docW + dx) * 4;
				const dst = (row * full + col) * 4;
				out[dst] = pixels[src]!;
				out[dst + 1] = pixels[src + 1]!;
				out[dst + 2] = pixels[src + 2]!;
				out[dst + 3] = 255;
			}
		}
		const i = (radius * full + radius) * 4;
		const hex = `#${[out[i], out[i + 1], out[i + 2]]
			.map((n) => n!.toString(16).padStart(2, '0'))
			.join('')}`;
		return { width: full, height: full, pixels: out, hex };
	}

	function cancelResizeMode() {
		resizeMode = false;
	}

	function applyResizeMode() {
		applyResizeImpl?.();
	}

	$effect(() => {
		if (!resizeMode) return;
		enterResizeImpl?.();
	});

	$effect(() => {
		void mirrorView;
		presentImpl?.();
	});

	$effect(() => {
		const next = { ...brushSettings };
		untrack(() => gpuRef?.setBrushSettings(next));
	});

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
		if (e.code === 'KeyM' && !e.metaKey && !e.ctrlKey && !e.altKey && !isEditableTarget(e.target)) {
			e.preventDefault();
			if (!resizeMode) mirrorView = !mirrorView;
			return;
		}

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

	function isBrushTool(tool: BrushKind) {
		return tool === 'pen' || tool === 'airbrush';
	}

	$effect(() => {
		if (!canvasEl) return;
		const surface = canvasEl;

		let cancelled = false;
		let gpu: GpuPaint | null = null;

		const view = { x: 0, y: 0, zoom: 1, rotation: 0, flipX: 1 };
		let cssW = 0;
		let cssH = 0;
		let fittedOnce = false;
		let mirrorApplied = untrack(() => mirrorView);

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
		let lastAirbrush: {
			x: number;
			y: number;
			sizeP: number;
			opacP: number;
		} | null = null;
		let airbrushTimer: ReturnType<typeof setInterval> | null = null;
		let strokeStartedAt = 0;
		let strokeTravelPx = 0;

		let smoothPoint: { x: number; y: number } | null = null;
		let lastDocPoint: { x: number; y: number } | null = null;

		const touches: Record<number, { x: number; y: number }> = {};
		let pinch: {
			docPoint: { x: number; y: number };
			startDist: number;
			startAngle: number;
			startZoom: number;
			startRotation: number;
		} | null = null;

		const TAP_SLOP_PX = 14;
		const TAP_MAX_MS = 400;
		const CHORD_MS = 200;
		const CHORD_MOVE_PX = 24;
		let multiTap: {
			startTime: number;
			maxFingers: number;
			origins: Record<number, { x: number; y: number }>;
			moved: boolean;
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
			const midX = (a!.x + b!.x) / 2;
			const midY = (a!.y + b!.y) / 2;
			pinch = {
				docPoint: screenToDoc(midX, midY),
				startDist: Math.hypot(a!.x - b!.x, a!.y - b!.y),
				startAngle: Math.atan2(b!.y - a!.y, b!.x - a!.x),
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
				const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
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

		function viewFlipX() {
			return mirrorView ? -1 : 1;
		}

		function screenToDoc(sx: number, sy: number) {
			if (!gpu) return { x: 0, y: 0 };
			view.flipX = viewFlipX();
			return screenToDocCamMath(sx, sy, view, cssW, cssH, gpu.docW, gpu.docH);
		}

		function present() {
			view.flipX = viewFlipX();
			gpu?.present(view, cssW, cssH, brushSettings.opacity, strokeActive);
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

		function setViewAroundPivot(pivotX: number, pivotY: number, newZoom: number, newRotation: number) {
			if (!gpu) return;
			view.flipX = viewFlipX();
			setViewAroundPivotCam(view, pivotX, pivotY, newZoom, newRotation, cssW, cssH, gpu.docW, gpu.docH);
			schedulePresent();
		}

		function placeDocAtScreen(docPoint: { x: number; y: number }, screenX: number, screenY: number) {
			if (!gpu) return;
			view.flipX = viewFlipX();
			placeDocAtScreenCam(view, docPoint, screenX, screenY, cssW, cssH, gpu.docW, gpu.docH);
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
			airbrushTimer = setInterval(() => {
				if (!drawing || !strokeActive || !gpu || !lastAirbrush) return;
				gpu.addTimedAirbrushDab(
					lastAirbrush.x,
					lastAirbrush.y,
					lastAirbrush.sizeP,
					lastAirbrush.opacP,
					color
				);
				schedulePresent();
			}, 33);
		}

		function beginStroke() {
			gpu?.setTool(brush);
			gpu?.setLassoOptions(lassoOptions);
			gpu?.setBrushSettings({ ...brushSettings });
			gpu?.beginStroke();
			strokeActive = true;
			strokeStartedAt = performance.now();
			strokeTravelPx = 0;
			lastAirbrush = null;
			lastDocPoint = null;
			smoothPoint = null;
			startAirbrushTimer();
		}

		function syncZoom() {
			if (zoom !== view.zoom) zoom = view.zoom;
			if (resizeMode) {
				camX = view.x;
				camY = view.y;
				surfaceW = cssW;
				surfaceH = cssH;
			}
		}

		function syncUndoFlags() {
			if (!gpu) {
				canUndo = false;
				canRedo = false;
				return;
			}
			canUndo = gpu.canUndo();
			canRedo = gpu.canRedo();
		}

		function runUndo() {
			if (!gpu || drawing || strokeActive || resizeMode) return;
			if (!gpu.undo()) return;
			invalidateDocPixels();
			syncUndoFlags();
			present();
		}

		function runRedo() {
			if (!gpu || drawing || strokeActive || resizeMode) return;
			if (!gpu.redo()) return;
			invalidateDocPixels();
			syncUndoFlags();
			present();
		}

		function beginResizeMode() {
			if (!gpu) return;
			if (drawing || strokeActive) {
				cancelStroke();
				drawing = false;
			}
			eyedropper = false;
			mirrorView = false;
			view.rotation = 0;
			view.flipX = 1;
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
			if (changed) {
				invalidateDocPixels();
				syncUndoFlags();
				fitDocumentToScreen();
			}
			present();
		}

		enterResizeImpl = beginResizeMode;
		applyResizeImpl = commitResizeMode;
		presentImpl = () => {
			const next = mirrorView;
			if (next !== mirrorApplied) {
				view.x = -view.x;
				mirrorApplied = next;
				syncZoom();
			}
			schedulePresent();
		};
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
			gpu.endStroke(brushSettings.opacity);
			strokeActive = false;
			lastAirbrush = null;
			lastDocPoint = null;
			smoothPoint = null;
			invalidateDocPixels();
			syncUndoFlags();
			schedulePresent();
		}

		function cancelStroke() {
			if (!strokeActive || !gpu) return;
			stopAirbrushTimer();
			gpu.cancelStroke();
			strokeActive = false;
			drawing = false;
			lastAirbrush = null;
			lastDocPoint = null;
			smoothPoint = null;
			present();
		}

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

		function fitDocumentToScreen() {
			if (!gpu || cssW < 1 || cssH < 1) return;
			view.zoom = fitDocumentZoom(cssW, cssH, gpu.docW, gpu.docH);
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
			if (!brushSettings.pressureSize && !brushSettings.pressureOpacity) {
				return { sizeP: 1, opacP: 1 };
			}
			const raw = getStrokePressure(e, penState);
			return {
				sizeP: brushSettings.pressureSize ? mapPressureCurveForSize(raw, penState) : 1,
				opacP: brushSettings.pressureOpacity ? mapPressureCurveForOpacity(raw) : 1
			};
		}

		function stabilizedDocPoint(x: number, y: number) {
			const strength = isBrushTool(brush) ? brushSettings.smoothing : 0;
			if (!smoothPoint || strength <= 0.001) {
				smoothPoint = { x, y };
				lastDocPoint = { x, y };
				return smoothPoint;
			}
			const dx = x - smoothPoint.x;
			const dy = y - smoothPoint.y;
			const dist = Math.hypot(dx, dy);
			if (dist < 1e-4) {
				lastDocPoint = { x, y };
				return smoothPoint;
			}
			// Screen-space stabilizer: keep the trail lag consistent at any zoom level.
			const zoom = Math.max(0.05, view.zoom);
			const radius = (4 + strength * 64) / zoom;
			const alpha = dist / (dist + radius);
			smoothPoint.x += dx * alpha;
			smoothPoint.y += dy * alpha;
			lastDocPoint = { x, y };
			return smoothPoint;
		}

		function paintPointerSamples(e: PointerEvent) {
			if (!gpu) return;
			if (!penState.hasPressure && eventLooksLikeRealPressure(e)) {
				penState.hasPressure = true;
			}

			const coalesced = e.getCoalescedEvents?.() ?? [];
			const events = coalesced.length > 0 ? coalesced : [e];

			for (const ce of events) {
				if (lastPaintScreen) {
					const step = Math.hypot(ce.clientX - lastPaintScreen.x, ce.clientY - lastPaintScreen.y);
					addStrokeDistance(penState, step);
					strokeTravelPx += step;
				}
				const { sizeP, opacP } = samplePressures(ce);
				lastPaintScreen = { x: ce.clientX, y: ce.clientY };
				const raw = screenToDoc(ce.clientX, ce.clientY);
				const point = stabilizedDocPoint(raw.x, raw.y);
				lastAirbrush = { x: point.x, y: point.y, sizeP, opacP };
				gpu.addSample(point.x, point.y, sizeP, opacP, color, view.zoom);
			}
			// Pen/airbrush dabs are flushed by the next present() in the same command
			// encoder; other tools emit geometry as they sample.
			if (!isBrushTool(brush)) gpu.flushStamps(color);
			schedulePresent();
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
						const midX = (a!.x + b!.x) / 2;
						const midY = (a!.y + b!.y) / 2;
						pinch = {
							docPoint: screenToDoc(midX, midY),
							startDist: Math.hypot(a!.x - b!.x, a!.y - b!.y),
							startAngle: Math.atan2(b!.y - a!.y, b!.x - a!.x),
							startZoom: view.zoom,
							startRotation: view.rotation
						};
					} else {
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
				const raw = screenToDoc(e.clientX, e.clientY);
				const point = stabilizedDocPoint(raw.x, raw.y);
				lastAirbrush = { x: point.x, y: point.y, sizeP, opacP };
				gpu?.addSample(point.x, point.y, sizeP, opacP, color, view.zoom);
				if (!isBrushTool(brush)) gpu?.flushStamps(color);
				schedulePresent();
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
					const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
					const angle = Math.atan2(b!.y - a!.y, b!.x - a!.x);
					const midX = (a!.x + b!.x) / 2;
					const midY = (a!.y + b!.y) / 2;

					view.zoom = Math.min(
						MAX_Z,
						Math.max(MIN_Z, pinch.startZoom * (dist / Math.max(pinch.startDist, 1e-6)))
					);
					view.rotation =
						pinch.startRotation + (angle - pinch.startAngle) * viewFlipX();
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
						setViewAroundPivot(
							rotatePivot.x,
							rotatePivot.y,
							view.zoom,
							view.rotation + dAng * viewFlipX()
						);
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

			if (drawing && e.buttons !== 0) {
				paintPointerSamples(e);
			}
		}

		function onPointerUp(e: PointerEvent) {
			delete touches[e.pointerId];
			if (touchCount() < 2) pinch = null;
			if (touchCount() === 0) finishMultiTap();

			if (drawing && strokeActive && isBrushTool(brush) && lastDocPoint) {
				const trailing = smoothPoint;
				if (
					trailing &&
					brushSettings.smoothing > 0.001 &&
					Math.hypot(lastDocPoint.x - trailing.x, lastDocPoint.y - trailing.y) > 0.75
				) {
					gpu?.addSample(
						lastDocPoint.x,
						lastDocPoint.y,
						1,
						samplePressures(e).opacP,
						color,
						view.zoom
					);
				}
			}

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
				const painter = await createGpuPaint(surface, {
					width: initial.width,
					height: initial.height
				});
				if (cancelled) {
					painter.destroy();
					return;
				}
				gpu = painter;
				gpuRef = painter;
				screenToDocRef = screenToDoc;
				docW = painter.docW;
				docH = painter.docH;
				gpu.setTool(untrack(() => brush));
				gpu.setLassoOptions(untrack(() => lassoOptions));
				gpu.setBrushSettings(untrack(() => ({ ...brushSettings })));
				gpuError = null;
				undoFn = runUndo;
				redoFn = runRedo;
				editApi = { undo: runUndo, redo: runRedo };
				syncUndoFlags();
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
			editApi = null;
			enterResizeImpl = null;
			applyResizeImpl = null;
			presentImpl = null;
			resizeZoomImpl = null;
			resizePanImpl = null;
			canUndo = false;
			canRedo = false;
			zoom = 1;
			invalidateDocPixels();
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
	<ResizeCanvasOverlay
		bind:cropX
		bind:cropY
		bind:cropW
		bind:cropH
		{camX}
		{camY}
		{zoom}
		{surfaceW}
		{surfaceH}
		{docW}
		{docH}
		{space}
		onPan={(dx, dy) => resizePanImpl?.(dx, dy)}
		onZoom={(sx, sy, factor) => resizeZoomImpl?.(sx, sy, factor)}
		onCancel={cancelResizeMode}
		onApply={applyResizeMode}
	/>
{/if}

{#if eyedropper}
	<EyedropperLoupe bind:color bind:active={eyedropper} sample={sampleLoupe} />
{/if}

{#if gpuError}
	<div class="pointer-events-none fixed inset-0 z-20 flex items-center justify-center p-6 text-center">
		<p class="max-w-md rounded-lg bg-black/70 px-4 py-3 text-sm text-white">
			{gpuError}
		</p>
	</div>
{/if}

import tgpu, { d } from 'typegpu';
import {
	AIRBRUSH_FLOW,
	BRUSH_SIZE,
	DEFAULT_DOC_W,
	DEFAULT_DOC_H,
	FLOATS_PER_VERT,
	GRID_BG,
	HOT_PIXEL_BUDGET,
	MAX_HISTORY,
	MAX_PRESENT_DPR,
	MAX_STAMPS_PER_FLUSH,
	MAX_VERT_FLOATS,
	VERTS_PER_STAMP,
	sanitizeDocSize
} from './constants';
import {
	appendStamp,
	blendAverageOpacity,
	makeHardBrushPixels,
	parseColor,
	rasterizePolygonEvenOdd,
	spacingFor,
	webGpuUnavailableMessage
} from './cpu';
import {
	AirbrushUniforms,
	CompositeUniforms,
	PresentUniforms,
	StampVertex,
	StrokeUniforms
} from './schemas';
import { createPaintPipelines } from './pipelines';
import { createStrokeBoundsTracker } from './strokeBounds';
import type { BrushKind, GpuPaint, Rect, ViewState } from './types';

export async function createGpuPaint(
	canvas: HTMLCanvasElement,
	opts?: { width?: number; height?: number }
): Promise<GpuPaint> {
	if (!navigator.gpu) throw new Error(webGpuUnavailableMessage());

	let root: Awaited<ReturnType<typeof tgpu.init>>;
	try {
		root = await tgpu.init();
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (/not supported|compatible GPU|requestAdapter/i.test(msg)) {
			throw new Error(
				msg.includes('compatible')
					? 'No WebGPU adapter available (requestAdapter returned null)'
					: webGpuUnavailableMessage()
			);
		}
		throw err;
	}

	const format = navigator.gpu.getPreferredCanvasFormat();
	const context = root.configureContext({ canvas, format, alphaMode: 'opaque' });

	let docW = sanitizeDocSize(opts?.width ?? DEFAULT_DOC_W);
	let docH = sanitizeDocSize(opts?.height ?? DEFAULT_DOC_H);

	function createDocTexture(w: number, h: number) {
		return root.createTexture({ size: [w, h], format: 'rgba8unorm' }).$usage('sampled', 'render');
	}

	let docTex = createDocTexture(docW, docH);
	let strokeTex = createDocTexture(docW, docH);
	/** Ping-pong target for Krita Alpha Darken airbrush dabs (sample strokeTex, write here). */
	let strokeTexB = createDocTexture(docW, docH);
	const brushTex = root
		.createTexture({ size: [BRUSH_SIZE, BRUSH_SIZE], format: 'rgba8unorm' })
		.$usage('sampled');

	const hardTipPixels = makeHardBrushPixels(BRUSH_SIZE);
	brushTex.write(hardTipPixels);

	let docView = docTex.createView();
	let strokeView = strokeTex.createView();
	const brushView = brushTex.createView();
	let docRenderView = docTex.createView('render');
	let strokeRenderView = strokeTex.createView('render');
	let strokeRenderViewB = strokeTexB.createView('render');

	/** Filled via root.with(...) when (re)building pipelines after a doc resize. */
	const docViewSlot = tgpu.slot<typeof docView>();
	const strokeViewSlot = tgpu.slot<typeof strokeView>();

	const linearSamp = root.createSampler({ magFilter: 'linear', minFilter: 'linear' });

	const strokeUniforms = root.createUniform(StrokeUniforms, {
		resolution: [docW, docH],
		color: [0, 0, 0, 1]
	});
	const airbrushUniforms = root.createUniform(AirbrushUniforms, {
		resolution: [docW, docH],
		color: [0, 0, 0],
		flow: AIRBRUSH_FLOW,
		averageOpacity: 0
	});
	const compositeUniforms = root.createUniform(CompositeUniforms, { opacity: 1 });
	const presentUniforms = root.createUniform(PresentUniforms, {
		viewport: [1, 1],
		center: [0.5, 0.5],
		pan: [0, 0],
		zoom: 1,
		rotate: 0,
		flipX: 1,
		strokeOpacity: 1,
		strokeActive: 0,
		docSize: [docW, docH]
	});

	const stampLayout = tgpu.vertexLayout(d.disarrayOf(StampVertex));
	const vertexBuf = root
		.createBuffer(stampLayout.schemaForCount(MAX_STAMPS_PER_FLUSH * VERTS_PER_STAMP))
		.$usage('vertex');
	const vertexCpu = new Float32Array(MAX_VERT_FLOATS);

	const textureViews = { docView, strokeView };
	const pipelines = createPaintPipelines({
		root,
		format,
		stampLayout,
		vertexBuf: vertexBuf as any,
		strokeUniforms: strokeUniforms as any,
		airbrushUniforms: airbrushUniforms as any,
		compositeUniforms: compositeUniforms as any,
		presentUniforms: presentUniforms as any,
		brushView: brushView as any,
		linearSamp: linearSamp as any,
		docViewSlot,
		strokeViewSlot,
		views: textureViews
	});
	const strokeWashPipeline = pipelines.strokeWashPipeline;
	const rebuildDocSamplePipelines = () => {
		textureViews.docView = docView;
		textureViews.strokeView = strokeView;
		pipelines.rebuildDocSamplePipelines();
	};
	rebuildDocSamplePipelines();

	// White document background (Texture.clear is zero-fill only).
	docTex.write(new Uint8Array(docW * docH * 4).fill(255));
	strokeTex.clear();
	strokeTexB.clear();

	let stampCount = 0;
	let lastStamp: {
		x: number;
		y: number;
		sizePressure: number;
		opacityPressure: number;
	} | null = null;
	let lastColor = '#000000';
	let destroyed = false;
	let currentBrush: BrushKind = 'pen';
	/** Krita KisPainter::averageOpacity EMA for Alpha Darken. */
	let averageOpacity = 0;
	const lassoPoints: { x: number; y: number }[] = [];
	const LASSO_MIN_DIST = 2.5;

	type PatchTex = ReturnType<typeof createPatchTex>;
	/** One undoable stroke: dirty-rect before/after patches. */
	type StrokeEntry = { bounds: Rect; prev: PatchTex; after: PatchTex };

	const undoStack: StrokeEntry[] = [];
	const redoStack: StrokeEntry[] = [];
	const strokeBounds = createStrokeBoundsTracker();

	function createPatchTex(w: number, h: number) {
		return root
			.createTexture({ size: [w, h], format: 'rgba8unorm' })
			.$usage('sampled', 'render');
	}

	function blitRect(
		src: PatchTex | typeof docTex,
		dst: PatchTex | typeof docTex,
		srcOrigin: { x: number; y: number },
		dstOrigin: { x: number; y: number },
		size: { w: number; h: number }
	) {
		const encoder = root.device.createCommandEncoder();
		encoder.copyTextureToTexture(
			{ texture: root.unwrap(src), origin: [srcOrigin.x, srcOrigin.y, 0] },
			{ texture: root.unwrap(dst), origin: [dstOrigin.x, dstOrigin.y, 0] },
			[size.w, size.h, 1]
		);
		root.device.queue.submit([encoder.finish()]);
	}

	function capturePatch(bounds: Rect): PatchTex {
		const tex = createPatchTex(bounds.w, bounds.h);
		blitRect(docTex, tex, { x: bounds.x, y: bounds.y }, { x: 0, y: 0 }, bounds);
		return tex;
	}

	function applyPatch(bounds: Rect, patch: PatchTex) {
		blitRect(patch, docTex, { x: 0, y: 0 }, { x: bounds.x, y: bounds.y }, bounds);
	}

	function disposeEntry(entry: StrokeEntry) {
		entry.prev.destroy();
		entry.after.destroy();
	}

	function entryPixels(entry: StrokeEntry) {
		return entry.bounds.w * entry.bounds.h * 2;
	}

	function hotPixelsUsed() {
		let n = 0;
		for (const e of undoStack) n += entryPixels(e);
		for (const e of redoStack) n += entryPixels(e);
		return n;
	}

	function clearRedoStack() {
		while (redoStack.length > 0) {
			disposeEntry(redoStack.pop()!);
		}
	}

	function enforceHistoryBudget() {
		while (undoStack.length > MAX_HISTORY) {
			disposeEntry(undoStack.shift()!);
		}
		while (hotPixelsUsed() > HOT_PIXEL_BUDGET && undoStack.length > 0) {
			disposeEntry(undoStack.shift()!);
		}
	}

	function queueStamp(
		x: number,
		y: number,
		size: number,
		sizePressure: number,
		opacityPressure: number
	) {
		if (stampCount >= MAX_STAMPS_PER_FLUSH) return;
		const radius = size * 0.5 * Math.max(sizePressure, 0.05);
		strokeBounds.expand(x, y, radius);
		const offset = stampCount * VERTS_PER_STAMP * FLOATS_PER_VERT;
		appendStamp(vertexCpu, offset, x, y, size, sizePressure, opacityPressure);
		stampCount++;
	}

	function paintStampsToStroke(color: string) {
		if (destroyed || stampCount === 0) return;

		if (currentBrush === 'airbrush') {
			paintAirbrushStamps(color);
			return;
		}

		const floats = stampCount * VERTS_PER_STAMP * FLOATS_PER_VERT;
		vertexBuf.write(vertexCpu.buffer.slice(0, floats * 4));

		const [r, g, b] = parseColor(color);
		strokeUniforms.write({
			resolution: [docW, docH],
			color: [r, g, b, 1]
		});

		strokeWashPipeline
			.withColorAttachment({
				view: strokeRenderView,
				loadOp: 'load',
				storeOp: 'store'
			})
			.draw(stampCount * VERTS_PER_STAMP);
		stampCount = 0;
	}

	/** Sequential Krita Alpha Darken dabs (sample strokeTex → write B → blit back). */
	function paintAirbrushStamps(color: string) {
		const [r, g, b] = parseColor(color);
		const single = new Float32Array(VERTS_PER_STAMP * FLOATS_PER_VERT);

		for (let i = 0; i < stampCount; i++) {
			const base = i * VERTS_PER_STAMP * FLOATS_PER_VERT;
			const x = vertexCpu[base]!;
			const y = vertexCpu[base + 1]!;
			const size = vertexCpu[base + 4]!;
			const sizeP = vertexCpu[base + 5]!;
			const opacP = vertexCpu[base + 6]!;
			const radius = size * 0.5 * Math.max(sizeP, 0.05);
			const pad = Math.ceil(radius) + 2;
			const x0 = Math.max(0, Math.floor(x - pad));
			const y0 = Math.max(0, Math.floor(y - pad));
			const x1 = Math.min(docW, Math.ceil(x + pad));
			const y1 = Math.min(docH, Math.ceil(y + pad));
			const w = x1 - x0;
			const h = y1 - y0;
			if (w < 1 || h < 1) continue;

			// Preserve destination outside the dab (replace blend only covers the quad).
			blitRect(strokeTex, strokeTexB, { x: x0, y: y0 }, { x: x0, y: y0 }, { w, h });

			for (let k = 0; k < VERTS_PER_STAMP * FLOATS_PER_VERT; k++) {
				single[k] = vertexCpu[base + k]!;
			}
			vertexBuf.write(single.buffer.slice(0, single.byteLength));

			airbrushUniforms.write({
				resolution: [docW, docH],
				color: [r, g, b],
				flow: AIRBRUSH_FLOW,
				averageOpacity
			});

			pipelines.strokeAirbrushPipeline
				.withColorAttachment({
					view: strokeRenderViewB,
					loadOp: 'load',
					storeOp: 'store'
				})
				.draw(VERTS_PER_STAMP);

			blitRect(strokeTexB, strokeTex, { x: x0, y: y0 }, { x: x0, y: y0 }, { w, h });
			averageOpacity = blendAverageOpacity(opacP, averageOpacity);
		}
		stampCount = 0;
	}

	function fillLassoIntoStroke(color: string): boolean {
		if (lassoPoints.length < 3) return false;
		const bounds = strokeBounds.finalize(docW, docH);
		if (!bounds) return false;

		const [r, g, b] = parseColor(color);
		const pixels = rasterizePolygonEvenOdd(lassoPoints, bounds, r, g, b);
		const patch = createPatchTex(bounds.w, bounds.h);
		patch.write(pixels);
		blitRect(patch, strokeTex, { x: 0, y: 0 }, { x: bounds.x, y: bounds.y }, bounds);
		patch.destroy();
		return true;
	}

	function compositeStroke(opacity: number) {
		compositeUniforms.write({ opacity });
		pipelines.compositePipeline
			.withColorAttachment({
				view: docRenderView,
				loadOp: 'load',
				storeOp: 'store'
			})
			.draw(3);
	}

	async function readDocPixels(x0: number, y0: number, w: number, h: number): Promise<Uint8Array | null> {
		if (destroyed || w < 1 || h < 1) return null;
		const bytesPerPixel = 4;
		const unpadded = w * bytesPerPixel;
		const bytesPerRow = Math.max(256, Math.ceil(unpadded / 256) * 256);
		const device = root.device;
		const staging = device.createBuffer({
			size: bytesPerRow * h,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
		});
		const encoder = device.createCommandEncoder();
		encoder.copyTextureToBuffer(
			{ texture: root.unwrap(docTex), origin: [x0, y0, 0] },
			{ buffer: staging, bytesPerRow },
			[w, h, 1]
		);
		device.queue.submit([encoder.finish()]);
		await staging.mapAsync(GPUMapMode.READ);
		const mapped = new Uint8Array(staging.getMappedRange());
		const tightly = new Uint8Array(w * h * 4);
		for (let row = 0; row < h; row++) {
			tightly.set(mapped.subarray(row * bytesPerRow, row * bytesPerRow + unpadded), row * unpadded);
		}
		staging.unmap();
		staging.destroy();
		return tightly;
	}

	async function samplePatchAt(x: number, y: number, radius: number) {
		if (destroyed) return null;
		const cx = Math.floor(x);
		const cy = Math.floor(y);
		if (cx < 0 || cy < 0 || cx >= docW || cy >= docH) return null;

		const r = Math.max(0, Math.floor(radius));
		const full = r * 2 + 1;
		const x0 = Math.max(0, cx - r);
		const y0 = Math.max(0, cy - r);
		const x1 = Math.min(docW, cx + r + 1);
		const y1 = Math.min(docH, cy + r + 1);
		const srcW = x1 - x0;
		const srcH = y1 - y0;
		if (srcW < 1 || srcH < 1) return null;

		const patch = await readDocPixels(x0, y0, srcW, srcH);
		if (!patch) return null;

		// Full loupe buffer; outside-doc samples stay white like paper.
		const pixels = new Uint8ClampedArray(full * full * 4);
		pixels.fill(255);
		const destOx = x0 - (cx - r);
		const destOy = y0 - (cy - r);
		for (let row = 0; row < srcH; row++) {
			const srcOff = row * srcW * 4;
			const dstOff = ((destOy + row) * full + destOx) * 4;
			pixels.set(patch.subarray(srcOff, srcOff + srcW * 4), dstOff);
		}

		const i = (r * full + r) * 4;
		const hex = `#${[pixels[i], pixels[i + 1], pixels[i + 2]]
			.map((n) => n.toString(16).padStart(2, '0'))
			.join('')}`;

		return { width: full, height: full, pixels, hex };
	}

	return {
		get docW() {
			return docW;
		},
		get docH() {
			return docH;
		},

		resize(cssW: number, cssH: number) {
			if (destroyed) return;
			const dpr = Math.min(devicePixelRatio || 1, MAX_PRESENT_DPR);
			canvas.width = Math.max(1, Math.round(cssW * dpr));
			canvas.height = Math.max(1, Math.round(cssH * dpr));
			root.configureContext({ canvas, format, alphaMode: 'opaque' });
		},

		async resizeDocument(width: number, height: number, opts?: { cropX?: number; cropY?: number }) {
			if (destroyed) return false;
			const nextW = sanitizeDocSize(width);
			const nextH = sanitizeDocSize(height);
			// Krita resizeImage(newRect): newRect in old image coords.
			// Content is translated by (-cropX, -cropY) — never resampled.
			const cropX = Math.round(opts?.cropX ?? 0);
			const cropY = Math.round(opts?.cropY ?? 0);
			if (nextW === docW && nextH === docH && cropX === 0 && cropY === 0) {
				return false;
			}

			stampCount = 0;
			lastStamp = null;
			averageOpacity = 0;
			lassoPoints.length = 0;
			strokeBounds.reset();
			while (undoStack.length > 0) disposeEntry(undoStack.pop()!);
			while (redoStack.length > 0) disposeEntry(redoStack.pop()!);

			const oldW = docW;
			const oldH = docH;

			// Read the whole document to CPU (eyedropper readback path).
			// Krita keeps pixels by shifting layer data; we do the
			// equivalent translate on the CPU then re-upload.
			const oldPixels = await readDocPixels(0, 0, oldW, oldH);
			if (!oldPixels || destroyed) return false;

			const oldDoc = docTex;
			const oldStroke = strokeTex;
			const oldStrokeB = strokeTexB;

			docW = nextW;
			docH = nextH;
			docTex = createDocTexture(nextW, nextH);
			strokeTex = createDocTexture(nextW, nextH);
			strokeTexB = createDocTexture(nextW, nextH);
			docView = docTex.createView();
			strokeView = strokeTex.createView();
			docRenderView = docTex.createView('render');
			strokeRenderView = strokeTex.createView('render');
			strokeRenderViewB = strokeTexB.createView('render');

			const pixels = new Uint8Array(nextW * nextH * 4).fill(255);
			const srcX0 = Math.max(0, cropX);
			const srcY0 = Math.max(0, cropY);
			const srcX1 = Math.min(oldW, cropX + nextW);
			const srcY1 = Math.min(oldH, cropY + nextH);
			const dstX = srcX0 - cropX;
			const dstY = srcY0 - cropY;
			const copyW = srcX1 - srcX0;
			const copyH = srcY1 - srcY0;
			if (copyW > 0 && copyH > 0) {
				for (let row = 0; row < copyH; row++) {
					const srcOff = ((srcY0 + row) * oldW + srcX0) * 4;
					const dstOff = ((dstY + row) * nextW + dstX) * 4;
					pixels.set(oldPixels.subarray(srcOff, srcOff + copyW * 4), dstOff);
				}
			}

			docTex.write(pixels);
			strokeTex.clear();
			strokeTexB.clear();
			rebuildDocSamplePipelines();

			void root.device.queue.onSubmittedWorkDone().then(() => {
				oldDoc.destroy();
				oldStroke.destroy();
				oldStrokeB.destroy();
			});

			return true;
		},

		setBrush(brush: BrushKind) {
			if (destroyed) return;
			currentBrush = brush;
			// Pen / lasso use the hard tip texture; airbrush is procedural.
			if (brush !== 'airbrush') brushTex.write(hardTipPixels);
		},

		beginStroke() {
			if (destroyed) return;
			strokeTex.clear();
			strokeTexB.clear();
			lastStamp = null;
			stampCount = 0;
			averageOpacity = 0;
			lassoPoints.length = 0;
			strokeBounds.reset();
		},

		endStroke(opacity: number) {
			if (destroyed) return;

			if (currentBrush === 'lasso') {
				stampCount = 0;
				strokeTex.clear();
				const filled = fillLassoIntoStroke(lastColor);
				lassoPoints.length = 0;
				if (!filled) {
					lastStamp = null;
					strokeBounds.reset();
					return;
				}
			} else {
				paintStampsToStroke(lastColor);
			}

			const bounds = strokeBounds.finalize(docW, docH);
			if (bounds) {
				clearRedoStack();
				// Snapshot the dirty rect BEFORE compositing (pixels under the stroke).
				const prev = capturePatch(bounds);
				compositeStroke(opacity);
				// Snapshot AFTER compositing for redo.
				const after = capturePatch(bounds);
				undoStack.push({ bounds, prev, after });
				enforceHistoryBudget();
			} else {
				compositeStroke(opacity);
			}

			strokeTex.clear();
			strokeTexB.clear();
			lastStamp = null;
			stampCount = 0;
			averageOpacity = 0;
			lassoPoints.length = 0;
			strokeBounds.reset();
		},

		cancelStroke() {
			if (destroyed) return;
			stampCount = 0;
			lastStamp = null;
			averageOpacity = 0;
			lassoPoints.length = 0;
			strokeTex.clear();
			strokeTexB.clear();
			strokeBounds.reset();
		},

		undo() {
			if (destroyed || undoStack.length === 0) return false;
			const entry = undoStack.pop()!;
			applyPatch(entry.bounds, entry.prev);
			redoStack.push(entry);
			return true;
		},

		redo() {
			if (destroyed || redoStack.length === 0) return false;
			const entry = redoStack.pop()!;
			applyPatch(entry.bounds, entry.after);
			undoStack.push(entry);
			enforceHistoryBudget();
			return true;
		},

		canUndo() {
			return !destroyed && undoStack.length > 0;
		},

		canRedo() {
			return !destroyed && redoStack.length > 0;
		},

		addSample(
			x: number,
			y: number,
			brushDiameter: number,
			sizePressure: number,
			opacityPressure: number,
			color: string,
			spacingFactor = 0.005
		) {
			if (destroyed) return;
			lastColor = color;
			const sizeP = Math.min(1, Math.max(0, sizePressure));
			const opacP = Math.min(1, Math.max(0, opacityPressure));

			if (currentBrush === 'lasso') {
				const last = lassoPoints[lassoPoints.length - 1];
				if (!last || Math.hypot(x - last.x, y - last.y) >= LASSO_MIN_DIST) {
					lassoPoints.push({ x, y });
					strokeBounds.expand(x, y, 1);
				}
				// Fixed-size dotted outline preview (ignore brush size & pressure).
				const outlineDiameter = 5;
				const spacing = spacingFor(outlineDiameter, 2.5);
				const outlineOpac = 0.85;
				if (!lastStamp) {
					queueStamp(x, y, outlineDiameter, 1, outlineOpac);
					lastStamp = { x, y, sizePressure: 1, opacityPressure: outlineOpac };
					if (stampCount >= MAX_STAMPS_PER_FLUSH) paintStampsToStroke(color);
					return;
				}
				const dx = x - lastStamp.x;
				const dy = y - lastStamp.y;
				const dist = Math.hypot(dx, dy);
				if (dist < spacing) return;
				const steps = Math.floor(dist / spacing);
				for (let i = 1; i <= steps; i++) {
					const t = i / steps;
					queueStamp(
						lastStamp.x + dx * t,
						lastStamp.y + dy * t,
						outlineDiameter,
						1,
						outlineOpac
					);
					if (stampCount >= MAX_STAMPS_PER_FLUSH) paintStampsToStroke(color);
				}
				lastStamp = { x, y, sizePressure: 1, opacityPressure: outlineOpac };
				return;
			}

			if (sizeP <= 0 && opacP <= 0) return;
			const spacing = spacingFor(brushDiameter * Math.max(sizeP, 0.05), spacingFactor);

			if (!lastStamp) {
				queueStamp(x, y, brushDiameter, sizeP, opacP);
				lastStamp = { x, y, sizePressure: sizeP, opacityPressure: opacP };
				if (stampCount >= MAX_STAMPS_PER_FLUSH) paintStampsToStroke(color);
				return;
			}

			const dx = x - lastStamp.x;
			const dy = y - lastStamp.y;
			const dist = Math.hypot(dx, dy);
			if (dist < spacing) return;

			const prevSizeP = lastStamp.sizePressure;
			const prevOpacP = lastStamp.opacityPressure;
			const steps = Math.floor(dist / spacing);
			for (let i = 1; i <= steps; i++) {
				const t = i / steps;
				queueStamp(
					lastStamp.x + dx * t,
					lastStamp.y + dy * t,
					brushDiameter,
					prevSizeP + (sizeP - prevSizeP) * t,
					prevOpacP + (opacP - prevOpacP) * t
				);
				if (stampCount >= MAX_STAMPS_PER_FLUSH) paintStampsToStroke(color);
			}
			lastStamp = { x, y, sizePressure: sizeP, opacityPressure: opacP };
		},

		flushStamps(color: string) {
			paintStampsToStroke(color);
		},

		async sampleColor(x: number, y: number) {
			const patch = await samplePatchAt(x, y, 0);
			return patch?.hex ?? null;
		},

		samplePatch: samplePatchAt,

		present(view: ViewState, cssW: number, cssH: number, opacity: number, strokeActive: boolean) {
			if (destroyed || cssW < 1 || cssH < 1) return;

			// One submit: fullscreen inverse-map present.
			// TypeGPU's bare `.draw()` submits the queue each call — avoid dual passes.
			presentUniforms.write({
				viewport: [cssW, cssH],
				center: [cssW * 0.5, cssH * 0.5],
				pan: [view.x, view.y],
				zoom: view.zoom,
				rotate: view.rotation,
				flipX: view.flipX < 0 ? -1 : 1,
				strokeOpacity: opacity,
				strokeActive: strokeActive ? 1 : 0,
				docSize: [docW, docH]
			});

			pipelines.presentPipeline
				.withColorAttachment({
					view: context,
					clearValue: [GRID_BG[0], GRID_BG[1], GRID_BG[2], 1],
					loadOp: 'clear',
					storeOp: 'store'
				})
				.draw(3);
		},

		destroy() {
			destroyed = true;
			for (const e of undoStack) disposeEntry(e);
			for (const e of redoStack) disposeEntry(e);
			undoStack.length = 0;
			redoStack.length = 0;
			root.destroy();
		}
	};
}

import tgpu, { d } from 'typegpu';
import {
	AIRBRUSH_FLOW,
	BRUSH_SIZE,
	DEFAULT_DOC_W,
	DEFAULT_DOC_H,
	FLOATS_PER_VERT,
	GRID_BG,
	MAX_PRESENT_DPR,
	MAX_STAMPS_PER_FLUSH,
	MAX_VERT_FLOATS,
	VERTS_PER_STAMP,
	sanitizeDocSize
} from './constants';
import {
	appendStamp,
	makeHardBrushPixels,
	parseColor,
	spacingFor,
	webGpuUnavailableMessage
} from './cpu';
import {
	createLassoEngine,
	DEFAULT_LASSO_OPTIONS,
	MAX_LASSO_EDGES,
	type LassoFillBatch,
	type LassoEngine
} from './lasso';
import { createFanEngine, type FanBatch, type FanEngine, type FanKind } from './fan';
import {
	AirbrushUniforms,
	CompositeUniforms,
	FanUniforms,
	FanVertex,
	PresentUniforms,
	StampVertex,
	StrokeUniforms
} from './schemas';
import { createPaintPipelines } from './pipelines';
import { createStrokeBoundsTracker } from './strokeBounds';
import type { BrushKind, GpuPaint, LassoOptions, RasterHistoryEntry, Rect, ViewState } from './types';

function isFanBrush(b: BrushKind): b is FanKind {
	return b === 'fan' || b === 'fanFade';
}

export async function createGpuPaint(
	canvas: HTMLCanvasElement,
	opts?: { width?: number; height?: number; pixels?: Uint8Array }
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
	function createLassoStencilTexture(w: number, h: number) {
		return root.createTexture({ size: [w, h], format: 'stencil8' }).$usage('render');
	}
	let lassoStencilTex = createLassoStencilTexture(docW, docH);
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
	let strokeRawRenderView = root.unwrap(strokeTex).createView();
	let lassoStencilRawView = root.unwrap(lassoStencilTex).createView();

	/** Filled via root.with(...) when (re)building pipelines after a doc resize. */
	const docViewSlot = tgpu.slot<typeof docView>();
	const strokeViewSlot = tgpu.slot<typeof strokeView>();

	const linearSamp = root.createSampler({ magFilter: 'linear', minFilter: 'linear' });

	const strokeUniforms = root.createUniform(StrokeUniforms, {
		resolution: [docW, docH],
		color: [0, 0, 0, 1]
	});
	const fanUniforms = root.createUniform(FanUniforms, {
		resolution: [docW, docH],
		color: [0, 0, 0]
	});
	const airbrushUniforms = root.createUniform(AirbrushUniforms, {
		resolution: [docW, docH],
		color: [0, 0, 0],
		flow: AIRBRUSH_FLOW
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
	const fanLayout = tgpu.vertexLayout(d.disarrayOf(FanVertex));
	const fanVertexBuf = root
		.createBuffer(fanLayout.schemaForCount(MAX_STAMPS_PER_FLUSH * 3))
		.$usage('vertex');
	const lassoVertexBuf = root
		.createBuffer(fanLayout.schemaForCount(MAX_LASSO_EDGES * 3))
		.$usage('vertex');

	const textureViews = { docView, strokeView };
	const pipelines = createPaintPipelines({
		root,
		format,
		stampLayout,
		vertexBuf,
		fanLayout,
		fanVertexBuf,
		lassoVertexBuf,
		strokeUniforms,
		fanUniforms,
		airbrushUniforms,
		compositeUniforms,
		presentUniforms,
		brushView,
		linearSamp,
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
	const initialPixels =
		opts?.pixels?.byteLength === docW * docH * 4
			? opts.pixels
			: new Uint8Array(docW * docH * 4).fill(255);
	docTex.write(initialPixels);
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
	let lassoOpts: LassoOptions = { ...DEFAULT_LASSO_OPTIONS };
	const lasso: LassoEngine = createLassoEngine(docW, docH);
	const fan: FanEngine = createFanEngine(docW, docH, 'fan');

	const strokeBounds = createStrokeBoundsTracker();
	let parsedColorHex = '';
	let parsedColor: [number, number, number] = [0, 0, 0];
	function colorChannels(hex: string) {
		if (hex !== parsedColorHex) {
			parsedColorHex = hex;
			parsedColor = parseColor(hex);
		}
		return parsedColor;
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
		root.device.queue.writeBuffer(root.unwrap(vertexBuf), 0, vertexCpu.buffer, 0, floats * 4);

		const [r, g, b] = colorChannels(color);
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

	function paintFanBatch(batch: FanBatch, color: string) {
		root.device.queue.writeBuffer(
			root.unwrap(fanVertexBuf),
			0,
			batch.vertices.buffer,
			batch.vertices.byteOffset,
			batch.vertices.byteLength
		);
		const [r, g, b] = colorChannels(color);
		fanUniforms.write({ resolution: [docW, docH], color: [r, g, b] });
		pipelines.fanPipeline
			.withColorAttachment({
				view: strokeRenderView,
				loadOp: 'load',
				storeOp: 'store'
			})
			.draw(batch.vertexCount);
		strokeBounds.expandRect(batch.bounds);
	}

	function paintLassoFill(batch: LassoFillBatch, color: string) {
		root.device.queue.writeBuffer(
			root.unwrap(lassoVertexBuf),
			0,
			batch.vertices.buffer,
			batch.vertices.byteOffset,
			batch.vertices.byteLength
		);
		const [r, g, b] = colorChannels(color);
		fanUniforms.write({ resolution: [docW, docH], color: [r, g, b] });

		const encoder = root.device.createCommandEncoder();
		const stencilPass = encoder.beginRenderPass({
			colorAttachments: [],
			depthStencilAttachment: {
				view: lassoStencilRawView,
				stencilClearValue: 0,
				stencilLoadOp: 'clear',
				stencilStoreOp: 'store'
			}
		});
		pipelines.lassoStencilPipeline
			.with(stencilPass)
			.withStencilReference(0)
			.draw(batch.vertexCount);
		stencilPass.end();

		const fillPass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: strokeRawRenderView,
					clearValue: [0, 0, 0, 0],
					loadOp: 'clear',
					storeOp: 'store'
				}
			],
			depthStencilAttachment: {
				view: lassoStencilRawView,
				stencilLoadOp: 'load',
				stencilStoreOp: 'discard'
			}
		});
		fillPass.setScissorRect(batch.bounds.x, batch.bounds.y, batch.bounds.w, batch.bounds.h);
		pipelines.lassoFillPipeline.with(fillPass).withStencilReference(0).draw(3);
		fillPass.end();
		root.device.queue.submit([encoder.finish()]);

		strokeBounds.reset();
		strokeBounds.expandRect(batch.bounds);
	}

	/**
	 * Sequential Alpha Darken dabs encoded into one GPU submission. The copies
	 * preserve ping-pong correctness, but avoid three queue submissions per dab.
	 */
	function paintAirbrushStamps(color: string) {
		if (stampCount === 0) return;
		const [r, g, b] = colorChannels(color);
		const floats = stampCount * VERTS_PER_STAMP * FLOATS_PER_VERT;
		root.device.queue.writeBuffer(root.unwrap(vertexBuf), 0, vertexCpu.buffer, 0, floats * 4);
		airbrushUniforms.write({
			resolution: [docW, docH],
			color: [r, g, b],
			flow: AIRBRUSH_FLOW
		});

		const encoder = root.device.createCommandEncoder();
		const source = root.unwrap(strokeTex);
		const target = root.unwrap(strokeTexB);

		for (let i = 0; i < stampCount; i++) {
			const base = i * VERTS_PER_STAMP * FLOATS_PER_VERT;
			const x = vertexCpu[base]!;
			const y = vertexCpu[base + 1]!;
			const size = vertexCpu[base + 4]!;
			const sizeP = vertexCpu[base + 5]!;
			const radius = size * 0.5 * Math.max(sizeP, 0.05);
			const pad = Math.ceil(radius) + 2;
			const x0 = Math.max(0, Math.floor(x - pad));
			const y0 = Math.max(0, Math.floor(y - pad));
			const x1 = Math.min(docW, Math.ceil(x + pad));
			const y1 = Math.min(docH, Math.ceil(y + pad));
			const w = x1 - x0;
			const h = y1 - y0;
			if (w < 1 || h < 1) continue;

			encoder.copyTextureToTexture(
				{ texture: source, origin: [x0, y0, 0] },
				{ texture: target, origin: [x0, y0, 0] },
				[w, h, 1]
			);

			pipelines.strokeAirbrushPipeline
				.with(encoder)
				.withColorAttachment({
					view: strokeRenderViewB,
					loadOp: 'load',
					storeOp: 'store'
				})
				.draw(VERTS_PER_STAMP, 1, i * VERTS_PER_STAMP);

			encoder.copyTextureToTexture(
				{ texture: target, origin: [x0, y0, 0] },
				{ texture: source, origin: [x0, y0, 0] },
				[w, h, 1]
			);
		}
		root.device.queue.submit([encoder.finish()]);
		stampCount = 0;
	}

	function uploadPathDirty(result: { pixels: Uint8Array; bounds: Rect }) {
		const { bounds, pixels } = result;
		root.device.queue.writeTexture(
			{
				texture: root.unwrap(strokeTex),
				origin: { x: bounds.x, y: bounds.y, z: 0 }
			},
			pixels,
			{ bytesPerRow: bounds.w * 4, rowsPerImage: bounds.h },
			{ width: bounds.w, height: bounds.h, depthOrArrayLayers: 1 }
		);
		strokeBounds.expandRect(bounds);
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

	async function readTexturePixels(
		texture: typeof docTex,
		x0: number,
		y0: number,
		w: number,
		h: number
	): Promise<Uint8Array | null> {
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
			{ texture: root.unwrap(texture), origin: [x0, y0, 0] },
			{ buffer: staging, bytesPerRow },
			[w, h, 1]
		);
		device.queue.submit([encoder.finish()]);
		let mapped = false;
		try {
			await staging.mapAsync(GPUMapMode.READ);
			mapped = true;
			const source = new Uint8Array(staging.getMappedRange());
			const tightly = new Uint8Array(w * h * 4);
			for (let row = 0; row < h; row++) {
				tightly.set(
					source.subarray(row * bytesPerRow, row * bytesPerRow + unpadded),
					row * unpadded
				);
			}
			return tightly;
		} finally {
			if (mapped) staging.unmap();
			staging.destroy();
		}
	}

	/** Read several dirty regions with one GPU submission and one mapped buffer. */
	async function readTextureRegions(texture: typeof docTex, regions: Rect[]) {
		if (destroyed || regions.length === 0) return null;
		const layouts = regions.map((bounds) => {
			const unpadded = bounds.w * 4;
			const bytesPerRow = Math.max(256, Math.ceil(unpadded / 256) * 256);
			return { bounds, unpadded, bytesPerRow, size: bytesPerRow * bounds.h };
		});
		let totalSize = 0;
		const offsets = layouts.map((layout) => {
			const offset = totalSize;
			totalSize += layout.size;
			return offset;
		});
		const device = root.device;
		const staging = device.createBuffer({
			size: totalSize,
			usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
		});
		const encoder = device.createCommandEncoder();
		for (let i = 0; i < layouts.length; i++) {
			const { bounds, bytesPerRow } = layouts[i]!;
			encoder.copyTextureToBuffer(
				{ texture: root.unwrap(texture), origin: [bounds.x, bounds.y, 0] },
				{ buffer: staging, offset: offsets[i], bytesPerRow },
				[bounds.w, bounds.h, 1]
			);
		}
		device.queue.submit([encoder.finish()]);
		let mapped = false;
		try {
			await staging.mapAsync(GPUMapMode.READ);
			mapped = true;
			const source = new Uint8Array(staging.getMappedRange());
			return layouts.map(({ bounds, unpadded, bytesPerRow }, index) => {
				const tightly = new Uint8Array(unpadded * bounds.h);
				const base = offsets[index]!;
				for (let row = 0; row < bounds.h; row++) {
					tightly.set(
						source.subarray(base + row * bytesPerRow, base + row * bytesPerRow + unpadded),
						row * unpadded
					);
				}
				return tightly;
			});
		} finally {
			if (mapped) staging.unmap();
			staging.destroy();
		}
	}

	function readDocPixels(x0: number, y0: number, w: number, h: number) {
		return readTexturePixels(docTex, x0, y0, w, h);
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
			lasso.reset();
			lasso.resize(nextW, nextH);
			fan.reset();
			fan.resize(nextW, nextH);
			strokeBounds.reset();
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
			const oldLassoStencil = lassoStencilTex;

			docW = nextW;
			docH = nextH;
			docTex = createDocTexture(nextW, nextH);
			strokeTex = createDocTexture(nextW, nextH);
			strokeTexB = createDocTexture(nextW, nextH);
			lassoStencilTex = createLassoStencilTexture(nextW, nextH);
			docView = docTex.createView();
			strokeView = strokeTex.createView();
			docRenderView = docTex.createView('render');
			strokeRenderView = strokeTex.createView('render');
			strokeRenderViewB = strokeTexB.createView('render');
			strokeRawRenderView = root.unwrap(strokeTex).createView();
			lassoStencilRawView = root.unwrap(lassoStencilTex).createView();

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
				oldLassoStencil.destroy();
			});

			return true;
		},

		setBrush(brush: BrushKind) {
			if (destroyed) return;
			currentBrush = brush;
			// Pen / path tools use the hard tip texture; airbrush is procedural.
			if (brush !== 'airbrush') brushTex.write(hardTipPixels);
			if (isFanBrush(brush)) fan.setKind(brush);
		},

		setLassoOptions(opts: Partial<LassoOptions>) {
			if (destroyed) return;
			if (opts.mode !== undefined) lassoOpts.mode = opts.mode;
			if (opts.splat !== undefined) lassoOpts.splat = opts.splat;
			lasso.setOptions(lassoOpts);
		},

		beginStroke() {
			if (destroyed) return;
			strokeTex.clear();
			strokeTexB.clear();
			lastStamp = null;
			stampCount = 0;
			if (currentBrush === 'lasso') {
				lasso.setOptions(lassoOpts);
				lasso.begin(lastColor);
			} else if (isFanBrush(currentBrush)) {
				fan.setKind(currentBrush);
				fan.begin(lastColor);
			}
			strokeBounds.reset();
		},

		async endStroke(opacity: number): Promise<RasterHistoryEntry | null> {
			if (destroyed) return null;

			if (currentBrush === 'lasso') {
				stampCount = 0;
				const flushed = lasso.flush();
				if (flushed) paintLassoFill(flushed, lastColor);
				const ok = lasso.hasDrawable();
				const final = lasso.finalizeBounds();
				lasso.reset();
				if (!ok || !final) {
					lastStamp = null;
					strokeBounds.reset();
					return null;
				}
				strokeBounds.expandRect(final);
			} else if (isFanBrush(currentBrush)) {
				stampCount = 0;
				const flushed = fan.flush();
				if (flushed) paintFanBatch(flushed, lastColor);
				const ok = fan.hasDrawable();
				const final = fan.finalizeBounds();
				fan.reset();
				if (!ok || !final) {
					lastStamp = null;
					strokeBounds.reset();
					return null;
				}
				strokeBounds.expandRect(final);
			} else {
				paintStampsToStroke(lastColor);
			}

			const regions = strokeBounds.finalizeRegions(docW, docH);
			let serializedPatch: Promise<RasterHistoryEntry | null> | null = null;
			if (regions.length > 0) {
				// Queue order preserves the before/composite/after boundary. Each side uses
				// one staging buffer even when a long sparse stroke spans many tile-runs.
				const beforePromise = readTextureRegions(docTex, regions);
				compositeStroke(opacity);
				const afterPromise = readTextureRegions(docTex, regions);
				serializedPatch = Promise.all([beforePromise, afterPromise]).then(
					([beforePixels, afterPixels]) => {
						if (!beforePixels || !afterPixels) return null;
						return regions.map((bounds, index) => ({
							bounds: { ...bounds },
							before: beforePixels[index]!,
							after: afterPixels[index]!
						}));
					}
				);
			} else {
				compositeStroke(opacity);
			}

			strokeTex.clear();
			strokeTexB.clear();
			lastStamp = null;
			stampCount = 0;
			lasso.reset();
			fan.reset();
			strokeBounds.reset();
			return serializedPatch ? await serializedPatch : null;
		},

		cancelStroke() {
			if (destroyed) return;
			stampCount = 0;
			lastStamp = null;
			lasso.reset();
			fan.reset();
			strokeTex.clear();
			strokeTexB.clear();
			strokeBounds.reset();
		},

		applyRasterPatch(bounds: Rect, pixels: Uint8Array) {
			if (destroyed || pixels.byteLength !== bounds.w * bounds.h * 4) return;
			root.device.queue.writeTexture(
				{
					texture: root.unwrap(docTex),
					origin: { x: bounds.x, y: bounds.y, z: 0 }
				},
				pixels,
				{ bytesPerRow: bounds.w * 4, rowsPerImage: bounds.h },
				{ width: bounds.w, height: bounds.h, depthOrArrayLayers: 1 }
			);
		},

		readDocument() {
			return readDocPixels(0, 0, docW, docH);
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
				const dirty = lasso.sample(x, y, color);
				if (dirty?.kind === 'fill') paintLassoFill(dirty, color);
				else if (dirty) uploadPathDirty(dirty);
				return;
			}

			if (isFanBrush(currentBrush)) {
				const dirty = fan.sample(x, y, color);
				if (dirty) paintFanBatch(dirty, color);
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

		addTimedAirbrushDab(
			x: number,
			y: number,
			brushDiameter: number,
			sizePressure: number,
			opacityPressure: number,
			color: string
		) {
			if (destroyed || currentBrush !== 'airbrush') return;
			lastColor = color;
			const sizeP = Math.min(1, Math.max(0, sizePressure));
			const opacP = Math.min(1, Math.max(0, opacityPressure));
			if (sizeP <= 0 && opacP <= 0) return;
			queueStamp(x, y, brushDiameter, sizeP, opacP);
			if (stampCount >= MAX_STAMPS_PER_FLUSH) paintAirbrushStamps(color);
		},

		flushStamps(color: string) {
			if (currentBrush === 'lasso') {
				const dirty = lasso.flush();
				if (dirty) paintLassoFill(dirty, color);
				return;
			}
			if (isFanBrush(currentBrush)) {
				const dirty = fan.flush();
				if (dirty) paintFanBatch(dirty, color);
				return;
			}
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
			lasso.reset();
			fan.reset();
			lassoStencilTex.destroy();
			root.destroy();
		}
	};
}

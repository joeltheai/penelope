import tgpu, { d } from 'typegpu';
import {
	DEFAULT_DOC_H,
	DEFAULT_DOC_W,
	FLOATS_PER_VERT,
	GRID_BG,
	MAX_PRESENT_DPR,
	MAX_STAMPS_PER_FLUSH,
	MAX_VERT_FLOATS,
	VERTS_PER_STAMP,
	sanitizeDocSize
} from './constants';
import { appendStamp, parseColor, webGpuUnavailableMessage } from './cpu';
import {
	BRUSH_TIP_SIZE,
	DEFAULT_BRUSH_SETTINGS,
	brushSpacingPx,
	clamp01,
	makeBrushTipPixels
} from './brush';
import {
	createLassoEngine,
	DEFAULT_LASSO_OPTIONS,
	MAX_LASSO_EDGES,
	type LassoFillBatch,
	type LassoEngine
} from './lasso';
import { createFanEngine, type FanBatch, type FanEngine, type FanKind } from './fan';
import {
	CompositeUniforms,
	FanUniforms,
	FanVertex,
	PresentUniforms,
	StampVertex,
	StrokeUniforms
} from './schemas';
import { createPaintPipelines } from './pipelines';
import { createStrokeBoundsTracker } from './strokeBounds';
import { createGpuUndoStack } from './undo';
import type {
	BrushKind,
	BrushSettings,
	GpuPaint,
	LassoOptions,
	Rect,
	ToolKind,
	ViewState
} from './types';

const MAX_DABS_PER_SEGMENT = 512;

function isFanTool(b: ToolKind): b is FanKind {
	return b === 'fan' || b === 'fanFade';
}

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

	const device = root.device;
	const format = navigator.gpu.getPreferredCanvasFormat();
	const context = root.configureContext({ canvas, format, alphaMode: 'opaque' });

	let docW = sanitizeDocSize(opts?.width ?? DEFAULT_DOC_W);
	let docH = sanitizeDocSize(opts?.height ?? DEFAULT_DOC_H);

	function createDocTexture(w: number, h: number) {
		return root.createTexture({ size: [w, h], format: 'rgba8unorm' }).$usage('sampled', 'render');
	}

	function createLassoStencilTexture(w: number, h: number) {
		return root.createTexture({ size: [w, h], format: 'stencil8' }).$usage('render');
	}

	function fillTexture(texture: GPUTexture, color: [number, number, number, number]) {
		const encoder = device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			colorAttachments: [
				{
					view: texture.createView(),
					clearValue: color,
					loadOp: 'clear',
					storeOp: 'store'
				}
			]
		});
		pass.end();
		device.queue.submit([encoder.finish()]);
	}

	let docTex = createDocTexture(docW, docH);
	let strokeTex = createDocTexture(docW, docH);
	let lassoStencilTex = createLassoStencilTexture(docW, docH);
	fillTexture(root.unwrap(docTex), [1, 1, 1, 1]);

	const brushMipLevels = Math.floor(Math.log2(BRUSH_TIP_SIZE)) + 1;
	const brushTex = root
		.createTexture({
			size: [BRUSH_TIP_SIZE, BRUSH_TIP_SIZE],
			format: 'rgba8unorm',
			mipLevelCount: brushMipLevels
		})
		.$usage('sampled', 'render');
	const brushView = brushTex.createView();

	let docView = docTex.createView();
	let strokeView = strokeTex.createView();
	let docRenderView = root.unwrap(docTex).createView();
	let strokeRawRenderView = root.unwrap(strokeTex).createView();
	let lassoStencilRawView = root.unwrap(lassoStencilTex).createView();

	const docViewSlot = tgpu.slot<typeof docView>();
	const strokeViewSlot = tgpu.slot<typeof strokeView>();

	const linearSamp = root.createSampler({
		magFilter: 'linear',
		minFilter: 'linear',
		mipmapFilter: 'linear'
	});

	const strokeUniforms = root.createUniform(StrokeUniforms, {
		resolution: [docW, docH],
		color: [0, 0, 0, 1]
	});
	const fanUniforms = root.createUniform(FanUniforms, {
		resolution: [docW, docH],
		color: [0, 0, 0]
	});
	const compositeUniforms = root.createUniform(CompositeUniforms, { opacity: 1 });
	type PresentUniformData = {
		viewport: [number, number];
		center: [number, number];
		pan: [number, number];
		inverseRotation: [number, number];
		invZoom: number;
		flipX: number;
		strokeOpacity: number;
		docSize: [number, number];
	};
	const presentUniformData: PresentUniformData = {
		viewport: [1, 1],
		center: [0.5, 0.5],
		pan: [0, 0],
		inverseRotation: [1, 0],
		invZoom: 1,
		flipX: 1,
		strokeOpacity: 1,
		docSize: [docW, docH]
	};
	const presentUniforms = root.createUniform(PresentUniforms, presentUniformData);

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
		compositeUniforms,
		presentUniforms,
		brushView,
		linearSamp,
		docViewSlot,
		strokeViewSlot,
		views: textureViews
	});

	const rebuildDocSamplePipelines = () => {
		textureViews.docView = docView;
		textureViews.strokeView = strokeView;
		pipelines.rebuildDocSamplePipelines();
	};
	rebuildDocSamplePipelines();

	const undo = createGpuUndoStack(device);

	let settings: BrushSettings = { ...DEFAULT_BRUSH_SETTINGS };
	let brushHardness = -1;
	function syncBrushTip() {
		const next = clamp01(settings.hardness);
		if (next === brushHardness) return;
		brushHardness = next;
		brushTex.write(makeBrushTipPixels(BRUSH_TIP_SIZE, next));
		brushTex.generateMipmaps(0, brushMipLevels);
	}
	syncBrushTip();

	let stampCount = 0;
	let lastStamp: {
		x: number;
		y: number;
		sizePressure: number;
		opacityPressure: number;
	} | null = null;
	let lastColor = '#000000';
	let destroyed = false;
	let currentTool: BrushKind = 'pen';
	let lassoOpts: LassoOptions = { ...DEFAULT_LASSO_OPTIONS };
	const lasso: LassoEngine = createLassoEngine(docW, docH);
	const fan: FanEngine = createFanEngine(docW, docH, 'fan');

	const strokeBounds = createStrokeBoundsTracker();
	let batchHasBounds = false;
	let batchMinX = 0;
	let batchMinY = 0;
	let batchMaxX = 0;
	let batchMaxY = 0;
	let parsedColorHex = '';
	let parsedColor: [number, number, number] = [0, 0, 0];

	let strokeNeedsClear = false;
	let strokeNeedsFullClear = true;
	let strokeDirty: Rect | null = null;

	function colorChannels(hex: string) {
		if (hex !== parsedColorHex) {
			parsedColorHex = hex;
			parsedColor = parseColor(hex);
		}
		return parsedColor;
	}

	function resetStampBatchBounds() {
		batchHasBounds = false;
	}

	function expandStampBatchBounds(x: number, y: number, radius: number) {
		const pad = Math.ceil(radius) + 1;
		const minX = x - pad;
		const minY = y - pad;
		const maxX = x + pad;
		const maxY = y + pad;
		if (!batchHasBounds) {
			batchMinX = minX;
			batchMinY = minY;
			batchMaxX = maxX;
			batchMaxY = maxY;
			batchHasBounds = true;
			return;
		}
		batchMinX = Math.min(batchMinX, minX);
		batchMinY = Math.min(batchMinY, minY);
		batchMaxX = Math.max(batchMaxX, maxX);
		batchMaxY = Math.max(batchMaxY, maxY);
	}

	function clampToDocument(bounds: Rect): Rect | null {
		const x = Math.max(0, Math.floor(bounds.x));
		const y = Math.max(0, Math.floor(bounds.y));
		const x1 = Math.min(docW, Math.ceil(bounds.x + bounds.w));
		const y1 = Math.min(docH, Math.ceil(bounds.y + bounds.h));
		if (x1 <= x || y1 <= y) return null;
		return { x, y, w: x1 - x, h: y1 - y };
	}

	function stampBatchScissor(): Rect | null {
		if (!batchHasBounds) return null;
		return clampToDocument({
			x: batchMinX,
			y: batchMinY,
			w: batchMaxX - batchMinX,
			h: batchMaxY - batchMinY
		});
	}

	function markStrokeDirty(rect: Rect) {
		if (!strokeDirty) {
			strokeDirty = { ...rect };
			return;
		}
		const x0 = Math.min(strokeDirty.x, rect.x);
		const y0 = Math.min(strokeDirty.y, rect.y);
		const x1 = Math.max(strokeDirty.x + strokeDirty.w, rect.x + rect.w);
		const y1 = Math.max(strokeDirty.y + strokeDirty.h, rect.y + rect.h);
		strokeDirty = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
	}

	function encodeStrokeClear(encoder: GPUCommandEncoder) {
		if (!strokeNeedsClear) return;
		if (strokeDirty) {
			const rect = clampToDocument(strokeDirty);
			if (rect) {
				const pass = encoder.beginRenderPass({
					colorAttachments: [
						{ view: strokeRawRenderView, loadOp: 'load', storeOp: 'store' }
					]
				});
				pass.setScissorRect(rect.x, rect.y, rect.w, rect.h);
				pipelines.clearStrokePipeline.with(pass).draw(3);
				pass.end();
			}
		} else if (strokeNeedsFullClear) {
			const pass = encoder.beginRenderPass({
				colorAttachments: [
					{
						view: strokeRawRenderView,
						clearValue: [0, 0, 0, 0],
						loadOp: 'clear',
						storeOp: 'store'
					}
				]
			});
			pass.end();
		}
		strokeDirty = null;
		strokeNeedsClear = false;
		strokeNeedsFullClear = false;
	}

	function clearStrokeTextureNow() {
		if (!strokeNeedsClear) return;
		const encoder = device.createCommandEncoder();
		encodeStrokeClear(encoder);
		device.queue.submit([encoder.finish()]);
	}

	function queueStamp(
		x: number,
		y: number,
		sizePressure: number,
		opacityPressure: number
	) {
		if (stampCount >= MAX_STAMPS_PER_FLUSH) return;
		const jitter = settings.jitter;
		let px = x;
		let py = y;
		let extra = 0;
		if (jitter > 0.0001) {
			const reach = settings.size * jitter;
			const angle = Math.random() * Math.PI * 2;
			const dist = Math.sqrt(Math.random()) * reach;
			px += Math.cos(angle) * dist;
			py += Math.sin(angle) * dist;
			extra = reach;
		}
		const diameter = settings.size * 2;
		const radius = settings.size * Math.max(sizePressure, 0.05) + extra;
		strokeBounds.expand(px, py, radius);
		expandStampBatchBounds(px, py, radius);
		const alpha =
			settings.blend === 'buildup'
				? clamp01(settings.flow) * clamp01(opacityPressure)
				: clamp01(opacityPressure);
		const offset = stampCount * VERTS_PER_STAMP * FLOATS_PER_VERT;
		appendStamp(vertexCpu, offset, px, py, diameter, sizePressure, alpha);
		stampCount++;
	}

	function paintStampsToStroke(color: string, externalEncoder?: GPUCommandEncoder) {
		if (destroyed || stampCount === 0) return false;

		const scissor = stampBatchScissor();
		if (!scissor) {
			stampCount = 0;
			resetStampBatchBounds();
			return false;
		}
		const floats = stampCount * VERTS_PER_STAMP * FLOATS_PER_VERT;
		device.queue.writeBuffer(root.unwrap(vertexBuf), 0, vertexCpu.buffer, 0, floats * 4);

		const [r, g, b] = colorChannels(color);
		strokeUniforms.write({
			resolution: [docW, docH],
			color: [r, g, b, 1]
		});

		const encoder = externalEncoder ?? device.createCommandEncoder();
		encodeStrokeClear(encoder);
		const pass = encoder.beginRenderPass({
			colorAttachments: [{ view: strokeRawRenderView, loadOp: 'load', storeOp: 'store' }]
		});
		pass.setScissorRect(scissor.x, scissor.y, scissor.w, scissor.h);
		const pipeline =
			settings.blend === 'buildup'
				? pipelines.strokeBuildupPipeline
				: pipelines.strokeWashPipeline;
		pipeline.with(pass).draw(stampCount * VERTS_PER_STAMP);
		pass.end();
		if (!externalEncoder) device.queue.submit([encoder.finish()]);
		markStrokeDirty(scissor);
		stampCount = 0;
		resetStampBatchBounds();
		return true;
	}

	function paintFanBatch(batch: FanBatch, color: string) {
		const scissor = clampToDocument(batch.bounds);
		if (!scissor) return;
		device.queue.writeBuffer(
			root.unwrap(fanVertexBuf),
			0,
			batch.vertices.buffer,
			batch.vertices.byteOffset,
			batch.vertices.byteLength
		);
		const [r, g, b] = colorChannels(color);
		fanUniforms.write({ resolution: [docW, docH], color: [r, g, b] });
		const encoder = device.createCommandEncoder();
		encodeStrokeClear(encoder);
		const pass = encoder.beginRenderPass({
			colorAttachments: [{ view: strokeRawRenderView, loadOp: 'load', storeOp: 'store' }]
		});
		pass.setScissorRect(scissor.x, scissor.y, scissor.w, scissor.h);
		pipelines.fanPipeline.with(pass).draw(batch.vertexCount);
		pass.end();
		device.queue.submit([encoder.finish()]);
		markStrokeDirty(scissor);
		strokeBounds.expandRect(batch.bounds);
	}

	function paintLassoFill(batch: LassoFillBatch, color: string) {
		device.queue.writeBuffer(
			root.unwrap(lassoVertexBuf),
			0,
			batch.vertices.buffer,
			batch.vertices.byteOffset,
			batch.vertices.byteLength
		);
		const [r, g, b] = colorChannels(color);
		fanUniforms.write({ resolution: [docW, docH], color: [r, g, b] });

		const encoder = device.createCommandEncoder();
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
		device.queue.submit([encoder.finish()]);
		strokeNeedsClear = false;
		strokeNeedsFullClear = false;
		strokeDirty = null;

		strokeBounds.reset();
		strokeBounds.expandRect(batch.bounds);
		markStrokeDirty(batch.bounds);
	}

	function uploadPathDirty(result: { pixels: Uint8Array; bounds: Rect }) {
		const { bounds, pixels } = result;
		clearStrokeTextureNow();
		device.queue.writeTexture(
			{
				texture: root.unwrap(strokeTex),
				origin: { x: bounds.x, y: bounds.y, z: 0 }
			},
			pixels,
			{ bytesPerRow: bounds.w * 4, rowsPerImage: bounds.h },
			{ width: bounds.w, height: bounds.h, depthOrArrayLayers: 1 }
		);
		strokeBounds.expandRect(bounds);
		markStrokeDirty(bounds);
	}

	function compositeStroke(opacity: number, regions: Rect[], externalEncoder?: GPUCommandEncoder) {
		if (regions.length === 0) return;
		compositeUniforms.write({ opacity });
		const encoder = externalEncoder ?? device.createCommandEncoder();
		const pass = encoder.beginRenderPass({
			colorAttachments: [{ view: docRenderView, loadOp: 'load', storeOp: 'store' }]
		});
		for (const region of regions) {
			pass.setScissorRect(region.x, region.y, region.w, region.h);
			pipelines.compositePipeline.with(pass).draw(3);
		}
		pass.end();
		if (!externalEncoder) device.queue.submit([encoder.finish()]);
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

	function resetStrokeState() {
		stampCount = 0;
		lastStamp = null;
		resetStampBatchBounds();
		strokeBounds.reset();
		lasso.reset();
		fan.reset();
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

		async resizeDocument(width: number, height: number, resizeOpts?: { cropX?: number; cropY?: number }) {
			if (destroyed) return false;
			const nextW = sanitizeDocSize(width);
			const nextH = sanitizeDocSize(height);
			const cropX = Math.round(resizeOpts?.cropX ?? 0);
			const cropY = Math.round(resizeOpts?.cropY ?? 0);
			if (nextW === docW && nextH === docH && cropX === 0 && cropY === 0) return false;

			resetStrokeState();
			undo.clear();
			const oldW = docW;
			const oldH = docH;

			const oldDoc = docTex;
			const oldStroke = strokeTex;
			const oldLassoStencil = lassoStencilTex;

			docW = nextW;
			docH = nextH;
			docTex = createDocTexture(nextW, nextH);
			strokeTex = createDocTexture(nextW, nextH);
			lassoStencilTex = createLassoStencilTexture(nextW, nextH);
			docView = docTex.createView();
			strokeView = strokeTex.createView();
			docRenderView = root.unwrap(docTex).createView();
			strokeRawRenderView = root.unwrap(strokeTex).createView();
			lassoStencilRawView = root.unwrap(lassoStencilTex).createView();

			const srcX0 = Math.max(0, cropX);
			const srcY0 = Math.max(0, cropY);
			const srcX1 = Math.min(oldW, cropX + nextW);
			const srcY1 = Math.min(oldH, cropY + nextH);
			const dstX = srcX0 - cropX;
			const dstY = srcY0 - cropY;
			const copyW = srcX1 - srcX0;
			const copyH = srcY1 - srcY0;

			fillTexture(root.unwrap(docTex), [1, 1, 1, 1]);
			if (copyW > 0 && copyH > 0) {
				const encoder = device.createCommandEncoder();
				encoder.copyTextureToTexture(
					{ texture: root.unwrap(oldDoc), origin: { x: srcX0, y: srcY0, z: 0 } },
					{ texture: root.unwrap(docTex), origin: { x: dstX, y: dstY, z: 0 } },
					{ width: copyW, height: copyH, depthOrArrayLayers: 1 }
				);
				device.queue.submit([encoder.finish()]);
			}

			strokeNeedsClear = false;
			strokeNeedsFullClear = true;
			strokeDirty = null;
			resetStampBatchBounds();
			lasso.resize(nextW, nextH);
			fan.resize(nextW, nextH);
			rebuildDocSamplePipelines();

			void device.queue.onSubmittedWorkDone().then(() => {
				oldDoc.destroy();
				oldStroke.destroy();
				oldLassoStencil.destroy();
			});

			return true;
		},

		setTool(tool: ToolKind) {
			if (destroyed) return;
			currentTool = tool;
			if (isFanTool(tool)) fan.setKind(tool);
		},

		setLassoOptions(next: Partial<LassoOptions>) {
			if (destroyed) return;
			if (next.mode !== undefined) lassoOpts.mode = next.mode;
			if (next.splat !== undefined) lassoOpts.splat = next.splat;
			lasso.setOptions(lassoOpts);
		},

		setBrushSettings(next: Partial<BrushSettings>) {
			if (destroyed) return;
			settings = { ...settings, ...next };
			syncBrushTip();
		},

		beginStroke() {
			if (destroyed) return;
			strokeNeedsClear = true;
			lastStamp = null;
			stampCount = 0;
			resetStampBatchBounds();
			strokeBounds.reset();
			if (currentTool === 'lasso') {
				lasso.setOptions(lassoOpts);
				lasso.begin(lastColor);
			} else if (isFanTool(currentTool)) {
				fan.setKind(currentTool);
				fan.begin(lastColor);
			}
		},

		endStroke(opacity: number) {
			if (destroyed) return;

			if (currentTool === 'lasso') {
				stampCount = 0;
				const flushed = lasso.flush();
				if (flushed) paintLassoFill(flushed, lastColor);
				const final = lasso.finalizeBounds();
				lasso.reset();
				if (!final) {
					resetStrokeState();
					strokeNeedsClear = true;
					return;
				}
				strokeBounds.expandRect(final);
			} else if (isFanTool(currentTool)) {
				stampCount = 0;
				const flushed = fan.flush();
				if (flushed) paintFanBatch(flushed, lastColor);
				const final = fan.finalizeBounds();
				fan.reset();
				if (!final) {
					resetStrokeState();
					strokeNeedsClear = true;
					return;
				}
				strokeBounds.expandRect(final);
			} else {
				paintStampsToStroke(lastColor);
			}

			const bounds = strokeBounds.finalize(docW, docH);
			if (bounds) {
				const regions = strokeBounds.finalizeRegions(docW, docH);
				const encoder = device.createCommandEncoder();
				undo.capture(root.unwrap(docTex), bounds, encoder);
				compositeStroke(opacity, regions, encoder);
				device.queue.submit([encoder.finish()]);
			}

			strokeNeedsClear = true;
			lastStamp = null;
			stampCount = 0;
			resetStampBatchBounds();
			lasso.reset();
			fan.reset();
			strokeBounds.reset();
		},

		cancelStroke() {
			if (destroyed) return;
			stampCount = 0;
			lastStamp = null;
			lasso.reset();
			fan.reset();
			strokeNeedsClear = true;
			resetStampBatchBounds();
			strokeBounds.reset();
		},

		undo() {
			if (destroyed) return false;
			return undo.undo(root.unwrap(docTex));
		},

		redo() {
			if (destroyed) return false;
			return undo.redo(root.unwrap(docTex));
		},

		canUndo() {
			return !destroyed && undo.canUndo();
		},

		canRedo() {
			return !destroyed && undo.canRedo();
		},

		clearUndo() {
			undo.clear();
		},

		readDocument() {
			return readTexturePixels(docTex, 0, 0, docW, docH);
		},

		addSample(
			x: number,
			y: number,
			sizePressure: number,
			opacityPressure: number,
			color: string,
			viewZoom = 1
		) {
			if (destroyed) return;
			lastColor = color;

			if (currentTool === 'lasso') {
				const dirty = lasso.sample(x, y, color);
				if (dirty?.kind === 'fill') paintLassoFill(dirty, color);
				else if (dirty) uploadPathDirty(dirty);
				return;
			}

			if (isFanTool(currentTool)) {
				const dirty = fan.sample(x, y, color);
				if (dirty) paintFanBatch(dirty, color);
				return;
			}

			const sizeP = clamp01(sizePressure);
			const opacP = clamp01(opacityPressure);
			if (sizeP <= 0 && opacP <= 0) return;
			const diameter = settings.size * 2;
			const spacing = brushSpacingPx(
				diameter * Math.max(sizeP, 0.05),
				settings.spacing,
				viewZoom
			);

			if (!lastStamp) {
				queueStamp(x, y, sizeP, opacP);
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
			let steps = Math.floor(dist / spacing);
			if (steps > MAX_DABS_PER_SEGMENT) steps = MAX_DABS_PER_SEGMENT;
			for (let i = 1; i <= steps; i++) {
				const t = i / steps;
				queueStamp(
					lastStamp.x + dx * t,
					lastStamp.y + dy * t,
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
			sizePressure: number,
			opacityPressure: number,
			color: string
		) {
			if (destroyed || currentTool !== 'airbrush') return;
			lastColor = color;
			const sizeP = clamp01(sizePressure);
			const opacP = clamp01(opacityPressure);
			if (sizeP <= 0 && opacP <= 0) return;
			queueStamp(x, y, sizeP, opacP);
			if (stampCount >= MAX_STAMPS_PER_FLUSH) paintStampsToStroke(color);
		},

		flushStamps(color: string) {
			if (destroyed) return;
			lastColor = color;
			if (currentTool === 'lasso') {
				const dirty = lasso.flush();
				if (dirty) paintLassoFill(dirty, color);
				return;
			}
			if (isFanTool(currentTool)) {
				const dirty = fan.flush();
				if (dirty) paintFanBatch(dirty, color);
				return;
			}
			paintStampsToStroke(color);
		},

		present(view: ViewState, cssW: number, cssH: number, opacity: number, strokeActive: boolean) {
			if (destroyed || cssW < 1 || cssH < 1) return;

			const encoder = device.createCommandEncoder();
			paintStampsToStroke(lastColor, encoder);
			const inverseRotation = -view.rotation;
			presentUniformData.viewport[0] = cssW;
			presentUniformData.viewport[1] = cssH;
			presentUniformData.center[0] = cssW * 0.5;
			presentUniformData.center[1] = cssH * 0.5;
			presentUniformData.pan[0] = view.x;
			presentUniformData.pan[1] = view.y;
			presentUniformData.inverseRotation[0] = Math.cos(inverseRotation);
			presentUniformData.inverseRotation[1] = Math.sin(inverseRotation);
			presentUniformData.invZoom = 1 / Math.max(view.zoom, 1e-6);
			presentUniformData.flipX = view.flipX < 0 ? -1 : 1;
			presentUniformData.strokeOpacity = opacity;
			presentUniformData.docSize[0] = docW;
			presentUniformData.docSize[1] = docH;
			presentUniforms.write(presentUniformData);

			const presentPipeline =
				strokeActive && !strokeNeedsClear
					? pipelines.presentStrokePipeline
					: pipelines.presentIdlePipeline;
			presentPipeline
				.with(encoder)
				.withColorAttachment({
					view: context,
					clearValue: [GRID_BG[0], GRID_BG[1], GRID_BG[2], 1],
					loadOp: 'clear',
					storeOp: 'store'
				})
				.draw(3);
			device.queue.submit([encoder.finish()]);
		},

		destroy() {
			destroyed = true;
			undo.clear();
			lasso.reset();
			fan.reset();
			lassoStencilTex.destroy();
			root.destroy();
		}
	};
}

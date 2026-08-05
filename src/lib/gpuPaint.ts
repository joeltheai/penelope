import tgpu, { d, std, common } from 'typegpu';

const DOC_W = 2000;
const DOC_H = 2000;
const BRUSH_SIZE = 128;
const MAX_STAMPS_PER_FLUSH = 4096;
const FLOATS_PER_VERT = 7;
const VERTS_PER_STAMP = 6;
const MAX_VERT_FLOATS = MAX_STAMPS_PER_FLUSH * VERTS_PER_STAMP * FLOATS_PER_VERT;
/** Soft cap on undoable strokes (also bounded by HOT_PIXEL_BUDGET). */
const MAX_HISTORY = 50;
/**
 * Max GPU pixels retained for undo/redo patches (prev+after counted separately).
 * ~32M px ≈ 128 MB RGBA — enough for many small strokes, few full-canvas ones.
 */
const HOT_PIXEL_BUDGET = 32_000_000;

const CORNERS: [number, number][] = [
	[-1, -1],
	[1, -1],
	[1, 1],
	[-1, -1],
	[1, 1],
	[-1, 1]
];

const StampVertex = d.unstruct({
	pos: d.float32x2,
	corner: d.float32x2,
	size: d.float32,
	sizePressure: d.float32,
	opacityPressure: d.float32
});

const StrokeUniforms = d.struct({
	resolution: d.vec2f,
	color: d.vec4f
});

/** Krita-style Alpha Darken params for airbrush wash dabs. */
const AirbrushUniforms = d.struct({
	resolution: d.vec2f,
	color: d.vec3f,
	flow: d.f32,
	averageOpacity: d.f32
});

const CompositeUniforms = d.struct({
	opacity: d.f32
});

const PresentUniforms = d.struct({
	m0: d.vec3f,
	m1: d.vec3f,
	m2: d.vec3f,
	strokeOpacity: d.f32,
	strokeActive: d.f32,
	docSize: d.vec2f
});

// Screen-fixed backdrop grid (does not pan/zoom/rotate with the document)
const GridUniforms = d.struct({
	cssSize: d.vec2f,
	spacing: d.f32
});

const GRID_BG = [0.11, 0.11, 0.114] as const;
const GRID_LINE = [0.18, 0.18, 0.185] as const;
const GRID_MAJOR = [0.24, 0.24, 0.25] as const;
// CSS pixels between minor lines — smaller = denser
const GRID_SPACING = 16;
const GRID_MAJOR_EVERY = 4;

export type ViewState = {
	x: number;
	y: number;
	zoom: number;
	rotation: number;
};

/** Stamp brushes (pen / airbrush) vs path-fill tool (lasso). */
export type BrushKind = 'pen' | 'airbrush' | 'lasso';

export type GpuPaint = {
	docW: number;
	docH: number;
	resize: (cssW: number, cssH: number) => void;
	setBrush: (brush: BrushKind) => void;
	beginStroke: () => void;
	endStroke: (opacity: number) => void;
	/** Discard in-progress stroke without compositing or undo entry. */
	cancelStroke: () => void;
	undo: () => boolean;
	redo: () => boolean;
	canUndo: () => boolean;
	canRedo: () => boolean;
	addSample: (
		x: number,
		y: number,
		brushDiameter: number,
		sizePressure: number,
		opacityPressure: number,
		color: string,
		spacingFactor?: number
	) => void;
	flushStamps: (color: string) => void;
	present: (view: ViewState, cssW: number, cssH: number, opacity: number, strokeActive: boolean) => void;
	destroy: () => void;
};

function parseColor(hex: string): [number, number, number] {
	const h = hex.replace('#', '');
	const full =
		h.length === 3
			? h
					.split('')
					.map((c) => c + c)
					.join('')
			: h;
	const n = Number.parseInt(full, 16);
	return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/**
 * Krita Creamy Alpha Darken flow — how fast dabs fill toward the stroke
 * opacity cap (see KoCompositeOpAlphaDarken + KoAlphaDarkenParamsWrapperCreamy).
 */
const AIRBRUSH_FLOW = 0.4;

/** Hard round tip with ~1px AA — reads like a pen, not an airbrush. */
function makeHardBrushPixels(size: number): Uint8Array {
	const pixels = new Uint8Array(size * size * 4);
	const aa = 1.25 / size;
	for (let y = 0; y < size; y++) {
		for (let x = 0; x < size; x++) {
			const dx = (x + 0.5) / size - 0.5;
			const dy = (y + 0.5) / size - 0.5;
			const r = Math.hypot(dx, dy) * 2; // 0 center → 1 at edge
			const a = r >= 1 ? 0 : r > 1 - aa ? (1 - r) / aa : 1;
			const i = (y * size + x) * 4;
			pixels[i] = 255;
			pixels[i + 1] = 255;
			pixels[i + 2] = 255;
			pixels[i + 3] = Math.round(a * 255);
		}
	}
	return pixels;
}

/** Even-odd fill of a closed polygon into a tight AABB (premultiplied RGBA). */
function rasterizePolygonEvenOdd(
	points: { x: number; y: number }[],
	bounds: { x: number; y: number; w: number; h: number },
	r: number,
	g: number,
	b: number
): Uint8Array {
	const { x: bx, y: by, w, h } = bounds;
	const pixels = new Uint8Array(w * h * 4);
	const n = points.length;
	const pr = Math.round(r * 255);
	const pg = Math.round(g * 255);
	const pb = Math.round(b * 255);

	for (let row = 0; row < h; row++) {
		const y = by + row + 0.5;
		const xs: number[] = [];
		for (let i = 0; i < n; i++) {
			const a = points[i]!;
			const c = points[(i + 1) % n]!;
			if (a.y === c.y) continue;
			if ((a.y > y) === (c.y > y)) continue;
			const t = (y - a.y) / (c.y - a.y);
			xs.push(a.x + t * (c.x - a.x));
		}
		xs.sort((u, v) => u - v);
		for (let k = 0; k + 1 < xs.length; k += 2) {
			const x0 = Math.max(bx, Math.floor(xs[k]!));
			const x1 = Math.min(bx + w, Math.ceil(xs[k + 1]!));
			for (let x = x0; x < x1; x++) {
				const i = (row * w + (x - bx)) * 4;
				pixels[i] = pr;
				pixels[i + 1] = pg;
				pixels[i + 2] = pb;
				pixels[i + 3] = 255;
			}
		}
	}
	return pixels;
}

function appendStamp(
	out: Float32Array,
	offset: number,
	x: number,
	y: number,
	size: number,
	sizePressure: number,
	opacityPressure: number
) {
	let o = offset;
	for (const [cx, cy] of CORNERS) {
		out[o++] = x;
		out[o++] = y;
		out[o++] = cx;
		out[o++] = cy;
		out[o++] = size;
		out[o++] = sizePressure;
		out[o++] = opacityPressure;
	}
	return o;
}

function webGpuUnavailableMessage(): string {
	if (typeof isSecureContext !== 'undefined' && !isSecureContext) {
		return 'WebGPU needs a secure context. http://192.168.x.x will not work on iPad — use HTTPS, or open via localhost on the same device.';
	}
	return 'WebGPU is not available here. On iPad it needs iPadOS 26+ (Safari 26); feature flags on older versions usually do not expose navigator.gpu.';
}

export async function createGpuPaint(canvas: HTMLCanvasElement): Promise<GpuPaint> {
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

	const docTex = root
		.createTexture({ size: [DOC_W, DOC_H], format: 'rgba8unorm' })
		.$usage('sampled', 'render');
	const strokeTex = root
		.createTexture({ size: [DOC_W, DOC_H], format: 'rgba8unorm' })
		.$usage('sampled', 'render');
	/** Ping-pong target for Krita Alpha Darken airbrush dabs (sample strokeTex, write here). */
	const strokeTexB = root
		.createTexture({ size: [DOC_W, DOC_H], format: 'rgba8unorm' })
		.$usage('sampled', 'render');
	const brushTex = root
		.createTexture({ size: [BRUSH_SIZE, BRUSH_SIZE], format: 'rgba8unorm' })
		.$usage('sampled');

	const hardTipPixels = makeHardBrushPixels(BRUSH_SIZE);
	brushTex.write(hardTipPixels);

	const docView = docTex.createView();
	const strokeView = strokeTex.createView();
	const brushView = brushTex.createView();
	const docRenderView = docTex.createView('render');
	const strokeRenderView = strokeTex.createView('render');
	const strokeRenderViewB = strokeTexB.createView('render');

	const linearSamp = root.createSampler({ magFilter: 'linear', minFilter: 'linear' });

	const strokeUniforms = root.createUniform(StrokeUniforms, {
		resolution: [DOC_W, DOC_H],
		color: [0, 0, 0, 1]
	});
	const airbrushUniforms = root.createUniform(AirbrushUniforms, {
		resolution: [DOC_W, DOC_H],
		color: [0, 0, 0],
		flow: AIRBRUSH_FLOW,
		averageOpacity: 0
	});
	const compositeUniforms = root.createUniform(CompositeUniforms, { opacity: 1 });
	const presentUniforms = root.createUniform(PresentUniforms, {
		m0: [1, 0, 0],
		m1: [0, 1, 0],
		m2: [0, 0, 1],
		strokeOpacity: 1,
		strokeActive: 0,
		docSize: [DOC_W, DOC_H]
	});
	const gridUniforms = root.createUniform(GridUniforms, {
		cssSize: [1, 1],
		spacing: GRID_SPACING
	});

	const stampLayout = tgpu.vertexLayout(d.disarrayOf(StampVertex));
	const vertexBuf = root
		.createBuffer(stampLayout.schemaForCount(MAX_STAMPS_PER_FLUSH * VERTS_PER_STAMP))
		.$usage('vertex');
	const vertexCpu = new Float32Array(MAX_VERT_FLOATS);

	const strokeVertex = tgpu.vertexFn({
		in: {
			pos: d.vec2f,
			corner: d.vec2f,
			size: d.f32,
			sizePressure: d.f32,
			opacityPressure: d.f32
		},
		out: {
			position: d.builtin.position,
			uv: d.vec2f,
			opacityPressure: d.f32
		}
	})((input) => {
		'use gpu';
		const half = input.size * 0.5 * input.sizePressure;
		const pixel = input.pos + input.corner * half;
		const clip = (pixel / strokeUniforms.$.resolution) * d.vec2f(2, -2) + d.vec2f(-1, 1);
		return {
			position: d.vec4f(clip, 0, 1),
			uv: input.corner * 0.5 + 0.5,
			opacityPressure: input.opacityPressure
		};
	});

	const strokeFragment = tgpu.fragmentFn({
		in: { uv: d.vec2f, opacityPressure: d.f32 },
		out: d.vec4f
	})((input) => {
		'use gpu';
		const mask = std.textureSample(brushView.$, linearSamp.$, input.uv).a;
		const color = d.vec4f(strokeUniforms.$.color);
		const a = mask * color.a * input.opacityPressure;
		return d.vec4f(color.rgb * a, a);
	});

	/** Airbrush dab vertex — also passes doc UVs to sample the stroke buffer. */
	const airbrushVertex = tgpu.vertexFn({
		in: {
			pos: d.vec2f,
			corner: d.vec2f,
			size: d.f32,
			sizePressure: d.f32,
			opacityPressure: d.f32
		},
		out: {
			position: d.builtin.position,
			tipUv: d.vec2f,
			docUv: d.vec2f,
			opacityPressure: d.f32
		}
	})((input) => {
		'use gpu';
		const half = input.size * 0.5 * input.sizePressure;
		const pixel = input.pos + input.corner * half;
		const res = airbrushUniforms.$.resolution;
		const clip = (pixel / res) * d.vec2f(2, -2) + d.vec2f(-1, 1);
		return {
			position: d.vec4f(clip, 0, 1),
			tipUv: input.corner * 0.5 + 0.5,
			docUv: pixel / res,
			opacityPressure: input.opacityPressure
		};
	});

	/**
	 * Krita Creamy Alpha Darken into the stroke layer (wash).
	 * Never decreases alpha; soft tip fills toward opacity cap via flow.
	 * Same-color lock → premul C*newA (KoCompositeOpAlphaDarken.h).
	 */
	const airbrushFragment = tgpu.fragmentFn({
		in: { tipUv: d.vec2f, docUv: d.vec2f, opacityPressure: d.f32 },
		out: d.vec4f
	})((input) => {
		'use gpu';
		const u = airbrushUniforms.$;
		const dst = std.textureSample(strokeView.$, linearSamp.$, input.docUv);
		const dstA = dst.a;

		const delta = input.tipUv - d.vec2f(0.5);
		const r = std.length(delta) * 2;
		const t = std.max(1 - r, 0);
		const msk = t * t * (3 - 2 * t);

		const opacity = input.opacityPressure;
		const flow = u.flow;
		const averageOpacity = u.averageOpacity;
		const srcAlpha = msk * opacity;

		// KoCompositeOpAlphaDarken::calculateAlpha (Creamy wrapper)
		const avgSafe = std.max(averageOpacity, 1e-5);
		const fullWhenAvgHigh = std.select(
			dstA,
			std.mix(srcAlpha, averageOpacity, dstA / avgSafe),
			averageOpacity > dstA
		);
		const fullWhenOpHigh = std.select(dstA, std.mix(dstA, opacity, msk), opacity > dstA);
		const fullFlowAlpha = std.select(fullWhenOpHigh, fullWhenAvgHigh, averageOpacity > opacity);
		const newA = std.mix(dstA, fullFlowAlpha, flow);
		const C = u.color;
		return d.vec4f(C * newA, newA);
	});

	const compositeFragment = tgpu.fragmentFn({
		in: { uv: d.vec2f },
		out: d.vec4f
	})((input) => {
		'use gpu';
		const s = std.textureSample(strokeView.$, linearSamp.$, input.uv);
		const opacity = compositeUniforms.$.opacity;
		return d.vec4f(s.rgb * opacity, s.a * opacity);
	});

	const presentVertex = tgpu.vertexFn({
		in: { vertexIndex: d.builtin.vertexIndex },
		out: { position: d.builtin.position, uv: d.vec2f }
	})((input) => {
		'use gpu';
		const vi = input.vertexIndex;
		const x = std.select(0, 1, vi === 1 || vi === 2 || vi === 4);
		const y = std.select(0, 1, vi === 2 || vi === 4 || vi === 5);
		const u = presentUniforms.$;
		const doc = d.vec3f(x * u.docSize.x, y * u.docSize.y, 1);
		return {
			position: d.vec4f(std.dot(u.m0, doc), std.dot(u.m1, doc), 0, 1),
			uv: d.vec2f(x, y)
		};
	});

	const presentFragment = tgpu.fragmentFn({
		in: { uv: d.vec2f },
		out: d.vec4f
	})((input) => {
		'use gpu';
		const u = presentUniforms.$;
		const docSample = std.textureSample(docView.$, linearSamp.$, input.uv);
		const strokeSample = std.textureSample(strokeView.$, linearSamp.$, input.uv);
		const factor = u.strokeOpacity * u.strokeActive;
		const a = strokeSample.a * factor;
		const rgb = strokeSample.rgb * factor + docSample.rgb * (1 - a);
		return d.vec4f(rgb, 1);
	});

	const gridFragment = tgpu.fragmentFn({
		in: { uv: d.vec2f },
		out: d.vec4f
	})((input) => {
		'use gpu';
		const u = gridUniforms.$;
		const sx = input.uv.x * u.cssSize.x;
		const sy = input.uv.y * u.cssSize.y;

		const spacing = u.spacing;
		const majorSpacing = spacing * GRID_MAJOR_EVERY;
		const fx = std.fract(sx / spacing);
		const fy = std.fract(sy / spacing);
		const dx = std.min(fx, 1 - fx) * spacing;
		const dy = std.min(fy, 1 - fy) * spacing;
		const dist = std.min(dx, dy);

		const mfx = std.fract(sx / majorSpacing);
		const mfy = std.fract(sy / majorSpacing);
		const mdx = std.min(mfx, 1 - mfx) * majorSpacing;
		const mdy = std.min(mfy, 1 - mfy) * majorSpacing;
		const majorDist = std.min(mdx, mdy);

		const half = 0.6;
		const minor = 1 - std.smoothstep(0, half, dist);
		const major = 1 - std.smoothstep(0, half * 1.25, majorDist);

		const bg = d.vec3f(GRID_BG[0], GRID_BG[1], GRID_BG[2]);
		const minorCol = d.vec3f(GRID_LINE[0], GRID_LINE[1], GRID_LINE[2]);
		const majorCol = d.vec3f(GRID_MAJOR[0], GRID_MAJOR[1], GRID_MAJOR[2]);
		const withMinor = std.mix(bg, minorCol, minor);
		const rgb = std.mix(withMinor, majorCol, major);
		return d.vec4f(rgb, 1);
	});

	const strokeWashPipeline = root
		.createRenderPipeline({
			attribs: { ...stampLayout.attrib },
			vertex: strokeVertex,
			fragment: strokeFragment,
			targets: {
				format: 'rgba8unorm',
				// Krita "wash": dabs take max coverage instead of stacking.
				blend: {
					color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
					alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' }
				}
			},
			primitive: { topology: 'triangle-list' }
		})
		.with(stampLayout, vertexBuf);

	/** Alpha Darken writes absolute premul coverage — replace, no GPU blend. */
	const strokeAirbrushPipeline = root
		.createRenderPipeline({
			attribs: { ...stampLayout.attrib },
			vertex: airbrushVertex,
			fragment: airbrushFragment,
			targets: {
				format: 'rgba8unorm',
				blend: {
					color: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' },
					alpha: { srcFactor: 'one', dstFactor: 'zero', operation: 'add' }
				}
			},
			primitive: { topology: 'triangle-list' }
		})
		.with(stampLayout, vertexBuf);

	const compositePipeline = root.createRenderPipeline({
		vertex: common.fullScreenTriangle,
		fragment: compositeFragment,
		targets: {
			format: 'rgba8unorm',
			blend: {
				color: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
				alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' }
			}
		},
		primitive: { topology: 'triangle-list' }
	});

	const gridPipeline = root.createRenderPipeline({
		vertex: common.fullScreenTriangle,
		fragment: gridFragment,
		targets: { format },
		primitive: { topology: 'triangle-list' }
	});

	const presentPipeline = root.createRenderPipeline({
		vertex: presentVertex,
		fragment: presentFragment,
		targets: { format },
		primitive: { topology: 'triangle-list' }
	});

	// White document background (Texture.clear is zero-fill only).
	docTex.write(new Uint8Array(DOC_W * DOC_H * 4).fill(255));
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

	/** Integer pixel AABB of the current stroke (expanded by brush radius). */
	type Rect = { x: number; y: number; w: number; h: number };
	type PatchTex = ReturnType<typeof createPatchTex>;
	/** One undoable stroke: dirty-rect before/after patches. */
	type StrokeEntry = { bounds: Rect; prev: PatchTex; after: PatchTex };

	const undoStack: StrokeEntry[] = [];
	const redoStack: StrokeEntry[] = [];

	let strokeMinX = 0;
	let strokeMinY = 0;
	let strokeMaxX = 0;
	let strokeMaxY = 0;
	let strokeHasBounds = false;

	function resetStrokeBounds() {
		strokeHasBounds = false;
	}

	function expandStrokeBounds(x: number, y: number, radius: number) {
		const pad = Math.ceil(radius) + 1; // +1 for AA fringe
		const minX = x - pad;
		const minY = y - pad;
		const maxX = x + pad;
		const maxY = y + pad;
		if (!strokeHasBounds) {
			strokeMinX = minX;
			strokeMinY = minY;
			strokeMaxX = maxX;
			strokeMaxY = maxY;
			strokeHasBounds = true;
			return;
		}
		strokeMinX = Math.min(strokeMinX, minX);
		strokeMinY = Math.min(strokeMinY, minY);
		strokeMaxX = Math.max(strokeMaxX, maxX);
		strokeMaxY = Math.max(strokeMaxY, maxY);
	}

	function finalizeStrokeBounds(): Rect | null {
		if (!strokeHasBounds) return null;
		const x0 = Math.max(0, Math.floor(strokeMinX));
		const y0 = Math.max(0, Math.floor(strokeMinY));
		const x1 = Math.min(DOC_W, Math.ceil(strokeMaxX));
		const y1 = Math.min(DOC_H, Math.ceil(strokeMaxY));
		const w = x1 - x0;
		const h = y1 - y0;
		if (w < 1 || h < 1) return null;
		return { x: x0, y: y0, w, h };
	}

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

	function spacingFor(size: number, spacingFactor: number) {
		return Math.max(0.25, size * spacingFactor);
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
		expandStrokeBounds(x, y, radius);
		const offset = stampCount * VERTS_PER_STAMP * FLOATS_PER_VERT;
		appendStamp(vertexCpu, offset, x, y, size, sizePressure, opacityPressure);
		stampCount++;
	}

	function blendAverageOpacity(opacity: number, avg: number) {
		// KisPainter::blendAverageOpacity
		if (avg < opacity) return opacity;
		return 0.1 * opacity + 0.9 * avg;
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
			resolution: [DOC_W, DOC_H],
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
			const x1 = Math.min(DOC_W, Math.ceil(x + pad));
			const y1 = Math.min(DOC_H, Math.ceil(y + pad));
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
				resolution: [DOC_W, DOC_H],
				color: [r, g, b],
				flow: AIRBRUSH_FLOW,
				averageOpacity
			});

			strokeAirbrushPipeline
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
		const bounds = finalizeStrokeBounds();
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
		compositePipeline
			.withColorAttachment({
				view: docRenderView,
				loadOp: 'load',
				storeOp: 'store'
			})
			.draw(3);
	}

	return {
		docW: DOC_W,
		docH: DOC_H,

		resize(cssW: number, cssH: number) {
			if (destroyed) return;
			const dpr = devicePixelRatio || 1;
			canvas.width = Math.max(1, Math.round(cssW * dpr));
			canvas.height = Math.max(1, Math.round(cssH * dpr));
			root.configureContext({ canvas, format, alphaMode: 'opaque' });
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
			resetStrokeBounds();
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
					resetStrokeBounds();
					return;
				}
			} else {
				paintStampsToStroke(lastColor);
			}

			const bounds = finalizeStrokeBounds();
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
			resetStrokeBounds();
		},

		cancelStroke() {
			if (destroyed) return;
			stampCount = 0;
			lastStamp = null;
			averageOpacity = 0;
			lassoPoints.length = 0;
			strokeTex.clear();
			strokeTexB.clear();
			resetStrokeBounds();
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
					expandStrokeBounds(x, y, 1);
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

		present(view: ViewState, cssW: number, cssH: number, opacity: number, strokeActive: boolean) {
			if (destroyed || cssW < 1 || cssH < 1) return;

			const cos = Math.cos(view.rotation);
			const sin = Math.sin(view.rotation);
			const zx = view.zoom;
			const zy = view.zoom;
			// doc px -> screen css px
			// p' = R * S * (p - center) + screenCenter + pan
			const cx = DOC_W / 2;
			const cy = DOC_H / 2;
			const a = cos * zx;
			const b = -sin * zy;
			const c = sin * zx;
			const dMat = cos * zy;
			const tx = -a * cx - b * cy + cssW / 2 + view.x;
			const ty = -c * cx - dMat * cy + cssH / 2 + view.y;
			// screen css -> clip: x_c = sx/cssW*2-1, y_c = 1-sy/cssH*2
			const sx = 2 / cssW;
			const sy = -2 / cssH;
			// clip = T_clip * T_screen
			const m00 = sx * a;
			const m01 = sx * b;
			const m02 = sx * tx - 1;
			const m10 = sy * c;
			const m11 = sy * dMat;
			const m12 = sy * ty + 1;

			presentUniforms.write({
				m0: [m00, m01, m02],
				m1: [m10, m11, m12],
				m2: [0, 0, 1],
				strokeOpacity: opacity,
				strokeActive: strokeActive ? 1 : 0,
				docSize: [DOC_W, DOC_H]
			});

			gridUniforms.write({
				cssSize: [cssW, cssH],
				spacing: GRID_SPACING
			});

			gridPipeline
				.withColorAttachment({
					view: context,
					clearValue: [GRID_BG[0], GRID_BG[1], GRID_BG[2], 1],
					loadOp: 'clear',
					storeOp: 'store'
				})
				.draw(3);

			presentPipeline
				.withColorAttachment({
					view: context,
					loadOp: 'load',
					storeOp: 'store'
				})
				.draw(6);
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

export { DOC_W, DOC_H };

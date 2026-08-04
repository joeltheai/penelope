import tgpu, { d, std, common } from 'typegpu';

const DOC_W = 2000;
const DOC_H = 2000;
const BRUSH_SIZE = 128;
const MAX_STAMPS_PER_FLUSH = 4096;
const FLOATS_PER_VERT = 7;
const VERTS_PER_STAMP = 6;
const MAX_VERT_FLOATS = MAX_STAMPS_PER_FLUSH * VERTS_PER_STAMP * FLOATS_PER_VERT;
/** Max completed strokes kept for undo (~16 MB RGBA each). Keep this low for mobile GPU memory. */
const MAX_HISTORY = 12;
/** Warm textures retained for reuse; anything beyond this is destroyed. */
const MAX_HISTORY_POOL = 2;

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

export type GpuPaint = {
	docW: number;
	docH: number;
	resize: (cssW: number, cssH: number) => void;
	beginStroke: () => void;
	endStroke: (opacity: number) => void;
	/** Snapshot the document before the next stroke is committed. Clears redo. */
	checkpoint: () => void;
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

/** Hard round tip with ~1px AA — reads like a pen, not an airbrush. */
function makeBrushPixels(size: number): Uint8Array {
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
	const brushTex = root
		.createTexture({ size: [BRUSH_SIZE, BRUSH_SIZE], format: 'rgba8unorm' })
		.$usage('sampled');

	brushTex.write(makeBrushPixels(BRUSH_SIZE));

	const docView = docTex.createView();
	const strokeView = strokeTex.createView();
	const brushView = brushTex.createView();
	const docRenderView = docTex.createView('render');
	const strokeRenderView = strokeTex.createView('render');

	const linearSamp = root.createSampler({ magFilter: 'linear', minFilter: 'linear' });

	const strokeUniforms = root.createUniform(StrokeUniforms, {
		resolution: [DOC_W, DOC_H],
		color: [0, 0, 0, 1]
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

	const strokePipeline = root
		.createRenderPipeline({
			attribs: { ...stampLayout.attrib },
			vertex: strokeVertex,
			fragment: strokeFragment,
			targets: {
				format: 'rgba8unorm',
				// Krita "wash" / stroke opacity: dabs take max coverage instead of
				// stacking (source-over). Crossing yourself in one stroke won't
				// keep darkening — only a new stroke after lift can layer.
				blend: {
					color: { srcFactor: 'one', dstFactor: 'one', operation: 'max' },
					alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'max' }
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

	let stampCount = 0;
	let lastStamp: {
		x: number;
		y: number;
		sizePressure: number;
		opacityPressure: number;
	} | null = null;
	let lastColor = '#000000';
	let destroyed = false;

	type HistoryTex = typeof docTex;
	const historyPool: HistoryTex[] = [];
	const undoStack: HistoryTex[] = [];
	const redoStack: HistoryTex[] = [];

	function createHistoryTex(): HistoryTex {
		return root
			.createTexture({ size: [DOC_W, DOC_H], format: 'rgba8unorm' })
			.$usage('sampled', 'render');
	}

	function acquireHistoryTex(): HistoryTex {
		return historyPool.pop() ?? createHistoryTex();
	}

	function releaseHistoryTex(tex: HistoryTex) {
		if (historyPool.length >= MAX_HISTORY_POOL) {
			tex.destroy();
			return;
		}
		historyPool.push(tex);
	}

	function clearRedoStack() {
		while (redoStack.length > 0) {
			releaseHistoryTex(redoStack.pop()!);
		}
	}

	function trimUndoStack() {
		while (undoStack.length > MAX_HISTORY) {
			releaseHistoryTex(undoStack.shift()!);
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
		const offset = stampCount * VERTS_PER_STAMP * FLOATS_PER_VERT;
		appendStamp(vertexCpu, offset, x, y, size, sizePressure, opacityPressure);
		stampCount++;
	}

	function paintStampsToStroke(color: string) {
		if (destroyed || stampCount === 0) return;

		const floats = stampCount * VERTS_PER_STAMP * FLOATS_PER_VERT;
		vertexBuf.write(vertexCpu.buffer.slice(0, floats * 4));

		const [r, g, b] = parseColor(color);
		strokeUniforms.write({
			resolution: [DOC_W, DOC_H],
			color: [r, g, b, 1]
		});

		strokePipeline
			.withColorAttachment({
				view: strokeRenderView,
				loadOp: 'load',
				storeOp: 'store'
			})
			.draw(stampCount * VERTS_PER_STAMP);
		stampCount = 0;
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

		beginStroke() {
			if (destroyed) return;
			strokeTex.clear();
			lastStamp = null;
			stampCount = 0;
		},

		endStroke(opacity: number) {
			if (destroyed) return;
			paintStampsToStroke(lastColor);

			compositeUniforms.write({ opacity });
			compositePipeline
				.withColorAttachment({
					view: docRenderView,
					loadOp: 'load',
					storeOp: 'store'
				})
				.draw(3);

			strokeTex.clear();
			lastStamp = null;
			stampCount = 0;
		},

		checkpoint() {
			if (destroyed) return;
			clearRedoStack();
			const snap = acquireHistoryTex();
			snap.copyFrom(docTex);
			undoStack.push(snap);
			trimUndoStack();
		},

		undo() {
			if (destroyed || undoStack.length === 0) return false;
			const current = acquireHistoryTex();
			current.copyFrom(docTex);
			redoStack.push(current);
			const prev = undoStack.pop()!;
			docTex.copyFrom(prev);
			releaseHistoryTex(prev);
			return true;
		},

		redo() {
			if (destroyed || redoStack.length === 0) return false;
			const current = acquireHistoryTex();
			current.copyFrom(docTex);
			undoStack.push(current);
			trimUndoStack();
			const next = redoStack.pop()!;
			docTex.copyFrom(next);
			releaseHistoryTex(next);
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
			for (const tex of undoStack) tex.destroy();
			for (const tex of redoStack) tex.destroy();
			for (const tex of historyPool) tex.destroy();
			undoStack.length = 0;
			redoStack.length = 0;
			historyPool.length = 0;
			root.destroy();
		}
	};
}

export { DOC_W, DOC_H };

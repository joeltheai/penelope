import type { LassoOptions, Rect } from './types';
import { PULL_STAMPS, PULL_STAMPS_SPLAT } from './lassoShapes';

export type Point = { x: number; y: number };

export const DEFAULT_LASSO_OPTIONS: LassoOptions = {
	mode: 'fill',
	splat: false
};

type PullStamp = {
	x: number;
	y: number;
	scale: number;
	angleDeg: number;
	path: string;
};

/** Catmull-Rom line — cubic controls as samples arrive (≥4 raw pts). */
class CatmullLine {
	private path: Point[] = [];
	private tension = 1;

	add(x: number, y: number) {
		this.path.push({ x, y });
	}

	clear() {
		this.path.length = 0;
	}

	get isDrawable() {
		return this.path.length >= 4;
	}

	get tip(): Point | null {
		return this.isDrawable ? this.path[this.path.length - 1]! : null;
	}

	get points(): readonly Point[] {
		return this.path;
	}

	get curveTension(): number {
		return this.tension;
	}
}

function expandRect(a: Rect | null, x0: number, y0: number, x1: number, y1: number): Rect {
	if (!a) {
		return {
			x: Math.floor(x0),
			y: Math.floor(y0),
			w: Math.max(1, Math.ceil(x1) - Math.floor(x0)),
			h: Math.max(1, Math.ceil(y1) - Math.floor(y0))
		};
	}
	const minX = Math.min(a.x, Math.floor(x0));
	const minY = Math.min(a.y, Math.floor(y0));
	const maxX = Math.max(a.x + a.w, Math.ceil(x1));
	const maxY = Math.max(a.y + a.h, Math.ceil(y1));
	return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function clampRect(r: Rect, docW: number, docH: number): Rect | null {
	const x0 = Math.max(0, r.x);
	const y0 = Math.max(0, r.y);
	const x1 = Math.min(docW, r.x + r.w);
	const y1 = Math.min(docH, r.y + r.h);
	const w = x1 - x0;
	const h = y1 - y0;
	if (w < 1 || h < 1) return null;
	return { x: x0, y: y0, w, h };
}

function parseHex(hex: string) {
	const h = hex.replace('#', '');
	const full =
		h.length === 3
			? h
					.split('')
					.map((c) => c + c)
					.join('')
			: h;
	const n = Number.parseInt(full, 16);
	return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function premulCopy(src: Uint8ClampedArray, w: number, h: number, dst: Uint8Array) {
	for (let i = 0; i < w * h; i++) {
		const o = i * 4;
		const a = src[o + 3]! / 255;
		dst[o] = Math.round(src[o]! * a);
		dst[o + 1] = Math.round(src[o + 1]! * a);
		dst[o + 2] = Math.round(src[o + 2]! * a);
		dst[o + 3] = src[o + 3]!;
	}
}

/** Cap splat kick so dirty AABBs stay small. */
const SPLAT_MAX_DISPLACE = 28;
export const MAX_LASSO_EDGES = 32_768;
const FLOATS_PER_VERTEX = 3;
const VERTICES_PER_EDGE = 3;

export type LassoSampleResult = {
	kind: 'pixels';
	pixels: Uint8Array;
	bounds: Rect;
	hasContent: boolean;
};

export type LassoFillBatch = {
	kind: 'fill';
	vertices: Float32Array;
	vertexCount: number;
	bounds: Rect;
};

export type LassoResult = LassoSampleResult | LassoFillBatch;

/** GPU geometry for closed fill; pull-shapes retain incremental Canvas rasterization. */
export function createLassoEngine(docW: number, docH: number) {
	let opts: LassoOptions = { ...DEFAULT_LASSO_OPTIONS };
	let color = '#000000';
	const paintAlpha = 1;

	let canvas: OffscreenCanvas | null = null;
	let ctx: OffscreenCanvasRenderingContext2D | null = null;

	const catmull = new CatmullLine();
	let lastRaw: Point | null = null;
	const pulls: PullStamp[] = [];
	let union: Rect | null = null;
	let hasContent = false;
	let fillDirty = false;
	const fillVertices = new Float32Array(MAX_LASSO_EDGES * VERTICES_PER_EDGE * FLOATS_PER_VERTEX);
	const fillPoints = new Float32Array(MAX_LASSO_EDGES * 2);

	const SMOOTH = 0.8;

	function resize(nextW: number, nextH: number) {
		docW = nextW;
		docH = nextH;
		if (canvas) {
			canvas.width = nextW;
			canvas.height = nextH;
		}
		reset();
	}

	function pullContext(): OffscreenCanvasRenderingContext2D {
		if (!canvas || !ctx) {
			canvas = new OffscreenCanvas(docW, docH);
			ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true })!;
			ctx.imageSmoothingEnabled = true;
		}
		return ctx;
	}

	function setOptions(next: Partial<LassoOptions>) {
		if (next.mode !== undefined) opts.mode = next.mode;
		if (next.splat !== undefined) opts.splat = next.splat;
	}

	function reset() {
		catmull.clear();
		lastRaw = null;
		pulls.length = 0;
		union = null;
		hasContent = false;
		fillDirty = false;
		if (ctx) {
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.clearRect(0, 0, docW, docH);
		}
	}

	function begin(hex: string) {
		reset();
		color = hex;
	}

	function minDist(): number {
		if (opts.mode === 'pull') return Math.max(8, Math.min(docW, docH) / 100);
		if (opts.splat) return 7;
		return 2.5;
	}

	function addRawPoint(p: Point): boolean {
		if (!lastRaw) {
			catmull.add(p.x, p.y);
			lastRaw = p;
			return true;
		}
		const travel = Math.hypot(p.x - lastRaw.x, p.y - lastRaw.y);
		if (travel < minDist()) return false;

		let x: number;
		let y: number;
		if (opts.splat && opts.mode === 'fill') {
			const dx = p.x - lastRaw.x;
			const dy = p.y - lastRaw.y;
			const k = -(0.8 + Math.random() * 1.4);
			let ox = dx * k;
			let oy = dy * k;
			const mag = Math.hypot(ox, oy);
			if (mag > SPLAT_MAX_DISPLACE) {
				const s = SPLAT_MAX_DISPLACE / mag;
				ox *= s;
				oy *= s;
			}
			x = p.x + ox;
			y = p.y + oy;
		} else {
			x = lastRaw.x * (1 - SMOOTH) + p.x * SMOOTH;
			y = lastRaw.y * (1 - SMOOTH) + p.y * SMOOTH;
		}
		catmull.add(x, y);
		lastRaw = p;
		return true;
	}

	function makePull(x: number, y: number): PullStamp {
		const lib = opts.splat ? PULL_STAMPS_SPLAT : PULL_STAMPS;
		const path = lib[Math.floor(Math.random() * lib.length)] ?? lib[0]!;
		const scale = (0.1 + Math.random() * 2) * (Math.min(docW, docH) / 1200);
		return {
			x,
			y,
			scale,
			angleDeg: Math.floor(Math.random() * 360),
			path
		};
	}

	function pullLocalBounds(stamp: PullStamp): Rect {
		const extent = 110 * stamp.scale;
		return {
			x: Math.floor(stamp.x - extent),
			y: Math.floor(stamp.y - extent),
			w: Math.ceil(extent * 2),
			h: Math.ceil(extent * 2)
		};
	}

	function drawPull(stamp: PullStamp) {
		const context = pullContext();
		const { r, g, b } = parseHex(color);
		context.save();
		context.translate(stamp.x, stamp.y);
		context.scale(stamp.scale, stamp.scale);
		context.rotate((stamp.angleDeg / 180) * Math.PI);
		context.fillStyle = `rgba(${r},${g},${b},${paintAlpha})`;
		context.fill(new Path2D(stamp.path));
		context.restore();
	}

	function readDirty(bounds: Rect): LassoSampleResult {
		const img = pullContext().getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
		const pixels = new Uint8Array(bounds.w * bounds.h * 4);
		premulCopy(img.data, bounds.w, bounds.h, pixels);
		return { kind: 'pixels', pixels, bounds, hasContent };
	}

	function flattenFillCurve(): { pointCount: number; bounds: Rect } | null {
		const path = catmull.points;
		if (path.length < 4) return null;
		const subdivisions = opts.splat ? 3 : 4;
		const candidateCount = 1 + (path.length - 2) * subdivisions;
		const sampleStep = Math.max(1, Math.ceil(candidateCount / MAX_LASSO_EDGES));
		let candidateIndex = 0;
		let pointCount = 0;
		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;
		const emit = (x: number, y: number) => {
			x0 = Math.min(x0, x);
			y0 = Math.min(y0, y);
			x1 = Math.max(x1, x);
			y1 = Math.max(y1, y);
			if (candidateIndex % sampleStep === 0 && pointCount < MAX_LASSO_EDGES) {
				fillPoints[pointCount * 2] = x;
				fillPoints[pointCount * 2 + 1] = y;
				pointCount++;
			}
			candidateIndex++;
		};
		const emitCubic = (p0: Point, c1: Point, c2: Point, p3: Point, t: number) => {
			const u = 1 - t;
			const uu = u * u;
			const tt = t * t;
			emit(
				uu * u * p0.x + 3 * uu * t * c1.x + 3 * u * tt * c2.x + tt * t * p3.x,
				uu * u * p0.y + 3 * uu * t * c1.y + 3 * u * tt * c2.y + tt * t * p3.y
			);
		};

		emit(path[1]!.x, path[1]!.y);
		const tension = catmull.curveTension;
		for (let i = 0; i < path.length - 2; i++) {
			const p1 = path[i]!;
			const p2 = path[i + 1]!;
			const p3 = path[i + 2]!;
			const p4 = path[Math.min(path.length - 1, i + 3)]!;
			const c1 = {
				x: p2.x + (tension * p3.x - tension * p1.x) / 6,
				y: p2.y + (tension * p3.y - tension * p1.y) / 6
			};
			const c2 = {
				x: p3.x + (tension * p2.x - tension * p4.x) / 6,
				y: p3.y + (tension * p2.y - tension * p4.y) / 6
			};
			if (opts.splat) {
				emit(c1.x, c1.y);
				emit(c2.x, c2.y);
				emit(p3.x, p3.y);
			} else {
				// Four line segments closely approximate the Canvas cubic while keeping
				// geometry much smaller than a document-sized pixel upload.
				emitCubic(p2, c1, c2, p3, 0.25);
				emitCubic(p2, c1, c2, p3, 0.5);
				emitCubic(p2, c1, c2, p3, 0.75);
				emit(p3.x, p3.y);
			}
		}
		const bounds = clampRect(
			{
				x: Math.floor(x0 - 2),
				y: Math.floor(y0 - 2),
				w: Math.ceil(x1 - x0 + 4),
				h: Math.ceil(y1 - y0 + 4)
			},
			docW,
			docH
		);
		return bounds && pointCount >= 3 ? { pointCount, bounds } : null;
	}

	function buildFillBatch(): LassoFillBatch | null {
		const flattened = flattenFillCurve();
		if (!flattened) return null;
		const { pointCount, bounds } = flattened;
		const anchor = { x: bounds.x - 1, y: bounds.y - 1 };
		let vertexCount = 0;
		const writeVertex = (x: number, y: number) => {
			const offset = vertexCount * FLOATS_PER_VERTEX;
			fillVertices[offset] = x;
			fillVertices[offset + 1] = y;
			fillVertices[offset + 2] = 1;
			vertexCount++;
		};
		for (let edge = 0; edge < pointCount; edge++) {
			const next = (edge + 1) % pointCount;
			writeVertex(anchor.x, anchor.y);
			writeVertex(fillPoints[edge * 2]!, fillPoints[edge * 2 + 1]!);
			writeVertex(fillPoints[next * 2]!, fillPoints[next * 2 + 1]!);
		}

		union = bounds;
		hasContent = true;
		fillDirty = false;
		return {
			kind: 'fill',
			vertices: fillVertices.subarray(0, vertexCount * FLOATS_PER_VERTEX),
			vertexCount,
			bounds
		};
	}

	function sample(x: number, y: number, hex: string): LassoResult | null {
		color = hex;
		if (!addRawPoint({ x, y })) return null;

		if (opts.mode === 'pull') {
			const tip = catmull.tip;
			if (!tip) return null;
			if (pulls.length > 0 && Math.random() <= 0.5) return null;
			const stamp = makePull(tip.x, tip.y);
			pulls.push(stamp);
			drawPull(stamp);
			const clipped = clampRect(pullLocalBounds(stamp), docW, docH);
			if (!clipped) return null;
			union = expandRect(union, clipped.x, clipped.y, clipped.x + clipped.w, clipped.y + clipped.h);
			union = clampRect(union!, docW, docH);
			hasContent = true;
			return readDirty(clipped);
		}

		fillDirty = catmull.isDrawable;
		return null;
	}

	function flush(): LassoFillBatch | null {
		if (opts.mode !== 'fill') return null;
		if (!fillDirty) return null;
		return buildFillBatch();
	}

	function finalizeBounds(): Rect | null {
		return union ? clampRect(union, docW, docH) : null;
	}

	function hasDrawable(): boolean {
		return hasContent;
	}

	return {
		begin,
		sample,
		flush,
		reset,
		resize,
		setOptions,
		finalizeBounds,
		hasDrawable
	};
}

export type LassoEngine = ReturnType<typeof createLassoEngine>;

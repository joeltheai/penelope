import type { LassoOptions, Rect } from './types';
import { PULL_SHAPES, PULL_SHAPES_SPLAT } from './lassoShapes';

export type Point = { x: number; y: number };

export const DEFAULT_LASSO_OPTIONS: LassoOptions = {
	mode: 'fill',
	splat: false
};

type CurvePoint = Point & {
	c1?: Point;
	c2?: Point;
	c3?: Point;
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

	getPoints(): CurvePoint[] {
		if (this.path.length < 4) return [];
		const result: CurvePoint[] = [];
		const { path, tension } = this;
		for (let n = 0; n < path.length; n++) {
			const p1 = path[n]!;
			const p2 = path[Math.min(path.length - 1, n + 1)]!;
			const p3 = path[Math.min(path.length - 1, n + 2)]!;
			const p4 = path[Math.min(path.length - 1, n + 3)]!;
			if (n === 0) result[n] = { x: p2.x, y: p2.y };
			const cur = result[n]!;
			cur.c1 = {
				x: p2.x + (tension * p3.x - tension * p1.x) / 6,
				y: p2.y + (tension * p3.y - tension * p1.y) / 6
			};
			cur.c2 = {
				x: p3.x + (tension * p2.x - tension * p4.x) / 6,
				y: p3.y + (tension * p2.y - tension * p4.y) / 6
			};
			cur.c3 = { x: p3.x, y: p3.y };
			result[n + 1] = { x: p3.x, y: p3.y };
		}
		return result;
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

function parseHex(hex: string): { r: number; g: number; b: number } {
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
/** Don't redraw/upload closed fills more often than this (ms). */
const FILL_REDRAW_MS = 32;

export type LassoSampleResult = {
	pixels: Uint8Array;
	bounds: Rect;
	hasContent: boolean;
};

/** Closed-path fill / pull-shape lasso, rasterized via OffscreenCanvas. */
export function createLassoEngine(docW: number, docH: number) {
	let opts: LassoOptions = { ...DEFAULT_LASSO_OPTIONS };
	let color = '#000000';
	const paintAlpha = 1;

	const canvas = new OffscreenCanvas(docW, docH);
	const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true })!;
	ctx.imageSmoothingEnabled = true;

	const catmull = new CatmullLine();
	let lastRaw: Point | null = null;
	let curve: CurvePoint[] = [];
	const pulls: PullStamp[] = [];
	let union: Rect | null = null;
	let hasContent = false;
	let lastFillRedrawAt = 0;
	let fillDirty = false;

	const SMOOTH = 0.8;

	function resize(nextW: number, nextH: number) {
		docW = nextW;
		docH = nextH;
		canvas.width = nextW;
		canvas.height = nextH;
		reset();
	}

	function setOptions(next: Partial<LassoOptions>) {
		if (next.mode !== undefined) opts.mode = next.mode;
		if (next.splat !== undefined) opts.splat = next.splat;
	}

	function reset() {
		catmull.clear();
		lastRaw = null;
		curve = [];
		pulls.length = 0;
		union = null;
		hasContent = false;
		lastFillRedrawAt = 0;
		fillDirty = false;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, docW, docH);
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

	function pathBounds(pad: number): Rect | null {
		if (curve.length < 2) return null;
		let x0 = Infinity;
		let y0 = Infinity;
		let x1 = -Infinity;
		let y1 = -Infinity;
		const grow = (p: Point) => {
			x0 = Math.min(x0, p.x);
			y0 = Math.min(y0, p.y);
			x1 = Math.max(x1, p.x);
			y1 = Math.max(y1, p.y);
		};
		for (const p of curve) {
			grow(p);
			if (p.c1) grow(p.c1);
			if (p.c2) grow(p.c2);
			if (p.c3) grow(p.c3);
		}
		return clampRect(
			{
				x: Math.floor(x0 - pad),
				y: Math.floor(y0 - pad),
				w: Math.ceil(x1 - x0 + pad * 2),
				h: Math.ceil(y1 - y0 + pad * 2)
			},
			docW,
			docH
		);
	}

	function solidStyle() {
		const { r, g, b } = parseHex(color);
		ctx.fillStyle = `rgba(${r},${g},${b},${paintAlpha})`;
	}

	function drawClosedFillPath() {
		ctx.beginPath();
		for (let i = 0; i < curve.length - 2; i++) {
			const dat = curve[i]!;
			if (i === 0) ctx.moveTo(dat.x, dat.y);
			const c1 = dat.c1!;
			const c2 = dat.c2!;
			const c3 = dat.c3!;
			if (opts.splat) {
				ctx.lineTo(c1.x, c1.y);
				ctx.lineTo(c2.x, c2.y);
				ctx.lineTo(c3.x, c3.y);
			} else {
				ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, c3.x, c3.y);
			}
		}
		ctx.closePath();
		ctx.fill('evenodd');
	}

	function redrawClosedFill(): Rect | null {
		const prev = union;
		if (prev) ctx.clearRect(prev.x, prev.y, prev.w, prev.h);
		const next = pathBounds(2);
		if (!next) {
			union = null;
			return prev;
		}
		solidStyle();
		drawClosedFillPath();
		union = next;
		hasContent = true;
		fillDirty = false;
		lastFillRedrawAt = performance.now();
		if (prev) {
			return clampRect(
				expandRect(prev, next.x, next.y, next.x + next.w, next.y + next.h),
				docW,
				docH
			);
		}
		return next;
	}

	function tipOfCurve(): Point | null {
		if (curve.length < 1) return null;
		const last = curve[curve.length - 1]!;
		return { x: last.x, y: last.y };
	}

	function makePull(x: number, y: number): PullStamp {
		const lib = opts.splat ? PULL_SHAPES_SPLAT : PULL_SHAPES;
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
		const { r, g, b } = parseHex(color);
		ctx.save();
		ctx.translate(stamp.x, stamp.y);
		ctx.scale(stamp.scale, stamp.scale);
		ctx.rotate((stamp.angleDeg / 180) * Math.PI);
		ctx.fillStyle = `rgba(${r},${g},${b},${paintAlpha})`;
		ctx.fill(new Path2D(stamp.path));
		ctx.restore();
	}

	function readDirty(bounds: Rect): LassoSampleResult {
		const img = ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
		const pixels = new Uint8Array(bounds.w * bounds.h * 4);
		premulCopy(img.data, bounds.w, bounds.h, pixels);
		return { pixels, bounds, hasContent };
	}

	function maybeRedrawClosedFill(force: boolean): LassoSampleResult | null {
		if (curve.length < 3) return null;
		const now = performance.now();
		if (!force && now - lastFillRedrawAt < FILL_REDRAW_MS) {
			fillDirty = true;
			return null;
		}
		const dirty = redrawClosedFill();
		if (!dirty) return null;
		return readDirty(dirty);
	}

	function sample(x: number, y: number, hex: string): LassoSampleResult | null {
		color = hex;
		if (!addRawPoint({ x, y })) return null;

		curve = catmull.getPoints();

		if (opts.mode === 'pull') {
			if (curve.length < 2) return null;
			if (pulls.length > 0 && Math.random() <= 0.5) return null;
			const tip = tipOfCurve()!;
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

		return maybeRedrawClosedFill(false);
	}

	function flush(): LassoSampleResult | null {
		if (opts.mode !== 'fill') return null;
		if (!fillDirty && hasContent) return null;
		return maybeRedrawClosedFill(true);
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

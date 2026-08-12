import type { Rect } from './types';

export type Point = { x: number; y: number };

export type FanKind = 'fan' | 'fanFade';

export type FanSampleResult = {
	pixels: Uint8Array;
	bounds: Rect;
	hasContent: boolean;
};

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

const SMOOTH = 0.75;
const MIN_DIST = 3;

/**
 * Fan / Fan Fade — triangles from stroke origin to consecutive path points.
 * Layout matches fan stroke verts: origin UV (0.5,1), tips (0,0)/(1,0).
 * Fade is opaque at the origin and transparent at the outer edge.
 * Drawing is additive (new triangles layer on prior ones; stroke never clears).
 */
export function createFanEngine(docW: number, docH: number, kind: FanKind) {
	let color = '#000000';
	const canvas = new OffscreenCanvas(docW, docH);
	const ctx = canvas.getContext('2d', { alpha: true, willReadFrequently: true })!;
	ctx.imageSmoothingEnabled = true;

	const points: Point[] = [];
	let lastRaw: Point | null = null;
	let union: Rect | null = null;
	let hasContent = false;

	function resize(nextW: number, nextH: number) {
		docW = nextW;
		docH = nextH;
		canvas.width = nextW;
		canvas.height = nextH;
		reset();
	}

	function reset() {
		points.length = 0;
		lastRaw = null;
		union = null;
		hasContent = false;
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, docW, docH);
	}

	function begin(hex: string) {
		reset();
		color = hex;
	}

	function setKind(next: FanKind) {
		kind = next;
	}

	function drawTriangle(origin: Point, a: Point, b: Point): Rect | null {
		const { r, g, b: bb } = parseHex(color);
		if (kind === 'fan') {
			ctx.fillStyle = `rgba(${r},${g},${bb},1)`;
		} else {
			const mx = (a.x + b.x) * 0.5;
			const my = (a.y + b.y) * 0.5;
			const grad = ctx.createLinearGradient(origin.x, origin.y, mx, my);
			grad.addColorStop(0, `rgba(${r},${g},${bb},1)`);
			grad.addColorStop(0.35, `rgba(${r},${g},${bb},0.85)`);
			grad.addColorStop(1, `rgba(${r},${g},${bb},0)`);
			ctx.fillStyle = grad;
		}
		ctx.beginPath();
		ctx.moveTo(origin.x, origin.y);
		ctx.lineTo(a.x, a.y);
		ctx.lineTo(b.x, b.y);
		ctx.closePath();
		ctx.fill();

		const pad = 2;
		let rect = expandRect(null, origin.x, origin.y, origin.x, origin.y);
		rect = expandRect(rect, a.x - pad, a.y - pad, a.x + pad, a.y + pad);
		rect = expandRect(rect, b.x - pad, b.y - pad, b.x + pad, b.y + pad);
		const clipped = clampRect(rect, docW, docH);
		if (!clipped) return null;
		union = expandRect(union, clipped.x, clipped.y, clipped.x + clipped.w, clipped.y + clipped.h);
		union = clampRect(union!, docW, docH);
		hasContent = true;
		return clipped;
	}

	function readDirty(bounds: Rect): FanSampleResult {
		const img = ctx.getImageData(bounds.x, bounds.y, bounds.w, bounds.h);
		const pixels = new Uint8Array(bounds.w * bounds.h * 4);
		premulCopy(img.data, bounds.w, bounds.h, pixels);
		return { pixels, bounds, hasContent };
	}

	function sample(x: number, y: number, hex: string): FanSampleResult | null {
		color = hex;
		if (!lastRaw) {
			points.push({ x, y });
			lastRaw = { x, y };
			return null;
		}
		if (Math.hypot(x - lastRaw.x, y - lastRaw.y) < MIN_DIST) return null;

		const smoothed = {
			x: lastRaw.x * (1 - SMOOTH) + x * SMOOTH,
			y: lastRaw.y * (1 - SMOOTH) + y * SMOOTH
		};
		lastRaw = { x, y };
		points.push(smoothed);

		if (points.length < 3) return null;

		const origin = points[0]!;
		const a = points[points.length - 2]!;
		const b = points[points.length - 1]!;
		const dirty = drawTriangle(origin, a, b);
		if (!dirty) return null;
		return readDirty(dirty);
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
		reset,
		resize,
		setKind,
		finalizeBounds,
		hasDrawable
	};
}

export type FanEngine = ReturnType<typeof createFanEngine>;

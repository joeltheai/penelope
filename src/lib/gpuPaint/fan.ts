import type { Rect } from './types';

export type Point = { x: number; y: number };

export type FanKind = 'fan' | 'fanFade';

export type FanBatch = {
	vertices: Float32Array;
	vertexCount: number;
	bounds: Rect;
};

const MIN_DIST = 2;
const SMOOTH = 0.75;
const FLOATS_PER_VERTEX = 3;
const VERTICES_PER_TRIANGLE = 3;
const MAX_PENDING_TRIANGLES = 4096;

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
	if (x1 <= x0 || y1 <= y0) return null;
	return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Builds only the newly swept fan triangles. Fan Fade stores opacity on each
 * vertex (one at the fixed origin, zero at the moving edge), so the GPU
 * interpolates the falloff while rasterizing. Earlier triangles never need to
 * be cleared or rebuilt when the pointer moves farther from the origin.
 */
export function createFanEngine(docW: number, docH: number, kind: FanKind) {
	const pending = new Float32Array(
		MAX_PENDING_TRIANGLES * VERTICES_PER_TRIANGLE * FLOATS_PER_VERTEX
	);
	let pendingVertexCount = 0;
	let pendingBounds: Rect | null = null;
	let origin: Point | null = null;
	let previous: Point | null = null;
	let lastRaw: Point | null = null;
	let union: Rect | null = null;
	let hasContent = false;

	function resize(nextW: number, nextH: number) {
		docW = nextW;
		docH = nextH;
		reset();
	}

	function reset() {
		pendingVertexCount = 0;
		pendingBounds = null;
		origin = null;
		previous = null;
		lastRaw = null;
		union = null;
		hasContent = false;
	}

	function begin(_hex: string) {
		reset();
	}

	function setKind(next: FanKind) {
		kind = next;
	}

	function writeVertex(point: Point, opacity: number) {
		const offset = pendingVertexCount * FLOATS_PER_VERTEX;
		pending[offset] = point.x;
		pending[offset + 1] = point.y;
		pending[offset + 2] = opacity;
		pendingVertexCount++;
	}

	function queueTriangle(origin: Point, a: Point, b: Point) {
		const pad = 2;
		let bounds = expandRect(null, origin.x, origin.y, origin.x, origin.y);
		bounds = expandRect(bounds, a.x - pad, a.y - pad, a.x + pad, a.y + pad);
		bounds = expandRect(bounds, b.x - pad, b.y - pad, b.x + pad, b.y + pad);
		const clipped = clampRect(bounds, docW, docH);
		if (!clipped) return;

		const edgeOpacity = kind === 'fanFade' ? 0 : 1;
		writeVertex(origin, 1);
		writeVertex(a, edgeOpacity);
		writeVertex(b, edgeOpacity);
		pendingBounds = expandRect(
			pendingBounds,
			clipped.x,
			clipped.y,
			clipped.x + clipped.w,
			clipped.y + clipped.h
		);
		union = expandRect(
			union,
			clipped.x,
			clipped.y,
			clipped.x + clipped.w,
			clipped.y + clipped.h
		);
		hasContent = true;
	}

	function sample(x: number, y: number, _hex: string): FanBatch | null {
		if (!lastRaw) {
			origin = { x, y };
			previous = origin;
			lastRaw = { x, y };
			return null;
		}
		if (Math.hypot(x - lastRaw.x, y - lastRaw.y) < MIN_DIST) return null;

		const smoothed = {
			x: lastRaw.x * (1 - SMOOTH) + x * SMOOTH,
			y: lastRaw.y * (1 - SMOOTH) + y * SMOOTH
		};
		lastRaw = { x, y };
		if (origin && previous && previous !== origin) {
			queueTriangle(origin, previous, smoothed);
		}
		previous = smoothed;

		return pendingVertexCount >= MAX_PENDING_TRIANGLES * VERTICES_PER_TRIANGLE ? flush() : null;
	}

	function flush(): FanBatch | null {
		if (pendingVertexCount === 0 || !pendingBounds) return null;
		const batch = {
			vertices: pending.subarray(0, pendingVertexCount * FLOATS_PER_VERTEX),
			vertexCount: pendingVertexCount,
			bounds: pendingBounds
		};
		pendingVertexCount = 0;
		pendingBounds = null;
		return batch;
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
		setKind,
		finalizeBounds,
		hasDrawable
	};
}

export type FanEngine = ReturnType<typeof createFanEngine>;

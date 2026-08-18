import type { Rect } from './types';

const CORNERS: [number, number][] = [
	[-1, -1],
	[1, -1],
	[1, 1],
	[-1, -1],
	[1, 1],
	[-1, 1]
];

export function parseColor(hex: string): [number, number, number] {
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
export function makeHardBrushPixels(size: number): Uint8Array {
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
export function rasterizePolygonEvenOdd(
	points: { x: number; y: number }[],
	bounds: Rect,
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

export function appendStamp(
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

export function spacingFor(size: number, spacingFactor: number) {
	return Math.max(0.25, size * spacingFactor);
}

export function webGpuUnavailableMessage(): string {
	if ('isSecureContext' in globalThis && globalThis.isSecureContext === false) {
		return 'WebGPU needs a secure context. http://192.168.x.x will not work on iPad — use HTTPS, or open via localhost on the same device.';
	}
	return 'WebGPU is not available here. On iPad it needs iPadOS 26+ (Safari 26); feature flags on older versions usually do not expose navigator.gpu.';
}

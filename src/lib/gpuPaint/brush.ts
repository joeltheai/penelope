import type { BrushSettings } from './types';

export const BRUSH_TIP_SIZE = 256;

export function clamp01(n: number) {
	return n < 0 ? 0 : n > 1 ? 1 : n;
}

export const DEFAULT_BRUSH_SETTINGS: BrushSettings = {
	size: 8,
	opacity: 1,
	flow: 0.65,
	spacing: 0.06,
	hardness: 0.9,
	smoothing: 0.25,
	jitter: 0,
	blend: 'wash',
	pressureSize: false,
	pressureOpacity: true
};

export const PEN_PRESET: Partial<BrushSettings> = {
	spacing: 0.06,
	hardness: 0.92,
	flow: 1,
	jitter: 0,
	blend: 'wash',
	smoothing: 0.25
};

export const AIRBRUSH_PRESET: Partial<BrushSettings> = {
	spacing: 0.07,
	hardness: 0.1,
	flow: 0.09,
	jitter: 0.12,
	blend: 'buildup',
	smoothing: 0.15
};

export function makeBrushTipPixels(size: number, hardness: number): Uint8Array {
	const pixels = new Uint8Array(size * size * 4);
	const h = clamp01(hardness);
	const aa = Math.max(1.5 / size, 0.003);
	const inner = Math.max(0, h - aa);
	const softness = Math.max(1e-4, 1 - inner);
	const gamma = 1 + (1 - h) * 0.5;

	for (let y = 0; y < size; y++) {
		const ny = ((y + 0.5) / size) * 2 - 1;
		for (let x = 0; x < size; x++) {
			const nx = ((x + 0.5) / size) * 2 - 1;
			const r = Math.sqrt(nx * nx + ny * ny);
			let a: number;
			if (r >= 1) {
				a = 0;
			} else if (r <= inner) {
				a = 1;
			} else {
				const t = (r - inner) / softness;
				const s = t * t * (3 - 2 * t);
				a = Math.pow(1 - s, gamma);
			}
			const i = (y * size + x) * 4;
			pixels[i] = 255;
			pixels[i + 1] = 255;
			pixels[i + 2] = 255;
			pixels[i + 3] = Math.round(clamp01(a) * 255);
		}
	}
	return pixels;
}

export function brushSpacingPx(diameter: number, spacing: number, viewZoom: number) {
	const zoom = Math.max(0.05, viewZoom);
	const screenFloor = 0.5 / zoom;
	const sizeFloor = Math.max(1, Math.abs(diameter)) * Math.max(0.005, spacing);
	return Math.max(0.35, screenFloor, sizeFloor);
}

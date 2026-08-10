export type RGB = { r: number; g: number; b: number };
export type HSV = { h: number; s: number; v: number };

export function clamp(n: number, lo: number, hi: number) {
	return Math.min(hi, Math.max(lo, n));
}

export function parseHex(hex: string): RGB | null {
	const raw = hex.trim().replace(/^#/, '');
	const full =
		raw.length === 3
			? raw
					.split('')
					.map((c) => c + c)
					.join('')
			: raw;
	if (!/^[0-9a-fA-F]{6}$/.test(full)) return null;
	return {
		r: parseInt(full.slice(0, 2), 16),
		g: parseInt(full.slice(2, 4), 16),
		b: parseInt(full.slice(4, 6), 16)
	};
}

export function rgbToHex({ r, g, b }: RGB): string {
	const to = (n: number) =>
		clamp(Math.round(n), 0, 255)
			.toString(16)
			.padStart(2, '0');
	return `#${to(r)}${to(g)}${to(b)}`;
}

export function rgbToCss({ r, g, b }: RGB): string {
	return `rgb(${Math.round(r)} ${Math.round(g)} ${Math.round(b)})`;
}

/** h in [0,360), s/v in [0,1] */
export function rgbToHsv({ r, g, b }: RGB): HSV {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const d = max - min;

	let h = 0;
	if (d !== 0) {
		if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
		else if (max === gn) h = ((bn - rn) / d + 2) * 60;
		else h = ((rn - gn) / d + 4) * 60;
	}

	const s = max === 0 ? 0 : d / max;
	return { h, s, v: max };
}

/** h in [0,360), s/v in [0,1] → RGB 0–255 */
export function hsvToRgb({ h, s, v }: HSV): RGB {
	const hh = ((h % 360) + 360) % 360;
	const c = v * s;
	const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
	const m = v - c;

	let rn = 0;
	let gn = 0;
	let bn = 0;
	if (hh < 60) [rn, gn, bn] = [c, x, 0];
	else if (hh < 120) [rn, gn, bn] = [x, c, 0];
	else if (hh < 180) [rn, gn, bn] = [0, c, x];
	else if (hh < 240) [rn, gn, bn] = [0, x, c];
	else if (hh < 300) [rn, gn, bn] = [x, 0, c];
	else [rn, gn, bn] = [c, 0, x];

	return {
		r: (rn + m) * 255,
		g: (gn + m) * 255,
		b: (bn + m) * 255
	};
}

export function hueGradientCss(): string {
	return 'linear-gradient(to right, #ff0000, #ffff00, #00ff00, #00ffff, #0000ff, #ff00ff, #ff0000)';
}

export function rgbChannelGradient(channel: 'r' | 'g' | 'b', rgb: RGB): string {
	const lo = { ...rgb, [channel]: 0 };
	const hi = { ...rgb, [channel]: 255 };
	return `linear-gradient(to right, ${rgbToCss(lo)}, ${rgbToCss(hi)})`;
}

export function satGradient(hsv: HSV): string {
	const lo = hsvToRgb({ ...hsv, s: 0 });
	const hi = hsvToRgb({ ...hsv, s: 1 });
	return `linear-gradient(to right, ${rgbToCss(lo)}, ${rgbToCss(hi)})`;
}

export function valueGradient(hsv: HSV): string {
	const lo = hsvToRgb({ ...hsv, v: 0 });
	const hi = hsvToRgb({ ...hsv, v: 1 });
	return `linear-gradient(to right, ${rgbToCss(lo)}, ${rgbToCss(hi)})`;
}

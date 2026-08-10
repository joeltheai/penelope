import type { Rect } from './types';

/** Tracks the integer pixel AABB of the current stroke (expanded by brush radius). */
export function createStrokeBoundsTracker() {
	let strokeMinX = 0;
	let strokeMinY = 0;
	let strokeMaxX = 0;
	let strokeMaxY = 0;
	let strokeHasBounds = false;

	function reset() {
		strokeHasBounds = false;
	}

	function expand(x: number, y: number, radius: number) {
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

	function finalize(docW: number, docH: number): Rect | null {
		if (!strokeHasBounds) return null;
		const x0 = Math.max(0, Math.floor(strokeMinX));
		const y0 = Math.max(0, Math.floor(strokeMinY));
		const x1 = Math.min(docW, Math.ceil(strokeMaxX));
		const y1 = Math.min(docH, Math.ceil(strokeMaxY));
		const w = x1 - x0;
		const h = y1 - y0;
		if (w < 1 || h < 1) return null;
		return { x: x0, y: y0, w, h };
	}

	return { reset, expand, finalize };
}

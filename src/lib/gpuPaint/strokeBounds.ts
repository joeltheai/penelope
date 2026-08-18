import type { Rect } from './types';

const TILE_SIZE = 64;

/** Tracks the integer pixel AABB of the current stroke (expanded by brush radius). */
export function createStrokeBoundsTracker() {
	let strokeMinX = 0;
	let strokeMinY = 0;
	let strokeMaxX = 0;
	let strokeMaxY = 0;
	let strokeHasBounds = false;
	const dirtyTiles = new Set<number>();

	function reset() {
		strokeHasBounds = false;
		dirtyTiles.clear();
	}

	function markTiles(minX: number, minY: number, maxX: number, maxY: number) {
		const tx0 = Math.max(0, Math.floor(minX / TILE_SIZE));
		const ty0 = Math.max(0, Math.floor(minY / TILE_SIZE));
		const tx1 = Math.floor(Math.max(minX, maxX - Number.EPSILON) / TILE_SIZE);
		const ty1 = Math.floor(Math.max(minY, maxY - Number.EPSILON) / TILE_SIZE);
		for (let ty = ty0; ty <= ty1; ty++) {
			for (let tx = tx0; tx <= tx1; tx++) dirtyTiles.add(ty * 131072 + tx);
		}
	}

	function includeRect(minX: number, minY: number, maxX: number, maxY: number) {
		if (!strokeHasBounds) {
			strokeMinX = minX;
			strokeMinY = minY;
			strokeMaxX = maxX;
			strokeMaxY = maxY;
			strokeHasBounds = true;
		} else {
			strokeMinX = Math.min(strokeMinX, minX);
			strokeMinY = Math.min(strokeMinY, minY);
			strokeMaxX = Math.max(strokeMaxX, maxX);
			strokeMaxY = Math.max(strokeMaxY, maxY);
		}
	}

	function expand(x: number, y: number, radius: number) {
		const pad = Math.ceil(radius) + 1; // +1 for AA fringe
		const minX = x - pad;
		const minY = y - pad;
		const maxX = x + pad;
		const maxY = y + pad;
		includeRect(minX, minY, maxX, maxY);
		markTiles(minX, minY, maxX, maxY);
	}

	/** Mark a rasterized region whose interior may all have changed. */
	function expandRect(rect: Rect) {
		const minX = rect.x;
		const minY = rect.y;
		const maxX = rect.x + rect.w;
		const maxY = rect.y + rect.h;
		includeRect(minX, minY, maxX, maxY);
		markTiles(minX, minY, maxX, maxY);
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

	function finalizeRegions(docW: number, docH: number): Rect[] {
		const bounds = finalize(docW, docH);
		if (!bounds) return [];

		const rows = new Map<number, number[]>();
		for (const key of dirtyTiles) {
			const ty = Math.floor(key / 131072);
			const tx = key - ty * 131072;
			if (tx < 0 || ty < 0 || tx * TILE_SIZE >= docW || ty * TILE_SIZE >= docH) continue;
			const row = rows.get(ty) ?? [];
			row.push(tx);
			rows.set(ty, row);
		}

		const regions: Rect[] = [];
		for (const [ty, columns] of [...rows].sort((a, b) => a[0] - b[0])) {
			columns.sort((a, b) => a - b);
			let start = columns[0];
			let end = start;
			const emit = () => {
				if (start === undefined || end === undefined) return;
				const x = start * TILE_SIZE;
				const y = ty * TILE_SIZE;
				regions.push({
					x,
					y,
					w: Math.min(docW, (end + 1) * TILE_SIZE) - x,
					h: Math.min(docH, y + TILE_SIZE) - y
				});
			};
			for (let i = 1; i < columns.length; i++) {
				const tx = columns[i]!;
				if (tx === end! + 1) end = tx;
				else {
					emit();
					start = end = tx;
				}
			}
			emit();
		}

		// A compact local stroke is cheaper as its exact AABB than as tile-aligned rows.
		const tiledPixels = regions.reduce((sum, region) => sum + region.w * region.h, 0);
		return regions.length === 0 || bounds.w * bounds.h <= tiledPixels ? [bounds] : regions;
	}

	return { reset, expand, expandRect, finalize, finalizeRegions };
}

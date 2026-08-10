import { MAX_DOC_SIZE, MIN_DOC_SIZE } from '$lib/gpuPaint';

export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw' | 'move';

export type CropRect = { x: number; y: number; w: number; h: number };

export type CropScreenRect = { left: number; top: number; width: number; height: number };

export type ResizeDrag = {
	handle: ResizeHandle;
	startDocX: number;
	startDocY: number;
	origX: number;
	origY: number;
	origW: number;
	origH: number;
};

const HANDLE_PX = 14;

export function cropToScreen(
	crop: CropRect,
	cam: { x: number; y: number; zoom: number },
	surface: { w: number; h: number },
	doc: { w: number; h: number }
): CropScreenRect {
	const z = Math.max(cam.zoom, 1e-6);
	const left = surface.w * 0.5 + cam.x + (crop.x - doc.w * 0.5) * z;
	const top = surface.h * 0.5 + cam.y + (crop.y - doc.h * 0.5) * z;
	return { left, top, width: crop.w * z, height: crop.h * z };
}

export function screenToDocCam(
	sx: number,
	sy: number,
	cam: { x: number; y: number; zoom: number },
	surface: { w: number; h: number },
	doc: { w: number; h: number }
) {
	const z = Math.max(cam.zoom, 1e-6);
	const x = (sx - surface.w * 0.5 - cam.x) / z + doc.w * 0.5;
	const y = (sy - surface.h * 0.5 - cam.y) / z + doc.h * 0.5;
	return { x, y };
}

export function hitResizeHandle(sx: number, sy: number, cropScreen: CropScreenRect): ResizeHandle | null {
	const { left, top, width, height } = cropScreen;
	const right = left + width;
	const bottom = top + height;
	const hs = HANDLE_PX;
	const near = (a: number, b: number) => Math.abs(a - b) <= hs;
	const inX = sx >= left - hs && sx <= right + hs;
	const inY = sy >= top - hs && sy <= bottom + hs;
	if (!inX || !inY) return null;

	const onL = near(sx, left);
	const onR = near(sx, right);
	const onT = near(sy, top);
	const onB = near(sy, bottom);
	if (onT && onL) return 'nw';
	if (onT && onR) return 'ne';
	if (onB && onL) return 'sw';
	if (onB && onR) return 'se';
	if (onT && sx >= left && sx <= right) return 'n';
	if (onB && sx >= left && sx <= right) return 's';
	if (onL && sy >= top && sy <= bottom) return 'w';
	if (onR && sy >= top && sy <= bottom) return 'e';
	if (sx >= left && sx <= right && sy >= top && sy <= bottom) return 'move';
	return null;
}

export function cursorForHandle(h: ResizeHandle | null) {
	switch (h) {
		case 'n':
		case 's':
			return 'ns-resize';
		case 'e':
		case 'w':
			return 'ew-resize';
		case 'ne':
		case 'sw':
			return 'nesw-resize';
		case 'nw':
		case 'se':
			return 'nwse-resize';
		case 'move':
			return 'move';
		default:
			return 'default';
	}
}

export function applyHandleDelta(
	handle: ResizeHandle,
	docX: number,
	docY: number,
	start: ResizeDrag
): CropRect {
	const dx = docX - start.startDocX;
	const dy = docY - start.startDocY;

	if (handle === 'move') {
		return {
			x: Math.round(start.origX + dx),
			y: Math.round(start.origY + dy),
			w: start.origW,
			h: start.origH
		};
	}

	let left = start.origX;
	let right = start.origX + start.origW;
	let top = start.origY;
	let bottom = start.origY + start.origH;

	if (handle.includes('w')) left = start.origX + dx;
	if (handle.includes('e')) right = start.origX + start.origW + dx;
	if (handle.includes('n')) top = start.origY + dy;
	if (handle.includes('s')) bottom = start.origY + start.origH + dy;

	if (left > right) {
		const t = left;
		left = right;
		right = t;
	}
	if (top > bottom) {
		const t = top;
		top = bottom;
		bottom = t;
	}

	let w = right - left;
	let h = bottom - top;

	if (w < MIN_DOC_SIZE) {
		if (handle.includes('w') && !handle.includes('e')) left = right - MIN_DOC_SIZE;
		else right = left + MIN_DOC_SIZE;
		w = MIN_DOC_SIZE;
	} else if (w > MAX_DOC_SIZE) {
		if (handle.includes('w') && !handle.includes('e')) left = right - MAX_DOC_SIZE;
		else right = left + MAX_DOC_SIZE;
		w = MAX_DOC_SIZE;
	}

	if (h < MIN_DOC_SIZE) {
		if (handle.includes('n') && !handle.includes('s')) top = bottom - MIN_DOC_SIZE;
		else bottom = top + MIN_DOC_SIZE;
		h = MIN_DOC_SIZE;
	} else if (h > MAX_DOC_SIZE) {
		if (handle.includes('n') && !handle.includes('s')) top = bottom - MAX_DOC_SIZE;
		else bottom = top + MAX_DOC_SIZE;
		h = MAX_DOC_SIZE;
	}

	return {
		x: Math.round(left),
		y: Math.round(top),
		w: Math.round(w),
		h: Math.round(h)
	};
}

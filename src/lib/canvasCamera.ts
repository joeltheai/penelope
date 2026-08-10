/** Mutable pan/zoom/rotate state used by PaintCanvas and the present shader. */
export type CameraView = {
	x: number;
	y: number;
	zoom: number;
	rotation: number;
	flipX: number;
};

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 20;

export function screenToDoc(
	sx: number,
	sy: number,
	view: CameraView,
	cssW: number,
	cssH: number,
	docW: number,
	docH: number
) {
	const cx = cssW / 2;
	const cy = cssH / 2;
	let x = (sx - cx - view.x) * view.flipX;
	let y = sy - cy - view.y;
	const cos = Math.cos(-view.rotation);
	const sin = Math.sin(-view.rotation);
	const ux = x * cos - y * sin;
	const uy = x * sin + y * cos;
	return {
		x: ux / view.zoom + docW / 2,
		y: uy / view.zoom + docH / 2
	};
}

/** Pan so `docPoint` stays under the given screen pixel. */
export function placeDocAtScreen(
	view: CameraView,
	docPoint: { x: number; y: number },
	screenX: number,
	screenY: number,
	cssW: number,
	cssH: number,
	docW: number,
	docH: number
) {
	const cos = Math.cos(view.rotation);
	const sin = Math.sin(view.rotation);
	const dx = (docPoint.x - docW / 2) * view.zoom;
	const dy = (docPoint.y - docH / 2) * view.zoom;
	const rx = (dx * cos - dy * sin) * view.flipX;
	const ry = dx * sin + dy * cos;
	view.x = screenX - cssW / 2 - rx;
	view.y = screenY - cssH / 2 - ry;
}

/** Keep the doc point under `pivot` fixed when zoom/rotation change. */
export function setViewAroundPivot(
	view: CameraView,
	pivotX: number,
	pivotY: number,
	newZoom: number,
	newRotation: number,
	cssW: number,
	cssH: number,
	docW: number,
	docH: number
) {
	const before = screenToDoc(pivotX, pivotY, view, cssW, cssH, docW, docH);
	view.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoom));
	view.rotation = newRotation;
	placeDocAtScreen(view, before, pivotX, pivotY, cssW, cssH, docW, docH);
}

/** Zoom so the full document fits in the viewport (centered). */
export function fitDocumentZoom(cssW: number, cssH: number, docW: number, docH: number) {
	const margin = 0.92;
	const nextZoom = Math.min(cssW / docW, cssH / docH) * margin;
	return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom));
}

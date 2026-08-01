<script lang="ts">
	let {
		color = $bindable('#1a6cff'),
		size = $bindable(8),
		opacity = $bindable(1)
	}: { color?: string; size?: number; opacity?: number } = $props();


	let canvasEl: HTMLCanvasElement | undefined = $state();

	let space = false;
	let alt = false;
	let rotateKey = false;

	function onKeyDown(e: KeyboardEvent) {
		if (e.code === 'Space') {
			e.preventDefault();
			space = true;
		}
		if (e.code === 'AltLeft' || e.code === 'AltRight') alt = true;
		if (e.code === 'KeyR') rotateKey = true;
	}

	function onKeyUp(e: KeyboardEvent) {
		if (e.code === 'Space') space = false;
		if (e.code === 'AltLeft' || e.code === 'AltRight') alt = false;
		if (e.code === 'KeyR') rotateKey = false;
	}

	$effect(() => {
		if (!canvasEl) return;
		const surface = canvasEl!;
		const ctx = surface.getContext('2d')!;

		const DOC_W = 1024;
		const DOC_H = 1024;
		const MIN_Z = 0.05;
		const MAX_Z = 20;


		const doc = document.createElement('canvas');
		doc.width = DOC_W;
		doc.height = DOC_H;
		const dctx = doc.getContext('2d')!;

		dctx.fillStyle = '#fff';
		dctx.fillRect(0, 0, DOC_W, DOC_H);

		const stroke = document.createElement('canvas');
		stroke.width = DOC_W;
		stroke.height = DOC_H;
		const sctx = stroke.getContext('2d')!;

		const view = { x: 0, y: 0, zoom: 0.5, rotation: 0 };
		let cssW = 0;
		let cssH = 0;

		let drawing = false;
		let strokeActive = false;
		let panning = false;
		let rotating = false;
		let lastX = 0;
		let lastY = 0;
		let lastDoc: { x: number; y: number } | null = null;
		let rotatePivot = { x: 0, y: 0 };
		let lastRotateAngle: number | null = null;

		const touches: Record<number, { x: number; y: number }> = {};
		let pinch: {
			docPoint: { x: number; y: number };
			startDist: number;
			startAngle: number;
			startZoom: number;
			startRotation: number;
		} | null = null;

		function touchList() {
			return Object.values(touches);
		}

		function touchCount() {
			return Object.keys(touches).length;
		}

		function screenToDoc(sx: number, sy: number) {
			const cx = cssW / 2;
			const cy = cssH / 2;
			let x = sx - cx - view.x;
			let y = sy - cy - view.y;
			const cos = Math.cos(-view.rotation);
			const sin = Math.sin(-view.rotation);
			const ux = x * cos - y * sin;
			const uy = x * sin + y * cos;
			return {
				x: ux / view.zoom + DOC_W / 2,
				y: uy / view.zoom + DOC_H / 2
			};
		}

		/** Keep the doc point under `pivot` fixed when zoom/rotation change. */
		function setViewAroundPivot(pivotX: number, pivotY: number, newZoom: number, newRotation: number) {
			const before = screenToDoc(pivotX, pivotY);
			view.zoom = Math.min(MAX_Z, Math.max(MIN_Z, newZoom));
			view.rotation = newRotation;

			const cos = Math.cos(view.rotation);
			const sin = Math.sin(view.rotation);
			const dx = (before.x - DOC_W / 2) * view.zoom;
			const dy = (before.y - DOC_H / 2) * view.zoom;
			const rx = dx * cos - dy * sin;
			const ry = dx * sin + dy * cos;
			view.x = pivotX - cssW / 2 - rx;
			view.y = pivotY - cssH / 2 - ry;
			present();
		}

		function placeDocAtScreen(docPoint: { x: number; y: number }, screenX: number, screenY: number) {
			const cos = Math.cos(view.rotation);
			const sin = Math.sin(view.rotation);
			const dx = (docPoint.x - DOC_W / 2) * view.zoom;
			const dy = (docPoint.y - DOC_H / 2) * view.zoom;
			const rx = dx * cos - dy * sin;
			const ry = dx * sin + dy * cos;
			view.x = screenX - cssW / 2 - rx;
			view.y = screenY - cssH / 2 - ry;
		}

		function present() {
			const dpr = devicePixelRatio || 1;
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.fillStyle = '#1c1c1d';
			ctx.fillRect(0, 0, cssW, cssH);

			const cx = cssW / 2;
			const cy = cssH / 2;
			ctx.save();
			ctx.translate(cx + view.x, cy + view.y);
			ctx.rotate(view.rotation);
			ctx.scale(view.zoom, view.zoom);
			ctx.translate(-DOC_W / 2, -DOC_H / 2);
			ctx.drawImage(doc, 0, 0);
			if (strokeActive) {
				ctx.globalAlpha = opacity;
				ctx.drawImage(stroke, 0, 0);
			}
			ctx.restore();
		}

		function beginStroke() {
			sctx.clearRect(0, 0, DOC_W, DOC_H);
			strokeActive = true;
		}

		function endStroke() {
			if (!strokeActive) return;
			dctx.save();
			dctx.globalAlpha = opacity;
			dctx.drawImage(stroke, 0, 0);
			dctx.restore();
			sctx.clearRect(0, 0, DOC_W, DOC_H);
			strokeActive = false;
			present();
		}

		function resize() {
			const dpr = devicePixelRatio || 1;
			cssW = surface.clientWidth;
			cssH = surface.clientHeight;
			surface.width = Math.max(1, Math.round(cssW * dpr));
			surface.height = Math.max(1, Math.round(cssH * dpr));
			present();
		}

		function paintAt(sx: number, sy: number) {
			const p = screenToDoc(sx, sy);
			sctx.globalAlpha = 1;
			sctx.fillStyle = color;
			sctx.strokeStyle = color;
			sctx.lineWidth = size * 2;
			sctx.lineCap = 'round';
			sctx.lineJoin = 'round';

			if (lastDoc) {
				sctx.beginPath();
				sctx.moveTo(lastDoc.x, lastDoc.y);
				sctx.lineTo(p.x, p.y);
				sctx.stroke();
			} else {
				sctx.beginPath();
				sctx.arc(p.x, p.y, size, 0, Math.PI * 2);
				sctx.fill();
			}
			lastDoc = p;
			present();
		}


		function wantsRotate(e: PointerEvent) {
			return alt || e.altKey || rotateKey;
		}

		function onPointerDown(e: PointerEvent) {
			e.preventDefault();
			const active = document.activeElement;
			if (active instanceof HTMLElement && active !== surface) active.blur();

			if (e.pointerType === 'touch') {
				touches[e.pointerId] = { x: e.clientX, y: e.clientY };
				if (touchCount() === 2) {
					if (drawing || strokeActive) endStroke();
					drawing = false;
					lastDoc = null;
					const [a, b] = touchList();
					const midX = (a.x + b.x) / 2;
					const midY = (a.y + b.y) / 2;
					pinch = {
						docPoint: screenToDoc(midX, midY),
						startDist: Math.hypot(a.x - b.x, a.y - b.y),
						startAngle: Math.atan2(b.y - a.y, b.x - a.x),
						startZoom: view.zoom,
						startRotation: view.rotation
					};
				}
			}

			surface.setPointerCapture(e.pointerId);
			lastX = e.clientX;
			lastY = e.clientY;

			if (touchCount() >= 2) return;

			if (wantsRotate(e)) {
				rotating = true;
				rotatePivot = { x: e.clientX, y: e.clientY };
				lastRotateAngle = null;
				return;
			}

			if (space || e.button === 1) {
				panning = true;
				return;
			}

			if (e.button === 0 || e.pointerType === 'touch') {
				drawing = true;
				lastDoc = null;
				beginStroke();
				paintAt(e.clientX, e.clientY);
			}
		}

		function onPointerMove(e: PointerEvent) {
			if (e.pointerType === 'touch' && touches[e.pointerId]) {
				touches[e.pointerId] = { x: e.clientX, y: e.clientY };
				if (touchCount() === 2 && pinch) {
					const [a, b] = touchList();
					const dist = Math.hypot(a.x - b.x, a.y - b.y);
					const angle = Math.atan2(b.y - a.y, b.x - a.x);
					const midX = (a.x + b.x) / 2;
					const midY = (a.y + b.y) / 2;

					view.zoom = Math.min(
						MAX_Z,
						Math.max(MIN_Z, pinch.startZoom * (dist / Math.max(pinch.startDist, 1e-6)))
					);
					view.rotation = pinch.startRotation + (angle - pinch.startAngle);
					placeDocAtScreen(pinch.docPoint, midX, midY);
					present();
					return;
				}
			}

			if (rotating) {
				const ang = Math.atan2(e.clientY - rotatePivot.y, e.clientX - rotatePivot.x);
				const dist = Math.hypot(e.clientX - rotatePivot.x, e.clientY - rotatePivot.y);
				if (dist >= 8) {
					if (lastRotateAngle === null) {
						lastRotateAngle = ang;
					} else {
						let dAng = ang - lastRotateAngle;
						if (dAng > Math.PI) dAng -= Math.PI * 2;
						if (dAng < -Math.PI) dAng += Math.PI * 2;
						lastRotateAngle = ang;
						setViewAroundPivot(rotatePivot.x, rotatePivot.y, view.zoom, view.rotation + dAng);
					}
				}
				return;
			}

			if (panning) {
				view.x += e.clientX - lastX;
				view.y += e.clientY - lastY;
				lastX = e.clientX;
				lastY = e.clientY;
				present();
				return;
			}

			if (drawing) paintAt(e.clientX, e.clientY);
		}

		function onPointerUp(e: PointerEvent) {
			delete touches[e.pointerId];
			if (touchCount() < 2) pinch = null;

			if (drawing || strokeActive) endStroke();
			drawing = false;
			panning = false;
			rotating = false;
			lastDoc = null;
			lastRotateAngle = null;

			if (surface.hasPointerCapture(e.pointerId)) {
				surface.releasePointerCapture(e.pointerId);
			}
		}

		function onWheel(e: WheelEvent) {
			e.preventDefault();
			const factor = e.deltaY < 0 ? 1.1 : 0.9;
			setViewAroundPivot(e.clientX, e.clientY, view.zoom * factor, view.rotation);
		}

		function onContextMenu(e: Event) {
			e.preventDefault();
		}

		function onSelectStart(e: Event) {
			e.preventDefault();
		}

		// Non-passive touchstart is what actually kills iOS long-press loupe/selection.
		function onTouchStart(e: TouchEvent) {
			e.preventDefault();
		}

		resize();

		const ro = new ResizeObserver(resize);
		ro.observe(surface);

		surface.addEventListener('pointerdown', onPointerDown);
		surface.addEventListener('pointermove', onPointerMove);
		surface.addEventListener('pointerup', onPointerUp);
		surface.addEventListener('pointercancel', onPointerUp);
		surface.addEventListener('wheel', onWheel, { passive: false });
		surface.addEventListener('contextmenu', onContextMenu);
		surface.addEventListener('selectstart', onSelectStart);
		surface.addEventListener('touchstart', onTouchStart, { passive: false });
		window.addEventListener('resize', resize);

		return () => {
			ro.disconnect();
			surface.removeEventListener('pointerdown', onPointerDown);
			surface.removeEventListener('pointermove', onPointerMove);
			surface.removeEventListener('pointerup', onPointerUp);
			surface.removeEventListener('pointercancel', onPointerUp);
			surface.removeEventListener('wheel', onWheel);
			surface.removeEventListener('contextmenu', onContextMenu);
			surface.removeEventListener('selectstart', onSelectStart);
			surface.removeEventListener('touchstart', onTouchStart);
			window.removeEventListener('resize', resize);
		};
	});
</script>

<svelte:window onkeydown={onKeyDown} onkeyup={onKeyUp} />

<canvas
	bind:this={canvasEl}
	class="fixed inset-0 block h-full w-full touch-none select-none [-webkit-touch-callout:none]"
	style:background="#1c1c1d"
></canvas>

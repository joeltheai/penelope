<script lang="ts">
	let {
		value = $bindable(0),
		min = 0,
		max = 100,
		step = 1,
		label = 'Value',
		orientation = 'horizontal',
		previewing = $bindable(false)
	}: {
		value?: number;
		min?: number;
		max?: number;
		step?: number;
		label?: string;
		orientation?: 'horizontal' | 'vertical';
		previewing?: boolean;
	} = $props();

	let percent = $derived(((value - min) / (max - min)) * 100);
	let rollPx = $derived(percent * 1.6);
	let vertical = $derived(orientation === 'vertical');

	function clamp(n: number, lo: number, hi: number) {
		return Math.min(hi, Math.max(lo, n));
	}

	function snap(n: number) {
		const snapped = Math.round((n - min) / step) * step + min;
		const decimals = String(step).includes('.') ? String(step).split('.')[1].length : 0;
		return Number(clamp(snapped, min, max).toFixed(decimals));
	}

	function valueFromPointer(clientX: number, clientY: number, el: HTMLElement) {
		const rect = el.getBoundingClientRect();
		const ratio = vertical
			? clamp(1 - (clientY - rect.top) / rect.height, 0, 1)
			: clamp((clientX - rect.left) / rect.width, 0, 1);
		return snap(min + ratio * (max - min));
	}

	function showPreview() {
		previewing = true;
	}

	function hidePreview() {
		previewing = false;
	}

	function onPointerDown(e: PointerEvent) {
		if (e.button !== 0) return;
		const el = e.currentTarget as HTMLElement;
		showPreview();
		value = valueFromPointer(e.clientX, e.clientY, el);
		el.setPointerCapture(e.pointerId);
	}

	function onPointerMove(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		if (!el.hasPointerCapture(e.pointerId)) return;
		value = valueFromPointer(e.clientX, e.clientY, el);
	}

	function onPointerUp(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		if (el.hasPointerCapture(e.pointerId)) {
			el.releasePointerCapture(e.pointerId);
		}
		hidePreview();
	}

	function onKeyDown(e: KeyboardEvent) {
		let next = value;
		switch (e.key) {
			case 'ArrowLeft':
			case 'ArrowDown':
				next = value - step;
				break;
			case 'ArrowRight':
			case 'ArrowUp':
				next = value + step;
				break;
			case 'Home':
				next = min;
				break;
			case 'End':
				next = max;
				break;
			case 'PageDown':
				next = value - step * 10;
				break;
			case 'PageUp':
				next = value + step * 10;
				break;
			default:
				return;
		}
		e.preventDefault();
		value = snap(next);
	}
</script>

<div
	role="slider"
	tabindex="0"
	aria-label={label}
	aria-orientation={orientation}
	aria-valuemin={min}
	aria-valuemax={max}
	aria-valuenow={value}
	class="roller outline-none focus-visible:ring-2 focus-visible:ring-white/40"
	class:roller--vertical={vertical}
	class:roller--horizontal={!vertical}
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
	onfocus={showPreview}
	onblur={hidePreview}
	onkeydown={onKeyDown}
>
	<div class="roller-knurls" aria-hidden="true" style:--roll="{rollPx}px"></div>
</div>

<style>
	.roller {
		position: relative;
		cursor: grab;
		touch-action: none;
		user-select: none;
		flex-shrink: 0;
		overflow: hidden;
		border-radius: 0.5rem;
		background: #2a2a2e;
		border: 1px solid rgba(255, 255, 255, 0.12);
	}

	.roller:active {
		cursor: grabbing;
	}

	.roller--horizontal {
		width: 8.5rem;
		height: 2rem;
	}

	.roller--vertical {
		width: 2rem;
		height: min(26vh, 12rem);
	}

	.roller-knurls {
		position: absolute;
		inset: 0;
	}

	.roller--horizontal .roller-knurls {
		background: repeating-linear-gradient(
			90deg,
			#3a3c42 0px,
			#3a3c42 3px,
			#222428 3px,
			#222428 5px
		);
		background-position: var(--roll) 0;
	}

	.roller--vertical .roller-knurls {
		background: repeating-linear-gradient(
			180deg,
			#3a3c42 0px,
			#3a3c42 3px,
			#222428 3px,
			#222428 5px
		);
		background-position: 0 var(--roll);
	}
</style>

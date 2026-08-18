<script lang="ts">
	import { clamp } from '$lib/colorUtils';

	let {
		value = 0,
		min = 0,
		max = 255,
		step = 1,
		label,
		gradient,
		thumbColor,
		onValue
	}: {
		value?: number;
		min?: number;
		max?: number;
		step?: number;
		label: string;
		gradient: string;
		/** CSS color for the thumb fill; defaults to white */
		thumbColor?: string;
		onValue: (value: number) => void;
	} = $props();

	let trackEl: HTMLElement | undefined = $state();

	let percent = $derived(((value - min) / (max - min)) * 100);

	function snap(n: number) {
		const snapped = Math.round((n - min) / step) * step + min;
		const decimals = String(step).includes('.') ? String(step).split('.')[1].length : 0;
		return Number(clamp(snapped, min, max).toFixed(decimals));
	}

	function valueFromClientX(clientX: number) {
		if (!trackEl) return value;
		const rect = trackEl.getBoundingClientRect();
		const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
		return snap(min + ratio * (max - min));
	}

	function setValue(next: number) {
		const snapped = snap(next);
		if (snapped !== value) onValue(snapped);
	}

	function onPointerDown(e: PointerEvent) {
		if (e.button !== 0) return;
		// SAFETY: bound to the track element in the template; currentTarget is that HTMLElement.
		const el = e.currentTarget as HTMLElement;
		setValue(valueFromClientX(e.clientX));
		el.setPointerCapture(e.pointerId);
	}

	function onPointerMove(e: PointerEvent) {
		// SAFETY: bound to the track element in the template; currentTarget is that HTMLElement.
		const el = e.currentTarget as HTMLElement;
		if (!el.hasPointerCapture(e.pointerId)) return;
		setValue(valueFromClientX(e.clientX));
	}

	function onPointerUp(e: PointerEvent) {
		// SAFETY: bound to the track element in the template; currentTarget is that HTMLElement.
		const el = e.currentTarget as HTMLElement;
		if (el.hasPointerCapture(e.pointerId)) {
			el.releasePointerCapture(e.pointerId);
		}
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
		setValue(next);
	}
</script>

<div
	bind:this={trackEl}
	role="slider"
	tabindex="0"
	aria-label={label}
	aria-valuemin={min}
	aria-valuemax={max}
	aria-valuenow={value}
	class="track outline-none focus-visible:ring-2 focus-visible:ring-white/35"
	style:background={gradient}
	onpointerdown={onPointerDown}
	onpointermove={onPointerMove}
	onpointerup={onPointerUp}
	onpointercancel={onPointerUp}
	onkeydown={onKeyDown}
>
	<div
		class="thumb"
		style:left="{percent}%"
		style:background={thumbColor ?? '#fff'}
		aria-hidden="true"
	></div>
</div>

<style>
	.track {
		position: relative;
		height: 1.35rem;
		border-radius: 9999px;
		cursor: grab;
		touch-action: none;
		user-select: none;
		box-shadow:
			inset 0 0 0 1px rgba(0, 0, 0, 0.35),
			inset 0 1px 2px rgba(0, 0, 0, 0.25);
	}

	.track:active {
		cursor: grabbing;
	}

	.thumb {
		position: absolute;
		top: 50%;
		width: 1.2rem;
		height: 1.2rem;
		translate: -50% -50%;
		border-radius: 9999px;
		border: 2.5px solid #fff;
		box-shadow:
			0 1px 3px rgba(0, 0, 0, 0.45),
			0 0 0 1px rgba(0, 0, 0, 0.12);
		pointer-events: none;
	}
</style>

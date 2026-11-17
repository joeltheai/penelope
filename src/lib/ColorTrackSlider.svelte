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
		thumbColor?: string;
		onValue: (value: number) => void;
	} = $props();

	let trackEl: HTMLElement | undefined = $state();

	let percent = $derived(max > min ? clamp(((value - min) / (max - min)) * 100, 0, 100) : 0);

	function snap(n: number) {
		const snapped = Math.round((n - min) / step) * step + min;
		const decimals = String(step).includes('.') ? String(step).split('.')[1]!.length : 0;
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
		const el = e.currentTarget as HTMLElement;
		setValue(valueFromClientX(e.clientX));
		el.setPointerCapture(e.pointerId);
	}

	function onPointerMove(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		if (!el.hasPointerCapture(e.pointerId)) return;
		setValue(valueFromClientX(e.clientX));
	}

	function onPointerUp(e: PointerEvent) {
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

<div class="field">
	<span class="head">
		<span class="label">{label}</span>
		<span class="value pl-mono" aria-hidden="true">{Math.round(value)}</span>
	</span>
	<div
		bind:this={trackEl}
		role="slider"
		tabindex="0"
		aria-label={label}
		aria-valuemin={min}
		aria-valuemax={max}
		aria-valuenow={value}
		class="track"
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerUp}
		onkeydown={onKeyDown}
	>
		<span class="rail" style:background={gradient} aria-hidden="true"></span>
		<span
			class="thumb"
			style:left="{percent}%"
			style:background={thumbColor ?? '#fff'}
			aria-hidden="true"
		></span>
	</div>
</div>

<style>
	.field {
		display: flex;
		flex-direction: column;
		width: 100%;
		min-width: 0;
	}

	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: -3px;
	}

	.label {
		font-size: 11px;
		font-weight: 500;
		color: var(--pl-dim);
	}

	.value {
		font-size: 11px;
		color: var(--pl-ink);
		flex: none;
	}

	.track {
		position: relative;
		display: flex;
		align-items: center;
		height: var(--pl-tap);
		cursor: grab;
		touch-action: none;
		user-select: none;
		border-radius: 4px;
	}

	.track:active {
		cursor: grabbing;
	}

	.track:focus-visible {
		outline: 2px solid var(--pl-accent);
		outline-offset: -2px;
	}

	.rail {
		display: block;
		width: 100%;
		height: 14px;
		border-radius: 7px;
	}

	.thumb {
		position: absolute;
		top: 50%;
		width: 16px;
		height: 16px;
		translate: -50% -50%;
		border-radius: 50%;
		border: 2px solid #ffffff;
		box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45);
		pointer-events: none;
	}
</style>

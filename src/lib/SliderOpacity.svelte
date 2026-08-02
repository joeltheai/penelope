<script lang="ts">
	let {
		value = $bindable(1),
		min = 0.05,
		max = 1,
		step = 0.01
	}: {
		value?: number;
		min?: number;
		max?: number;
		step?: number;
	} = $props();

	let previewing = $state(false);

	let percent = $derived(((value - min) / (max - min)) * 100);

	function clamp(n: number, lo: number, hi: number) {
		return Math.min(hi, Math.max(lo, n));
	}

	function snap(n: number) {
		const snapped = Math.round((n - min) / step) * step + min;
		const decimals = String(step).includes('.') ? String(step).split('.')[1].length : 0;
		return Number(clamp(snapped, min, max).toFixed(decimals));
	}

	function valueFromClientX(clientX: number, el: HTMLElement) {
		const rect = el.getBoundingClientRect();
		const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
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
		value = valueFromClientX(e.clientX, el);
		el.setPointerCapture(e.pointerId);
	}

	function onPointerMove(e: PointerEvent) {
		const el = e.currentTarget as HTMLElement;
		if (!el.hasPointerCapture(e.pointerId)) return;
		value = valueFromClientX(e.clientX, el);
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

<div class="flex items-center py-3">
	<div
		role="slider"
		tabindex="0"
		aria-label="Brush opacity"
		aria-valuemin={min}
		aria-valuemax={max}
		aria-valuenow={value}
		class="relative h-10 w-32 cursor-pointer touch-none rounded-xl border border-white/50 bg-white/10 outline-none focus-visible:ring-2 focus-visible:ring-white/60"
		onpointerdown={onPointerDown}
		onpointermove={onPointerMove}
		onpointerup={onPointerUp}
		onpointercancel={onPointerUp}
		onfocus={showPreview}
		onblur={hidePreview}
		onkeydown={onKeyDown}
	>
		<div
			class="pointer-events-none absolute top-0 bottom-0 w-0.5 -translate-x-1/2 bg-white"
			style:left="{percent}%"
			aria-hidden="true"
		></div>
	</div>
</div>

{#if previewing}
	<div
		class="pointer-events-none fixed top-1/2 left-1/2 z-20 size-16 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-white"
		style:opacity={value}
		aria-hidden="true"
	></div>
{/if}

<script lang="ts">
	let {
		value = $bindable(0),
		min = 0,
		max = 100,
		step = 1,
		label = '',
		format,
		disabled = false,
		title = '',
		dragging = $bindable(false)
	}: {
		value?: number;
		min?: number;
		max?: number;
		step?: number;
		label?: string;
		format?: (value: number) => string;
		disabled?: boolean;
		title?: string;
		dragging?: boolean;
	} = $props();

	const display = $derived(format ? format(value) : String(Math.round(value * 100) / 100));
	const percent = $derived(
		max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0
	);

	function onPointerDown(e: PointerEvent) {
		if (disabled || e.button !== 0) return;
		dragging = true;
	}

	function stopDrag() {
		dragging = false;
	}
</script>

<label class="slider" class:slider--disabled={disabled} {title}>
	<div class="slider-head">
		<span class="slider-label">{label}</span>
		<span class="slider-value">{display}</span>
	</div>
	<input
		class="slider-input"
		type="range"
		{min}
		{max}
		{step}
		{disabled}
		bind:value
		aria-label={label || title}
		style:--slider-percent="{percent}%"
		onpointerdown={onPointerDown}
		onpointerup={stopDrag}
		onpointercancel={stopDrag}
		onblur={stopDrag}
	/>
</label>

<style>
	.slider {
		display: flex;
		flex-direction: column;
		gap: 2px;
		width: 100%;
		min-width: 0;
	}

	.slider--disabled {
		opacity: 0.4;
	}

	.slider-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		font-size: 10px;
		line-height: 1.1;
		letter-spacing: 0.02em;
		color: rgba(255, 255, 255, 0.55);
	}

	.slider-value {
		font-variant-numeric: tabular-nums;
		color: rgba(255, 255, 255, 0.85);
	}

	.slider-input {
		appearance: none;
		-webkit-appearance: none;
		width: 100%;
		height: 16px;
		margin: 0;
		background: transparent;
		cursor: pointer;
		touch-action: none;
	}

	.slider-input:disabled {
		cursor: not-allowed;
	}

	.slider-input::-webkit-slider-runnable-track {
		height: 4px;
		border-radius: 999px;
		background: linear-gradient(
			to right,
			#8fb6ff 0%,
			#8fb6ff var(--slider-percent),
			#3a3a40 var(--slider-percent),
			#3a3a40 100%
		);
	}

	.slider-input::-webkit-slider-thumb {
		appearance: none;
		-webkit-appearance: none;
		width: 13px;
		height: 13px;
		margin-top: -4.5px;
		border-radius: 50%;
		background: #f4f5f7;
		border: none;
		box-shadow:
			0 1px 2px rgba(0, 0, 0, 0.55),
			0 0 0 1px rgba(0, 0, 0, 0.25);
	}

	.slider-input:focus-visible {
		outline: none;
	}

	.slider-input:focus-visible::-webkit-slider-thumb {
		box-shadow:
			0 0 0 2px #1e1e22,
			0 0 0 4px rgba(143, 182, 255, 0.85);
	}

	.slider-input::-moz-range-track {
		height: 4px;
		border-radius: 999px;
		background: #3a3a40;
	}

	.slider-input::-moz-range-progress {
		height: 4px;
		border-radius: 999px;
		background: #8fb6ff;
	}

	.slider-input::-moz-range-thumb {
		width: 13px;
		height: 13px;
		border: none;
		border-radius: 50%;
		background: #f4f5f7;
		box-shadow:
			0 1px 2px rgba(0, 0, 0, 0.55),
			0 0 0 1px rgba(0, 0, 0, 0.25);
	}

	.slider-input:focus-visible::-moz-range-thumb {
		box-shadow:
			0 0 0 2px #1e1e22,
			0 0 0 4px rgba(143, 182, 255, 0.85);
	}
</style>

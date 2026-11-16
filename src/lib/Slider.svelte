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

<label class="field" class:field--disabled={disabled} {title}>
	<span class="head">
		<span class="label">{label}</span>
		<span class="value pl-mono">{display}</span>
	</span>
	<input
		class="input"
		type="range"
		{min}
		{max}
		{step}
		{disabled}
		bind:value
		aria-label={label || title}
		style:--fill="{percent}%"
		onpointerdown={onPointerDown}
		onpointerup={stopDrag}
		onpointercancel={stopDrag}
		onblur={stopDrag}
	/>
</label>

<style>
	.field {
		display: flex;
		flex-direction: column;
		width: 100%;
		min-width: 0;
	}

	.field--disabled {
		opacity: 0.42;
	}

	.head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 8px;
		margin-bottom: -3px;
	}

	.label {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--pl-dim);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.value {
		font-size: 10.5px;
		letter-spacing: 0.02em;
		color: var(--pl-ink);
		flex: none;
	}

	.input {
		appearance: none;
		-webkit-appearance: none;
		width: 100%;
		height: var(--pl-tap);
		margin: 0;
		background: transparent;
		cursor: pointer;
		touch-action: none;
	}

	.input:disabled {
		cursor: default;
	}

	.input::-webkit-slider-runnable-track {
		height: 3px;
		border-radius: 2px;
		background: linear-gradient(
			to right,
			var(--pl-accent) 0%,
			var(--pl-accent) var(--fill),
			var(--pl-line-strong) var(--fill),
			var(--pl-line-strong) 100%
		);
	}

	.input::-webkit-slider-thumb {
		appearance: none;
		-webkit-appearance: none;
		width: 12px;
		height: 12px;
		margin-top: -4.5px;
		border-radius: 50%;
		background: var(--pl-ink);
		border: none;
		box-shadow:
			0 1px 2px rgba(0, 0, 0, 0.55),
			0 0 0 1px rgba(0, 0, 0, 0.3);
	}

	.input::-moz-range-track {
		height: 3px;
		border-radius: 2px;
		background: var(--pl-line-strong);
	}

	.input::-moz-range-progress {
		height: 3px;
		border-radius: 2px;
		background: var(--pl-accent);
	}

	.input::-moz-range-thumb {
		width: 12px;
		height: 12px;
		border: none;
		border-radius: 50%;
		background: var(--pl-ink);
		box-shadow:
			0 1px 2px rgba(0, 0, 0, 0.55),
			0 0 0 1px rgba(0, 0, 0, 0.3);
	}
</style>

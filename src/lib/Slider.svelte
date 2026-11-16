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
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--pl-dim);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.value {
		font-size: 10.5px;
		letter-spacing: 0.04em;
		color: #cfe9ff;
		flex: none;
		text-shadow: 0 0 10px rgba(87, 247, 255, 0.3);
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
		height: 4px;
		border-radius: 999px;
		background:
			linear-gradient(90deg, var(--pl-accent), #8f7bff 58%, var(--pl-accent-2)) 0 /
				var(--fill) 100% no-repeat,
			rgba(255, 255, 255, 0.09);
		box-shadow:
			inset 0 1px 2px rgba(0, 0, 0, 0.6),
			0 0 10px rgba(87, 247, 255, 0.14);
	}

	.input::-webkit-slider-thumb {
		appearance: none;
		-webkit-appearance: none;
		width: 13px;
		height: 13px;
		margin-top: -4.5px;
		border-radius: 50%;
		background: radial-gradient(circle at 35% 30%, #ffffff 0 40%, #c9faff 64%, #6ee7ff 100%);
		border: none;
		box-shadow:
			0 0 0 1px rgba(255, 255, 255, 0.65),
			0 0 10px rgba(87, 247, 255, 0.85),
			0 0 20px rgba(87, 247, 255, 0.35),
			0 1px 3px rgba(0, 0, 0, 0.6);
	}

	.input::-moz-range-track {
		height: 4px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.09);
		box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.6);
	}

	.input::-moz-range-progress {
		height: 4px;
		border-radius: 999px;
		background: linear-gradient(90deg, var(--pl-accent), #8f7bff 58%, var(--pl-accent-2));
		box-shadow: 0 0 10px rgba(87, 247, 255, 0.2);
	}

	.input::-moz-range-thumb {
		width: 13px;
		height: 13px;
		border: none;
		border-radius: 50%;
		background: radial-gradient(circle at 35% 30%, #ffffff 0 40%, #c9faff 64%, #6ee7ff 100%);
		box-shadow:
			0 0 0 1px rgba(255, 255, 255, 0.65),
			0 0 10px rgba(87, 247, 255, 0.85),
			0 1px 3px rgba(0, 0, 0, 0.6);
	}
</style>

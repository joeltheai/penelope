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
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		color: var(--pl-dim);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.value {
		font-size: 10px;
		letter-spacing: 0.04em;
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
		height: 4px;
		border-radius: 1px;
		background:
			linear-gradient(90deg, #2fb9cc, var(--pl-accent)) 0 / var(--fill) 100% no-repeat,
			rgba(255, 255, 255, 0.08);
		box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.8);
	}

	.input::-webkit-slider-thumb {
		appearance: none;
		-webkit-appearance: none;
		width: 12px;
		height: 20px;
		margin-top: -8px;
		border-radius: 2px;
		background: linear-gradient(180deg, #423a5d, #191528);
		border: 1px solid #5d5282;
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.25),
			0 1px 2px rgba(0, 0, 0, 0.8);
	}

	.input::-moz-range-track {
		height: 4px;
		border-radius: 1px;
		background: rgba(255, 255, 255, 0.08);
		box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.8);
	}

	.input::-moz-range-progress {
		height: 4px;
		border-radius: 1px;
		background: linear-gradient(90deg, #2fb9cc, var(--pl-accent));
	}

	.input::-moz-range-thumb {
		width: 12px;
		height: 20px;
		border-radius: 2px;
		background: linear-gradient(180deg, #423a5d, #191528);
		border: 1px solid #5d5282;
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.25),
			0 1px 2px rgba(0, 0, 0, 0.8);
	}
</style>

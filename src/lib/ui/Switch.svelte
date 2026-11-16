<script lang="ts">
	let {
		label,
		hint = '',
		checked = $bindable(false),
		disabled = false
	}: {
		label: string;
		hint?: string;
		checked?: boolean;
		disabled?: boolean;
	} = $props();
</script>

<button
	type="button"
	role="switch"
	class="sw"
	class:sw--on={checked}
	aria-checked={checked}
	aria-label={label}
	title={hint || label}
	{disabled}
	onclick={() => (checked = !checked)}
>
	<span class="sw-label">{label}</span>
	<span class="sw-track" aria-hidden="true">
		<span class="sw-knob"></span>
	</span>
</button>

<style>
	.sw {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
		width: 100%;
		min-height: var(--pl-tap);
		padding: 0 2px;
		border-radius: 9px;
		text-align: left;
		transition: opacity 130ms var(--pl-ease);
	}

	.sw-label {
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		color: var(--pl-dim);
	}

	@media (hover: hover) {
		.sw:hover:not(:disabled) {
			background: rgba(87, 247, 255, 0.06);
		}
		.sw:hover:not(:disabled) .sw-label {
			color: var(--pl-ink);
		}
	}

	.sw--on .sw-label {
		color: #d8f6ff;
		text-shadow: 0 0 12px rgba(87, 247, 255, 0.45);
	}

	.sw-track {
		position: relative;
		flex: none;
		width: 38px;
		height: 20px;
		border-radius: 999px;
		background: linear-gradient(180deg, #060512, #171436);
		border: 1px solid var(--pl-line-strong);
		box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.6);
	}

	.sw-knob {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: linear-gradient(180deg, #ffffff, #b9c3de);
		box-shadow: 0 1px 3px rgba(0, 0, 0, 0.55);
		transition:
			transform 160ms cubic-bezier(0.3, 1.4, 0.5, 1),
			background 160ms var(--pl-ease),
			box-shadow 160ms var(--pl-ease);
	}

	.sw--on .sw-track {
		background: linear-gradient(180deg, rgba(87, 247, 255, 0.36), rgba(63, 120, 255, 0.55));
		border-color: rgba(87, 247, 255, 0.7);
		box-shadow:
			inset 0 1px 2px rgba(0, 0, 0, 0.3),
			0 0 14px rgba(87, 247, 255, 0.45);
	}

	.sw--on .sw-knob {
		transform: translateX(18px);
		background: radial-gradient(circle at 35% 30%, #ffffff, #c9feff 55%, #7ff3ff);
		box-shadow:
			0 0 10px rgba(87, 247, 255, 0.9),
			0 1px 2px rgba(0, 0, 0, 0.4);
	}

	.sw:disabled {
		opacity: 0.35;
	}
</style>

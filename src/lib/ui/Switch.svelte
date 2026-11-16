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
		border-radius: 4px;
		text-align: left;
		transition: opacity 130ms var(--pl-ease);
	}

	.sw-label {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		color: var(--pl-dim);
	}

	@media (hover: hover) {
		.sw:hover:not(:disabled) {
			background: var(--pl-hover);
		}
		.sw:hover:not(:disabled) .sw-label {
			color: var(--pl-ink);
		}
	}

	.sw--on .sw-label {
		color: var(--pl-ink);
	}

	.sw-track {
		position: relative;
		flex: none;
		width: 34px;
		height: 18px;
		border-radius: 9px;
		background: var(--pl-bg);
		border: 1px solid var(--pl-line-strong);
		box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.4);
	}

	.sw-knob {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 12px;
		height: 12px;
		border-radius: 50%;
		background: var(--pl-faint);
		transition: transform 130ms var(--pl-ease);
	}

	.sw--on .sw-track {
		background: var(--pl-accent-soft);
		border-color: rgba(157, 182, 255, 0.5);
	}

	.sw--on .sw-knob {
		transform: translateX(16px);
		background: var(--pl-accent);
	}

	.sw:disabled {
		opacity: 0.35;
	}
</style>

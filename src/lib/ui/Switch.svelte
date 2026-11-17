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
		min-height: 40px;
		padding: 0 2px;
		border-radius: var(--pl-radius-sm);
		text-align: left;
		transition: opacity 120ms var(--pl-ease);
	}

	.sw-label {
		font-size: 12px;
		font-weight: 500;
		color: var(--pl-dim);
	}

	@media (hover: hover) {
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
		width: 40px;
		height: 22px;
		border-radius: 11px;
		background: var(--pl-sunken);
		border: 1px solid var(--pl-line-strong);
	}

	.sw-knob {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 16px;
		height: 16px;
		border-radius: 50%;
		background: var(--pl-dim);
		transition:
			transform 140ms var(--pl-ease),
			background 140ms var(--pl-ease);
	}

	.sw--on .sw-track {
		border-color: var(--pl-accent);
		background: var(--pl-accent-soft);
	}

	.sw--on .sw-knob {
		transform: translateX(18px);
		background: var(--pl-accent);
	}

	.sw:disabled {
		opacity: 0.35;
	}
</style>

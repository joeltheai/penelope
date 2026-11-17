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
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.14em;
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
		width: 40px;
		height: 22px;
		border-radius: var(--pl-radius-sm);
		background: var(--pl-sunken-bg);
		border: 1px solid var(--pl-line-strong);
		box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.75);
	}

	.sw-knob {
		position: absolute;
		top: 1px;
		left: 1px;
		width: 18px;
		height: 18px;
		border-radius: 2px;
		background: linear-gradient(180deg, #8b84ab, #4a4366);
		border: 1px solid #b0a8cc;
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.35),
			0 1px 2px rgba(0, 0, 0, 0.7);
		transition:
			transform 140ms var(--pl-ease),
			background 140ms var(--pl-ease),
			border-color 140ms var(--pl-ease);
	}

	.sw--on .sw-track {
		border-color: rgba(94, 242, 255, 0.5);
		background: linear-gradient(180deg, rgba(94, 242, 255, 0.24), #071014);
	}

	.sw--on .sw-knob {
		transform: translateX(19px);
		background: linear-gradient(180deg, #ffffff, #c9faff);
		border-color: #ffffff;
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.8),
			0 0 8px rgba(94, 242, 255, 0.5);
	}

	.sw:disabled {
		opacity: 0.35;
	}
</style>

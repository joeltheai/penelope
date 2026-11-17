<script lang="ts">
	type Option = { value: string; label: string; hint?: string; disabled?: boolean };

	let {
		options,
		value,
		label,
		onchange,
		disabled = false
	}: {
		options: Option[];
		value: string;
		label: string;
		onchange: (value: string) => void;
		disabled?: boolean;
	} = $props();
</script>

<div class="seg" role="group" aria-label={label}>
	{#each options as option (option.value)}
		<button
			type="button"
			class="seg-btn"
			class:seg-btn--on={option.value === value}
			aria-pressed={option.value === value}
			title={option.hint ?? option.label}
			disabled={disabled || option.disabled}
			onclick={() => onchange(option.value)}
		>
			{option.label}
		</button>
	{/each}
</div>

<style>
	.seg {
		display: flex;
		width: 100%;
		height: 38px;
		padding: 3px;
		gap: 3px;
		background: var(--pl-sunken);
		border: 1px solid var(--pl-line);
		border-radius: var(--pl-radius);
	}

	.seg-btn {
		flex: 1;
		min-width: 0;
		border-radius: 5px;
		color: var(--pl-dim);
		font-size: 12px;
		font-weight: 500;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		transition:
			background 100ms var(--pl-ease),
			color 100ms var(--pl-ease);
	}

	@media (hover: hover) {
		.seg-btn:hover:not(:disabled) {
			color: var(--pl-ink);
		}
	}

	.seg-btn--on,
	.seg-btn--on:hover:not(:disabled) {
		background: var(--pl-raised);
		color: var(--pl-ink);
	}

	.seg-btn:disabled {
		opacity: 0.35;
	}
</style>

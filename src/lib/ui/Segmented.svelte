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
		height: 40px;
		padding: 2px;
		gap: 2px;
		background: var(--pl-sunken-bg);
		border: 1px solid var(--pl-line);
		border-radius: var(--pl-radius-sm);
		box-shadow: inset 0 1px 3px rgba(0, 0, 0, 0.7);
	}

	.seg-btn {
		flex: 1;
		min-width: 0;
		border-radius: 2px;
		color: var(--pl-dim);
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.14em;
		text-transform: uppercase;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		transition:
			background 100ms var(--pl-ease),
			color 100ms var(--pl-ease);
	}

	@media (hover: hover) {
		.seg-btn:hover:not(:disabled) {
			background: var(--pl-hover);
			color: var(--pl-ink);
		}
	}

	.seg-btn:active:not(:disabled) {
		transform: translateY(1px);
	}

	.seg-btn--on,
	.seg-btn--on:hover:not(:disabled) {
		background: var(--pl-accent);
		color: #041016;
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.55),
			inset 0 -1px 0 rgba(0, 0, 0, 0.2);
	}

	.seg-btn:disabled {
		opacity: 0.35;
	}
</style>

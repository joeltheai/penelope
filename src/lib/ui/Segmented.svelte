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
		height: var(--pl-tap);
		padding: 3px;
		gap: 3px;
		background: var(--pl-bg);
		border: 1px solid var(--pl-line);
		border-radius: 4px;
		box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.35);
	}

	.seg-btn {
		flex: 1;
		min-width: 0;
		border-radius: 3px;
		color: var(--pl-dim);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.08em;
		text-transform: uppercase;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		transition: transform 120ms var(--pl-ease);
	}

	.seg-btn:active:not(:disabled) {
		transform: scale(0.97);
	}

	@media (hover: hover) {
		.seg-btn:hover:not(:disabled) {
			color: var(--pl-ink);
		}
	}

	.seg-btn--on {
		background: var(--pl-raised);
		color: var(--pl-ink);
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.06),
			0 1px 2px rgba(0, 0, 0, 0.35);
	}

	.seg-btn:disabled {
		opacity: 0.35;
	}
</style>

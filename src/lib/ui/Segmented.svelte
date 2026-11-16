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
		padding: 4px;
		gap: 4px;
		background: linear-gradient(180deg, rgba(0, 0, 0, 0.45), rgba(255, 255, 255, 0.03));
		border: 1px solid var(--pl-line);
		border-radius: 11px;
		box-shadow:
			inset 0 2px 5px rgba(0, 0, 0, 0.55),
			inset 0 -1px 0 rgba(255, 255, 255, 0.05);
	}

	.seg-btn {
		flex: 1;
		min-width: 0;
		border-radius: 8px;
		color: var(--pl-dim);
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.12em;
		text-transform: uppercase;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		transition:
			transform 120ms var(--pl-ease),
			color 120ms var(--pl-ease),
			background 120ms var(--pl-ease),
			box-shadow 120ms var(--pl-ease);
	}

	.seg-btn:active:not(:disabled) {
		transform: scale(0.97);
	}

	@media (hover: hover) {
		.seg-btn:hover:not(:disabled) {
			color: var(--pl-ink);
			background: rgba(87, 247, 255, 0.07);
		}
	}

	.seg-btn--on,
	.seg-btn--on:hover:not(:disabled) {
		background: linear-gradient(180deg, #b6feff 0%, #57e8ff 44%, #3d9bff 100%);
		color: #03101f;
		text-shadow: 0 1px 0 rgba(255, 255, 255, 0.55);
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.6),
			0 0 0 1px rgba(255, 255, 255, 0.3),
			0 2px 6px rgba(0, 0, 0, 0.4),
			0 0 16px rgba(87, 247, 255, 0.5);
	}

	.seg-btn:disabled {
		opacity: 0.35;
	}
</style>

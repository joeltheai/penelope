<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import type { IconName } from './icons';

	let {
		icon,
		label,
		caption = '',
		hint = '',
		active = false,
		toggle = false,
		disclosure = false,
		disabled = false,
		children,
		onclick
	}: {
		icon: IconName;
		label: string;
		caption?: string;
		hint?: string;
		active?: boolean;
		toggle?: boolean;
		disclosure?: boolean;
		disabled?: boolean;
		children?: Snippet;
		onclick?: (event: MouseEvent) => void;
	} = $props();
</script>

<button
	type="button"
	class="tb"
	class:tb--on={active}
	class:tb--captioned={Boolean(caption)}
	aria-label={label}
	title={hint || label}
	aria-pressed={toggle ? active : undefined}
	aria-expanded={disclosure ? active : undefined}
	{disabled}
	{onclick}
>
	<Icon name={icon} size={caption ? 24 : 19} strokeWidth={2} />
	{#if caption}<span class="tb-caption">{caption}</span>{/if}
	{@render children?.()}
</button>

<style>
	.tb {
		position: relative;
		display: grid;
		place-items: center;
		width: var(--pl-tap);
		height: var(--pl-tap);
		flex: none;
		border: 1px solid transparent;
		border-radius: var(--pl-radius-sm);
		color: var(--pl-dim);
		touch-action: manipulation;
		transition:
			color 120ms var(--pl-ease),
			background 120ms var(--pl-ease),
			border-color 120ms var(--pl-ease);
	}

	.tb--captioned {
		width: 64px;
		height: 56px;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.tb-caption {
		font-size: 10px;
		font-weight: 500;
		line-height: 1;
	}

	@media (hover: hover) {
		.tb:hover:not(:disabled) {
			background: var(--pl-hover);
			color: var(--pl-ink);
		}
	}

	.tb:disabled {
		opacity: 0.28;
	}

	.tb--on,
	.tb--on:hover:not(:disabled) {
		background: var(--pl-accent-soft);
		border-color: var(--pl-accent);
		color: var(--pl-accent);
	}
</style>

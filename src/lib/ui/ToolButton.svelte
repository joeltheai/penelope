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
			transform 120ms var(--pl-ease),
			color 120ms var(--pl-ease),
			background 120ms var(--pl-ease),
			border-color 120ms var(--pl-ease);
	}

	.tb--captioned {
		width: 66px;
		height: 56px;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.tb-caption {
		font-size: 8px;
		font-weight: 700;
		letter-spacing: 0.14em;
		line-height: 1;
		text-transform: uppercase;
	}

	@media (hover: hover) {
		.tb:hover:not(:disabled) {
			background: var(--pl-hover);
			border-color: var(--pl-line-strong);
			color: var(--pl-ink);
		}
	}

	.tb:active:not(:disabled) {
		transform: translateY(1px);
	}

	.tb:disabled {
		opacity: 0.28;
	}

	.tb--on,
	.tb--on:hover:not(:disabled) {
		background: var(--pl-accent);
		border-color: #b7fbff;
		color: #041016;
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.6),
			inset 0 -1px 0 rgba(0, 0, 0, 0.25);
	}

	.tb--on :global(svg) {
		filter: none;
	}
</style>

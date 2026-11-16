<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import type { IconName } from './icons';

	let {
		icon,
		label,
		hint = '',
		active = false,
		toggle = false,
		disclosure = false,
		marker = false,
		disabled = false,
		children,
		onclick
	}: {
		icon: IconName;
		label: string;
		hint?: string;
		active?: boolean;
		toggle?: boolean;
		disclosure?: boolean;
		marker?: boolean;
		disabled?: boolean;
		children?: Snippet;
		onclick?: (event: MouseEvent) => void;
	} = $props();
</script>

<button
	type="button"
	class="tb"
	class:tb--on={active}
	class:tb--marked={marker}
	aria-label={label}
	title={hint || label}
	aria-pressed={toggle ? active : undefined}
	aria-expanded={disclosure ? active : undefined}
	{disabled}
	{onclick}
>
	<Icon name={icon} />
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
		overflow: hidden;
		border-radius: 11px;
		color: var(--pl-dim);
		touch-action: manipulation;
		transition:
			transform 130ms var(--pl-ease),
			color 130ms var(--pl-ease),
			background 130ms var(--pl-ease),
			box-shadow 130ms var(--pl-ease);
	}

	/* Specular sweep across the chrome face. */
	.tb::after {
		content: '';
		position: absolute;
		inset: 0;
		border-radius: inherit;
		background: linear-gradient(155deg, rgba(255, 255, 255, 0.2), transparent 48%);
		opacity: 0;
		pointer-events: none;
		transition: opacity 130ms var(--pl-ease);
	}

	@media (hover: hover) {
		.tb:hover:not(:disabled) {
			background: rgba(87, 247, 255, 0.09);
			color: var(--pl-ink);
			box-shadow: inset 0 0 0 1px rgba(87, 247, 255, 0.2);
		}

		.tb:hover:not(:disabled)::after {
			opacity: 0.55;
		}
	}

	.tb:active:not(:disabled) {
		transform: scale(0.92);
	}

	.tb:disabled {
		opacity: 0.28;
	}

	.tb--on {
		background: var(--pl-chrome);
		color: var(--pl-accent);
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.3),
			inset 0 0 0 1px rgba(87, 247, 255, 0.28),
			0 0 16px rgba(87, 247, 255, 0.3);
	}

	.tb--on::after {
		opacity: 1;
	}

	.tb--on :global(svg) {
		filter: drop-shadow(0 0 6px rgba(87, 247, 255, 0.8));
	}

	.tb--on.tb--marked::before {
		content: '';
		position: absolute;
		left: 3px;
		top: 50%;
		width: 3px;
		height: 20px;
		translate: 0 -50%;
		border-radius: 2px;
		background: linear-gradient(180deg, #c8feff, #57f7ff 45%, #ff4bd8);
		box-shadow:
			0 0 8px rgba(87, 247, 255, 0.9),
			0 0 16px rgba(87, 247, 255, 0.4);
	}
</style>

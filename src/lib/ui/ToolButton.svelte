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
		border-radius: 4px;
		color: var(--pl-dim);
		touch-action: manipulation;
		transition:
			transform 130ms var(--pl-ease),
			opacity 130ms var(--pl-ease);
	}

	@media (hover: hover) {
		.tb:hover:not(:disabled) {
			background: var(--pl-hover);
			color: var(--pl-ink);
		}
	}

	.tb:active:not(:disabled) {
		transform: scale(0.94);
	}

	.tb:disabled {
		opacity: 0.3;
	}

	.tb--on {
		background: var(--pl-raised);
		color: var(--pl-ink);
		box-shadow: var(--pl-top-highlight);
	}

	.tb--on.tb--marked::before {
		content: '';
		position: absolute;
		left: 2px;
		top: 50%;
		width: 2px;
		height: 18px;
		translate: 0 -50%;
		border-radius: 1px;
		background: var(--pl-accent);
	}
</style>

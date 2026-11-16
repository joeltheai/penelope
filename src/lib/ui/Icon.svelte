<script lang="ts">
	import { ICONS, type IconName } from './icons';

	let {
		name,
		size = 19,
		strokeWidth = 1.7,
		class: className = ''
	}: {
		name: IconName;
		size?: number;
		strokeWidth?: number;
		class?: string;
	} = $props();
</script>

<svg
	viewBox="0 0 24 24"
	width={size}
	height={size}
	fill="none"
	stroke="currentColor"
	stroke-width={strokeWidth}
	stroke-linecap="round"
	stroke-linejoin="round"
	class={className}
	aria-hidden="true"
	focusable="false">{@html ICONS[name]}</svg
>

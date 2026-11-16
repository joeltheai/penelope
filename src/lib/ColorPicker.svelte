<script lang="ts">
	import ColorTrackSlider from '$lib/ColorTrackSlider.svelte';
	import Icon from '$lib/ui/Icon.svelte';
	import Segmented from '$lib/ui/Segmented.svelte';
	import {
		hueGradientCss,
		hsvToRgb,
		parseHex,
		rgbChannelGradient,
		rgbToHex,
		rgbToHsv,
		satGradient,
		valueGradient,
		type HSV,
		type RGB
	} from '$lib/colorUtils';

	type Mode = 'rgb' | 'hsv';

	let {
		color = $bindable('#1a6cff'),
		open = $bindable(true),
		picking = $bindable(false)
	}: {
		color?: string;
		open?: boolean;
		picking?: boolean;
	} = $props();

	const MODES = [
		{ value: 'rgb', label: 'RGB' },
		{ value: 'hsv', label: 'HSV' }
	];

	let mode = $state<Mode>('rgb');

	let rgb = $state<RGB>({ r: 26, g: 108, b: 255 });
	let hsv = $state<HSV>({ h: 217, s: 0.9, v: 1 });

	let editingHex = $state(false);
	let hexDraft = $state('#1A6CFF');

	function commitRgb(next: RGB) {
		const rounded: RGB = {
			r: Math.round(next.r),
			g: Math.round(next.g),
			b: Math.round(next.b)
		};
		rgb = rounded;
		hsv = rgbToHsv(rounded);
		color = rgbToHex(rounded);
	}

	function commitHsv(next: HSV) {
		const converted = hsvToRgb(next);
		rgb = {
			r: Math.round(converted.r),
			g: Math.round(converted.g),
			b: Math.round(converted.b)
		};
		hsv = next;
		color = rgbToHex(rgb);
	}

	function commitHex(hex: string) {
		const parsed = parseHex(hex);
		if (!parsed) return false;
		commitRgb(parsed);
		return true;
	}

	$effect(() => {
		const parsed = parseHex(color);
		if (!parsed) return;
		if (parsed.r === rgb.r && parsed.g === rgb.g && parsed.b === rgb.b) return;
		rgb = parsed;
		hsv = rgbToHsv(parsed);
	});

	$effect(() => {
		const next = rgbToHex(rgb).toUpperCase();
		if (!editingHex) hexDraft = next;
	});

	let thumb = $derived(rgbToHex(rgb));
	let redGrad = $derived(rgbChannelGradient('r', rgb));
	let greenGrad = $derived(rgbChannelGradient('g', rgb));
	let blueGrad = $derived(rgbChannelGradient('b', rgb));
	let hueGrad = $derived(hueGradientCss());
	let satGrad = $derived(satGradient(hsv));
	let valGrad = $derived(valueGradient(hsv));

	let h = $derived(Math.round(hsv.h));
	let sPct = $derived(Math.round(hsv.s * 100));
	let vPct = $derived(Math.round(hsv.v * 100));

	function onHexInput(event: Event) {
		editingHex = true;
		hexDraft = (event.currentTarget as HTMLInputElement).value;
	}

	function onHexCommit() {
		const accepted = commitHex(hexDraft);
		editingHex = false;
		hexDraft = (accepted ? rgbToHex(rgb) : color).toUpperCase();
	}

	function onHexKeyDown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			onHexCommit();
			(event.currentTarget as HTMLInputElement).blur();
		} else if (event.key === 'Escape') {
			event.stopPropagation();
			editingHex = false;
			hexDraft = color.toUpperCase();
			(event.currentTarget as HTMLInputElement).blur();
		}
	}

	function close() {
		open = false;
		picking = false;
	}

	async function toggleEyedropper() {
		if (picking) {
			picking = false;
			return;
		}

		if (window.EyeDropper) {
			try {
				const result = await new window.EyeDropper().open();
				commitHex(result.sRGBHex);
			} catch {
				// The native picker was dismissed without a sample.
			}
			return;
		}

		picking = true;
	}
</script>

<div class="picker" role="dialog" aria-label="Color picker">
	<div class="head">
		<span class="chip" style:background={color} aria-hidden="true"></span>
		<input
			class="hex pl-mono"
			type="text"
			value={hexDraft}
			maxlength="7"
			spellcheck="false"
			autocomplete="off"
			autocapitalize="characters"
			aria-label="Hex color"
			oninput={onHexInput}
			onchange={onHexCommit}
			onblur={onHexCommit}
			onkeydown={onHexKeyDown}
		/>
		<button
			type="button"
			class="icon-btn"
			class:icon-btn--on={picking}
			aria-label="Eyedropper"
			aria-pressed={picking}
			title={picking ? 'Tap the canvas to sample · Esc cancels' : 'Eyedropper (E)'}
			onclick={toggleEyedropper}
		>
			<Icon name="eyedropper" size={18} />
		</button>
		<button
			type="button"
			class="icon-btn"
			aria-label="Close color picker"
			title="Close"
			onclick={close}
		>
			<Icon name="close" size={16} />
		</button>
	</div>

	<div class="model">
		<Segmented
			label="Color model"
			options={MODES}
			value={mode}
			onchange={(next) => (mode = next as Mode)}
		/>
	</div>

	{#if mode === 'rgb'}
		<div class="tracks">
			<ColorTrackSlider
				label="Red"
				min={0}
				max={255}
				step={1}
				value={rgb.r}
				gradient={redGrad}
				thumbColor={thumb}
				onValue={(n) => commitRgb({ ...rgb, r: n })}
			/>
			<ColorTrackSlider
				label="Green"
				min={0}
				max={255}
				step={1}
				value={rgb.g}
				gradient={greenGrad}
				thumbColor={thumb}
				onValue={(n) => commitRgb({ ...rgb, g: n })}
			/>
			<ColorTrackSlider
				label="Blue"
				min={0}
				max={255}
				step={1}
				value={rgb.b}
				gradient={blueGrad}
				thumbColor={thumb}
				onValue={(n) => commitRgb({ ...rgb, b: n })}
			/>
		</div>
	{:else}
		<div class="tracks">
			<ColorTrackSlider
				label="Hue"
				min={0}
				max={360}
				step={1}
				value={h}
				gradient={hueGrad}
				thumbColor={thumb}
				onValue={(n) => commitHsv({ ...hsv, h: n })}
			/>
			<ColorTrackSlider
				label="Saturation"
				min={0}
				max={100}
				step={1}
				value={sPct}
				gradient={satGrad}
				thumbColor={thumb}
				onValue={(n) => commitHsv({ ...hsv, s: n / 100 })}
			/>
			<ColorTrackSlider
				label="Brightness"
				min={0}
				max={100}
				step={1}
				value={vPct}
				gradient={valGrad}
				thumbColor={thumb}
				onValue={(n) => commitHsv({ ...hsv, v: n / 100 })}
			/>
		</div>
	{/if}
</div>

<style>
	.picker {
		width: 252px;
		max-height: min(60vh, 380px);
		padding: 10px;
		display: flex;
		flex-direction: column;
		gap: 4px;
		overflow-y: auto;
		overscroll-behavior: contain;
		touch-action: pan-y;
		background: var(--pl-panel);
		border: 1px solid var(--pl-line-strong);
		border-radius: var(--pl-radius);
		box-shadow: var(--pl-shadow), var(--pl-top-highlight);
	}

	.head {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.chip {
		width: 30px;
		height: 30px;
		flex: none;
		border-radius: 4px;
		border: 1px solid var(--pl-line-strong);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.18);
	}

	.hex {
		flex: 1;
		min-width: 0;
		height: var(--pl-tap);
		padding: 0 8px;
		font-size: 11px;
		letter-spacing: 0.05em;
		color: var(--pl-ink);
		background: var(--pl-bg);
		border: 1px solid var(--pl-line);
		border-radius: 4px;
		text-transform: uppercase;
		-webkit-user-select: text;
		user-select: text;
	}

	.hex:focus {
		border-color: var(--pl-line-strong);
	}

	.icon-btn {
		display: grid;
		place-items: center;
		width: var(--pl-tap);
		height: var(--pl-tap);
		flex: none;
		border-radius: 4px;
		color: var(--pl-dim);
		transition: transform 130ms var(--pl-ease);
	}

	.icon-btn:active {
		transform: scale(0.94);
	}

	@media (hover: hover) {
		.icon-btn:hover {
			background: var(--pl-hover);
			color: var(--pl-ink);
		}
	}

	.icon-btn--on {
		background: var(--pl-accent-soft);
		color: var(--pl-accent);
	}

	.model {
		padding-bottom: 4px;
	}

	.tracks {
		display: flex;
		flex-direction: column;
	}
</style>

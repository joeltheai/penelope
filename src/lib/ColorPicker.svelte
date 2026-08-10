<script lang="ts">
	import ColorTrackSlider from '$lib/ColorTrackSlider.svelte';
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

	let mode = $state<Mode>('rgb');

	let rgb = $state<RGB>({ r: 26, g: 108, b: 255 });
	let hsv = $state<HSV>({ h: 217, s: 0.9, v: 1 });

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
		// Keep the HSV the user chose so hue survives zero saturation/value.
		hsv = next;
		color = rgbToHex(rgb);
	}

	function commitHex(hex: string) {
		const parsed = parseHex(hex);
		if (!parsed) return false;
		commitRgb(parsed);
		return true;
	}

	// Sync when parent changes `color` externally.
	$effect(() => {
		const parsed = parseHex(color);
		if (!parsed) return;
		if (parsed.r === rgb.r && parsed.g === rgb.g && parsed.b === rgb.b) return;
		rgb = parsed;
		hsv = rgbToHsv(parsed);
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

	function minimize() {
		open = false;
		picking = false;
	}

	function expand() {
		open = true;
	}

	async function toggleEyedropper() {
		if (picking) {
			picking = false;
			return;
		}

		// Chromium EyeDropper: system loupe, pick from anywhere on screen.
		if (typeof window.EyeDropper === 'function') {
			try {
				const result = await new window.EyeDropper().open();
				commitHex(result.sRGBHex);
			} catch {
				/* user cancelled */
			}
			return;
		}

		// Safari / iPad: custom canvas loupe (PaintCanvas).
		picking = true;
	}

	const POS_KEY = 'penelope.colorPicker';
	let posX = $state(0);
	let posY = $state(16);
	let posReady = $state(false);
	let dragging = $state(false);
	let rootEl: HTMLElement | undefined = $state();

	$effect(() => {
		if (typeof window === 'undefined') return;
		try {
			const raw = localStorage.getItem(POS_KEY);
			if (raw) {
				const saved = JSON.parse(raw) as { x: number; y: number };
				posX = saved.x;
				posY = saved.y;
			} else {
				posX = Math.max(12, window.innerWidth - 280);
				posY = 16;
			}
		} catch {
			posX = Math.max(12, window.innerWidth - 280);
			posY = 16;
		}
		posReady = true;
	});

	function clampPos(x: number, y: number) {
		const w = rootEl?.offsetWidth ?? 256;
		const h = rootEl?.offsetHeight ?? 200;
		const maxX = Math.max(0, window.innerWidth - w);
		const maxY = Math.max(0, window.innerHeight - h);
		return {
			x: Math.min(maxX, Math.max(0, x)),
			y: Math.min(maxY, Math.max(0, y))
		};
	}

	function savePos() {
		try {
			localStorage.setItem(POS_KEY, JSON.stringify({ x: posX, y: posY }));
		} catch {
			/* ignore */
		}
	}

	function onDragStart(e: PointerEvent) {
		if (e.button !== 0) return;
		const handle = e.currentTarget as HTMLElement;
		const startX = e.clientX;
		const startY = e.clientY;
		const origX = posX;
		const origY = posY;
		dragging = true;
		handle.setPointerCapture(e.pointerId);

		function onMove(ev: PointerEvent) {
			const next = clampPos(origX + (ev.clientX - startX), origY + (ev.clientY - startY));
			posX = next.x;
			posY = next.y;
		}

		function onUp(ev: PointerEvent) {
			dragging = false;
			handle.releasePointerCapture(ev.pointerId);
			handle.removeEventListener('pointermove', onMove);
			handle.removeEventListener('pointerup', onUp);
			handle.removeEventListener('pointercancel', onUp);
			const next = clampPos(posX, posY);
			posX = next.x;
			posY = next.y;
			savePos();
		}

		handle.addEventListener('pointermove', onMove);
		handle.addEventListener('pointerup', onUp);
		handle.addEventListener('pointercancel', onUp);
	}
</script>

{#if posReady}
	<div
		bind:this={rootEl}
		class="fixed z-10 flex flex-col gap-1.5"
		style:left="{posX}px"
		style:top="{posY}px"
		data-color-picker
	>
		<button
			type="button"
			class="flex h-5 w-full cursor-grab items-center justify-center rounded-md bg-[#2a2a2e] text-white/35 touch-none active:cursor-grabbing
				{dragging ? 'cursor-grabbing bg-[#34343a]' : ''}"
			aria-label="Move color picker"
			title="Drag to move"
			onpointerdown={onDragStart}
		>
			<svg
				xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 24 24"
				fill="currentColor"
				class="size-3.5"
				aria-hidden="true"
			>
				<circle cx="8" cy="8" r="1.5" />
				<circle cx="16" cy="8" r="1.5" />
				<circle cx="8" cy="16" r="1.5" />
				<circle cx="16" cy="16" r="1.5" />
			</svg>
		</button>

		{#if open}
			<div
				class="w-[16rem] rounded-xl bg-[#1e1e22] p-2.5 shadow-[0_12px_40px_rgba(0,0,0,0.55),inset_0_1px_0_rgba(255,255,255,0.06)]"
				role="group"
				aria-label="Color picker"
			>
				<div class="mb-2 flex items-center gap-1.5">
					<div
						class="size-7 shrink-0 rounded-full border border-white/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]"
						style:background={color}
						aria-hidden="true"
					></div>

					<div
						class="flex min-w-0 flex-1 rounded-lg bg-[#141416] p-0.5"
						role="tablist"
						aria-label="Color model"
					>
						<button
							type="button"
							role="tab"
							aria-selected={mode === 'rgb'}
							class="flex-1 rounded-md px-2 py-1 text-xs font-medium transition
								{mode === 'rgb'
								? 'bg-[#3a3a42] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
								: 'text-white/50 hover:text-white/75'}"
							onclick={() => (mode = 'rgb')}
						>
							RGB
						</button>
						<button
							type="button"
							role="tab"
							aria-selected={mode === 'hsv'}
							class="flex-1 rounded-md px-2 py-1 text-xs font-medium transition
								{mode === 'hsv'
								? 'bg-[#3a3a42] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
								: 'text-white/50 hover:text-white/75'}"
							onclick={() => (mode = 'hsv')}
						>
							HSV
						</button>
					</div>

					<button
						type="button"
						class="flex size-7 shrink-0 items-center justify-center rounded-md transition
							{picking
							? 'bg-[#3a3a42] text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.08)]'
							: 'text-white/45 hover:bg-white/5 hover:text-white/80'}"
						aria-label="Eyedropper"
						aria-pressed={picking}
						title={picking ? 'Drag to sample · Esc to cancel' : 'Eyedropper'}
						onclick={toggleEyedropper}
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							class="size-3.5"
							aria-hidden="true"
						>
							<path d="m2 22 1-1h3l9-9" />
							<path d="M3 21v-3l9-9" />
							<path d="m15 5 3 3" />
							<path d="M14.5 4.5c1.5-1.5 4-1.5 5.5 0s1.5 4 0 5.5L16 14l-3-3z" />
						</svg>
					</button>

					<button
						type="button"
						class="flex size-7 shrink-0 items-center justify-center rounded-md text-white/45 transition hover:bg-white/5 hover:text-white/80"
						aria-label="Minimize color picker"
						title="Minimize"
						onclick={minimize}
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							stroke-width="2"
							stroke-linecap="round"
							stroke-linejoin="round"
							class="size-3.5"
							aria-hidden="true"
						>
							<path d="M5 12h14" />
						</svg>
					</button>
				</div>

				{#if mode === 'rgb'}
					<div class="flex flex-col gap-1.5">
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
					<div class="flex flex-col gap-1.5">
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
		{:else}
			<button
				type="button"
				class="h-10 w-10 cursor-pointer self-end rounded-full border border-white/15 shadow-[inset_0_1px_0_rgba(255,255,255,0.12),0_1px_3px_rgba(0,0,0,0.4)] outline-none focus-visible:ring-2 focus-visible:ring-white/40"
				style:background={color}
				aria-label="Expand color picker"
				title="Color"
				onclick={expand}
			></button>
		{/if}
	</div>
{/if}

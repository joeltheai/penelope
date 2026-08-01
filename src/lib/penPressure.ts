// pressure stuff om its annoying

export type PenPressureState = {
	hasPressure: boolean;
	usingPen: boolean;
	prevPressure: number;
	pressure: number;
};

export function createPenPressureState(): PenPressureState {
	return {
		hasPressure: false,
		usingPen: false,
		prevPressure: 0,
		pressure: 1
	};
}

function isIOS() {
	return (
		/iPad|iPhone|iPod/.test(navigator.userAgent) ||
		(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
	);
}

/** (1) Capability flag: is this pointer giving real pressure? */
export function updateHasPressure(ev: PointerEvent, state: PenPressureState) {
	if (ev.pointerType === 'pen') {
		state.hasPressure = true;
		state.usingPen = true;
		return;
	}

	switch (ev.pressure) {
		case undefined:
			break;
		case 0.5: // Safari / Pointer Events mid placeholder while tip is down
		case 1: // often "full" default when pressure isn't real
		case 0: // up / no reading
			state.hasPressure = false;
			break;
		default:
			state.hasPressure = true;
	}
}

export function eventLooksLikeRealPressure(e: PointerEvent) {
	return e.pressure !== 0 && e.pressure !== 0.5;
}

/** (2) Read raw pressure for a dab / point. */
function readRawPressure(e: PointerEvent, state: PenPressureState) {
	let pressure = 1; // default when hasPressure is false

	if (state.hasPressure) {
		pressure = 'pressure' in e ? e.pressure : (state.pressure ?? 1);

		// (2a) Known junk placeholders
		if (pressure === 0.07999999821186066) pressure = 0.01;
		// Exact 0.5 is the Pointer Events "tip down, no real reading" mid value.
		// For pen, hasPressure is true, so we must still reject this here.
		if (pressure === 0.5) {
			pressure = state.prevPressure > 0 ? state.prevPressure : 0.01;
		}

		// (2b) Platform scale — iOS reports a soft range
		if (isIOS()) pressure = Math.min(1, pressure * 2.6);
		else pressure = Math.min(1, pressure);
	}

	return pressure;
}

/** (3) First contact: never trust down-event pressure for brush size. */
function applyDownOverride(e: PointerEvent, pressure: number) {
	if (e.type === 'pointerdown') return 0.01;
	return pressure;
}

/** (4) Smooth later samples so size doesn't jump when real pressure arrives. */
function smoothPressure(pressure: number, prevPressure: number, e: PointerEvent, factor = 0.5) {
	if (prevPressure > 0 && e.type !== 'pointerdown') {
		return pressure * (1 - factor) + prevPressure * factor;
	}
	return pressure;
}

/**
 * (5) Full pipeline — call once per pointer sample while drawing.
 * Returns a value in (0, 1] suitable for brush size.
 */
export function getStrokePressure(e: PointerEvent, state: PenPressureState) {
	let pressure = readRawPressure(e, state);
	pressure = smoothPressure(pressure, state.prevPressure, e);
	pressure = applyDownOverride(e, pressure);

	if (pressure === 0) pressure = 0.01;

	state.prevPressure = pressure;
	state.pressure = pressure;
	return pressure;
}

/** Ease-out curve so mid press reaches near-max size sooner. */
export function mapPressureCurve(raw: number) {
	if (raw <= 0) return 0;
	return Math.pow(Math.min(1, raw), 0.45);
}

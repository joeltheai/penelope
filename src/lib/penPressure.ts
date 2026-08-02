// pressure stuff om its annoying
/**
 * Pen pressure pipeline inspired by Procreate + Krita:
 *
 * - Procreate "Pressure" stabilize: moving average of pressure; rises slowly,
 *   falls faster so an opening spike settles instead of locking in a fat dab.
 * - Krita delay / stroke-start ramp: early dabs ease up from near-zero over
 *   the first stretch of the stroke, so Safari's fake mid pressure can't
 *   stamp a full-size opener.
 *
 * Also rejects Pointer Events placeholders (0 / 0.5 / known junk).
 */

export type PenPressureState = {
	hasPressure: boolean;
	usingPen: boolean;
	prevPressure: number;
	pressure: number;
	/** Screen-space distance traveled since stroke start (for start ramp). */
	strokeDist: number;
};

export function createPenPressureState(): PenPressureState {
	return {
		hasPressure: false,
		usingPen: false,
		prevPressure: 0,
		pressure: 1,
		strokeDist: 0
	};
}

/** Call at the start of each stroke. */
export function resetStrokePressure(state: PenPressureState) {
	state.prevPressure = 0;
	state.pressure = 1;
	state.strokeDist = 0;
}

export function addStrokeDistance(state: PenPressureState, distPx: number) {
	if (distPx > 0) state.strokeDist += distPx;
}

function isIOS() {
	return (
		/iPad|iPhone|iPod/.test(navigator.userAgent) ||
		(navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
	);
}

export function updateHasPressure(ev: PointerEvent, state: PenPressureState) {
	if (ev.pointerType === 'pen') {
		state.hasPressure = true;
		state.usingPen = true;
		return;
	}

	state.usingPen = false;
	switch (ev.pressure) {
		case undefined:
			break;
		case 0.5:
		case 1:
		case 0:
			state.hasPressure = false;
			break;
		default:
			state.hasPressure = true;
	}
}

export function eventLooksLikeRealPressure(e: PointerEvent) {
	return e.pressure !== 0 && e.pressure !== 0.5;
}

function readRawPressure(e: PointerEvent, state: PenPressureState) {
	let pressure = 1;

	if (state.hasPressure) {
		pressure = 'pressure' in e ? e.pressure : (state.pressure ?? 1);

		if (pressure === 0.07999999821186066) pressure = 0.01;
		// Pointer Events mid placeholder while tip is down
		if (pressure === 0.5) {
			pressure = state.prevPressure > 0 ? state.prevPressure : 0.01;
		}

		if (isIOS()) pressure = Math.min(1, pressure * 2.6);
		else pressure = Math.min(1, pressure);
	}

	return pressure;
}

/**
 * Procreate-style Pressure stabilize: slow to grow, fast to shrink.
 * Kills the common "opens fat, then settles" Safari spike.
 */
function smoothPressure(pressure: number, prevPressure: number, e: PointerEvent) {
	if (prevPressure <= 0 || e.type === 'pointerdown') return pressure;
	const rising = pressure > prevPressure;
	// Higher factor = more weight on previous (more inertia)
	const factor = rising ? 0.82 : 0.28;
	return pressure * (1 - factor) + prevPressure * factor;
}

/**
 * Krita-like stroke-start ramp: over the first ~RAMP_PX of motion, blend from
 * a tiny opener toward the smoothed pressure. At rest (dist 0) → near-zero.
 */
function applyStartRamp(pressure: number, state: PenPressureState) {
	if (!state.usingPen) return pressure;
	const RAMP_PX = 56;
	const t = Math.min(1, state.strokeDist / RAMP_PX);
	const w = t * t * (3 - 2 * t); // smoothstep
	return pressure * w + 0.02 * (1 - w);
}

function applyDownOverride(e: PointerEvent, pressure: number) {
	if (e.type === 'pointerdown') return 0.02;
	return pressure;
}

export function getStrokePressure(e: PointerEvent, state: PenPressureState) {
	let pressure = readRawPressure(e, state);
	pressure = smoothPressure(pressure, state.prevPressure, e);
	pressure = applyDownOverride(e, pressure);
	pressure = applyStartRamp(pressure, state);

	if (pressure <= 0) pressure = 0.02;

	state.prevPressure = pressure;
	state.pressure = pressure;
	return pressure;
}

/** Ease-out curve so mid press reaches near-max size sooner. */
export function mapPressureCurve(raw: number) {
	if (raw <= 0) return 0;
	return Math.pow(Math.min(1, raw), 0.45);
}

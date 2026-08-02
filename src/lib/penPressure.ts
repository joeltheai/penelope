/**
 * Pressure pipeline inspired by Krita + Procreate.
 *
 * Krita (kis_tool_freehand_helper.cpp — stabilizeSensors):
 *   Uniform running average over a deque of recent samples
 *   (incremental mean with k = (i-1)/i).
 *
 * Procreate "Pressure" stabilize:
 *   Heavy low-pass so size eases instead of stair-stepping with each event.
 *
 * Plus: stroke-start ramp so Safari's fake mid pressure can't open fat.
 */

export type PenPressureState = {
	hasPressure: boolean;
	usingPen: boolean;
	prevPressure: number;
	pressure: number;
	strokeDist: number;
	/** Recent raw pressures for Krita-style uniform averaging. */
	history: number[];
	lastSmoothTime: number;
};

/** How many recent samples to average (Krita stabilizer deque depth). */
const HISTORY_SIZE = 14;
/** Time-constant for secondary EMA (ms) — Procreate-like settle. */
const SMOOTH_TAU_MS = 55;
/** Screen px over which stroke-start ramp opens (Krita delay-zone feel). */
const RAMP_PX = 48;

export function createPenPressureState(): PenPressureState {
	return {
		hasPressure: false,
		usingPen: false,
		prevPressure: 0,
		pressure: 1,
		strokeDist: 0,
		history: [],
		lastSmoothTime: 0
	};
}

export function resetStrokePressure(state: PenPressureState) {
	state.prevPressure = 0;
	state.pressure = 1;
	state.strokeDist = 0;
	state.history.length = 0;
	state.lastSmoothTime = 0;
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
		if (pressure === 0.5) {
			pressure = state.prevPressure > 0 ? state.prevPressure : 0.01;
		}

		if (isIOS()) pressure = Math.min(1, pressure * 2.6);
		else pressure = Math.min(1, pressure);
	}

	return pressure;
}

/**
 * Krita stabilizeSensors: uniform average over the last HISTORY_SIZE samples.
 * Same recurrence as getStabilizedPaintInfo: k = (i-1)/i.
 */
function uniformAverage(history: number[]): number {
	if (history.length === 0) return 0;
	let avg = history[0]!;
	for (let i = 1; i < history.length; i++) {
		const k = i / (i + 1);
		avg = avg * k + history[i]! * (1 - k);
	}
	return avg;
}

/**
 * Time-based EMA on top of the window average (frame-rate independent).
 * Rise is slower than fall so opening spikes settle quickly.
 */
function timeEma(target: number, prev: number, state: PenPressureState, isDown: boolean) {
	if (prev <= 0 || isDown) return target;

	const now = performance.now();
	const dt = state.lastSmoothTime > 0 ? Math.min(64, Math.max(0, now - state.lastSmoothTime)) : 16;
	state.lastSmoothTime = now;

	const rising = target > prev;
	const tau = rising ? SMOOTH_TAU_MS * 1.55 : SMOOTH_TAU_MS * 0.65;
	const alpha = 1 - Math.exp(-dt / tau);
	return prev + (target - prev) * alpha;
}

/** Krita delay-zone style: ease from tiny → full over first RAMP_PX of motion. */
function applyStartRamp(pressure: number, state: PenPressureState) {
	if (!state.usingPen) return pressure;
	const t = Math.min(1, state.strokeDist / RAMP_PX);
	const w = t * t * (3 - 2 * t);
	return pressure * w + 0.02 * (1 - w);
}

export function getStrokePressure(e: PointerEvent, state: PenPressureState) {
	const isDown = e.type === 'pointerdown';
	let raw = readRawPressure(e, state);

	if (isDown) {
		raw = 0.02;
		state.history.length = 0;
		state.history.push(raw);
		state.lastSmoothTime = performance.now();
		state.prevPressure = raw;
		state.pressure = raw;
		return applyStartRamp(raw, state);
	}

	state.history.push(raw);
	while (state.history.length > HISTORY_SIZE) state.history.shift();

	let pressure = uniformAverage(state.history);
	pressure = timeEma(pressure, state.prevPressure, state, false);
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

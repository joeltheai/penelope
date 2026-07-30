import type { PointerSample } from "../input/pointer";

type MetricName =
  | "inputAge"
  | "strokeWork"
  | "rafWait"
  | "composite"
  | "frameInterval";

type MetricSummary = {
  p50: number;
  p95: number;
  max: number;
};

const MAX_SAMPLES_PER_METRIC = 512;

function summarize(values: number[]): MetricSummary | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0;
  return {
    p50: percentile(0.5),
    p95: percentile(0.95),
    max: sorted[sorted.length - 1] ?? 0,
  };
}

function format(summary: MetricSummary | null): string {
  if (!summary) return "—";
  return `${summary.p50.toFixed(1)} / ${summary.p95.toFixed(1)} ms`;
}

/**
 * Lightweight, opt-in JavaScript pipeline telemetry. Enable with `?perf=1`.
 *
 * These values stop at Canvas submission; they do not include browser
 * compositing, display scanout, or physical Pencil hardware latency.
 */
export class InkPerformanceMonitor {
  readonly #enabled: boolean;
  readonly #metrics: Record<MetricName, number[]> = {
    inputAge: [],
    strokeWork: [],
    rafWait: [],
    composite: [],
    frameInterval: [],
  };
  #panel: HTMLDivElement | null = null;
  #lastFrameTime: number | null = null;
  #actualSamples = 0;
  #predictedSamples = 0;
  #dabs = 0;

  constructor(enabled: boolean) {
    this.#enabled = enabled;
    if (enabled) this.#panel = this.#createPanel();
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  startStroke(sample: PointerSample): void {
    if (!this.#enabled) return;
    for (const values of Object.values(this.#metrics)) values.length = 0;
    this.#lastFrameTime = null;
    this.#actualSamples = 0;
    this.#predictedSamples = 0;
    this.#dabs = 0;
    this.recordInput([sample]);
    this.#render("Recording stroke…");
  }

  recordInput(samples: PointerSample[]): void {
    if (!this.#enabled || samples.length === 0) return;
    this.#actualSamples += samples.length;
    const newest = samples[samples.length - 1];
    if (!newest) return;

    const age = performance.now() - newest.timeStamp;
    // Event timestamps should share performance.timeOrigin. Ignore legacy or
    // cross-origin timestamp formats instead of reporting nonsense.
    if (age >= 0 && age < 1_000) this.#record("inputAge", age);
  }

  recordPredictions(count: number): void {
    if (!this.#enabled) return;
    this.#predictedSamples += count;
  }

  recordStrokeWork(duration: number, dabCount: number): void {
    if (!this.#enabled) return;
    this.#dabs += dabCount;
    this.#record("strokeWork", duration);
  }

  recordFrame(
    requestedAt: number,
    frameTime: number,
    compositeDuration: number,
  ): void {
    if (!this.#enabled) return;
    this.#record("rafWait", Math.max(0, frameTime - requestedAt));
    this.#record("composite", compositeDuration);
    if (this.#lastFrameTime !== null) {
      this.#record("frameInterval", frameTime - this.#lastFrameTime);
    }
    this.#lastFrameTime = frameTime;
  }

  recordSynchronousComposite(duration: number): void {
    if (!this.#enabled) return;
    this.#record("composite", duration);
  }

  finishStroke(): void {
    if (!this.#enabled) return;
    const summary = this.#summary();
    this.#render(
      [
        "JS pipeline (p50 / p95)",
        `Input age      ${format(summary.inputAge)}`,
        `rAF wait       ${format(summary.rafWait)}`,
        `Frame interval ${format(summary.frameInterval)}`,
        `Stroke CPU     ${format(summary.strokeWork)}`,
        `Composite CPU  ${format(summary.composite)}`,
        `Samples ${this.#actualSamples} actual · ${this.#predictedSamples} predicted · ${this.#dabs} dabs`,
      ].join("\n"),
    );
    console.info("[Penelope ink performance]", {
      ...summary,
      actualSamples: this.#actualSamples,
      predictedSamples: this.#predictedSamples,
      dabs: this.#dabs,
      note: "JavaScript pipeline only; excludes compositor and display scanout.",
    });
  }

  #record(name: MetricName, value: number): void {
    if (!Number.isFinite(value) || value < 0) return;
    const values = this.#metrics[name];
    if (values.length < MAX_SAMPLES_PER_METRIC) values.push(value);
  }

  #summary(): Record<MetricName, MetricSummary | null> {
    return {
      inputAge: summarize(this.#metrics.inputAge),
      strokeWork: summarize(this.#metrics.strokeWork),
      rafWait: summarize(this.#metrics.rafWait),
      composite: summarize(this.#metrics.composite),
      frameInterval: summarize(this.#metrics.frameInterval),
    };
  }

  #render(text: string): void {
    if (this.#panel) this.#panel.textContent = text;
  }

  #createPanel(): HTMLDivElement {
    const panel = document.createElement("div");
    panel.setAttribute("role", "status");
    panel.setAttribute("aria-live", "polite");
    Object.assign(panel.style, {
      position: "fixed",
      right: "max(10px, env(safe-area-inset-right))",
      bottom: "max(10px, env(safe-area-inset-bottom))",
      zIndex: "1000",
      maxWidth: "min(360px, calc(100vw - 20px))",
      padding: "10px 12px",
      borderRadius: "6px",
      background: "rgba(12, 14, 19, 0.9)",
      color: "#f4f1ea",
      border: "1px solid rgba(244, 241, 234, 0.24)",
      font: "12px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace",
      whiteSpace: "pre-wrap",
      pointerEvents: "none",
    });
    panel.textContent = "Ink performance ready";
    document.body.append(panel);
    return panel;
  }
}

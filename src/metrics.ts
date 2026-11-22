import type { TitleMode } from "./config.js";
import type { GenerationResult, TitleSource, TurnStatus } from "./types.js";

export type Outcome = "success" | "fallback" | "failed" | "cancelled";

export interface LastRun {
	readonly at: number;
	readonly mode: TitleMode;
	readonly source: TitleSource | undefined;
	readonly outcome: Outcome;
	readonly attempts: number;
	readonly invalidAttempts: number;
	readonly providerErrors: number;
	readonly timeouts: number;
	readonly latencyMs: number;
	readonly turnStatus: TurnStatus;
	readonly model: string | undefined;
	readonly error: string | undefined;
	readonly preview: boolean;
}

export interface MetricsSnapshot {
	readonly runs: number;
	readonly previewRuns: number;
	readonly successes: number;
	readonly fallbacks: number;
	readonly failures: number;
	readonly cancelled: number;
	readonly toolTitles: number;
	readonly textTitles: number;
	readonly retries: number;
	readonly invalidAttempts: number;
	readonly providerErrors: number;
	readonly timeouts: number;
	readonly totalLatencyMs: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly cost: number;
	readonly modeRuns: Readonly<Record<TitleMode, number>>;
	readonly last: LastRun | undefined;
}

function outcomeOf(result: GenerationResult): Outcome {
	if (result.cancelled) return "cancelled";
	if (result.title && result.source === "fallback") return "fallback";
	if (result.title) return "success";
	return "failed";
}

export class Metrics {
	private runs = 0;
	private previewRuns = 0;
	private successes = 0;
	private fallbacks = 0;
	private failures = 0;
	private cancelled = 0;
	private toolTitles = 0;
	private textTitles = 0;
	private retries = 0;
	private invalidAttempts = 0;
	private providerErrors = 0;
	private timeouts = 0;
	private totalLatencyMs = 0;
	private inputTokens = 0;
	private outputTokens = 0;
	private cost = 0;
	private modeRuns: Record<TitleMode, number> = { tool: 0, text: 0 };
	private last: LastRun | undefined;

	record(result: GenerationResult, options: { preview: boolean; at?: number }): void {
		const outcome = outcomeOf(result);
		this.runs += 1;
		if (options.preview) this.previewRuns += 1;
		this.modeRuns[result.mode] += 1;
		this.retries += Math.max(0, result.attempts - 1);
		this.invalidAttempts += result.invalidAttempts;
		this.providerErrors += result.providerErrors;
		this.timeouts += result.timeouts;
		this.totalLatencyMs += result.latencyMs;
		this.inputTokens += result.usage.input;
		this.outputTokens += result.usage.output;
		this.cost += result.usage.cost;

		if (outcome === "success") this.successes += 1;
		else if (outcome === "fallback") this.fallbacks += 1;
		else if (outcome === "failed") this.failures += 1;
		else this.cancelled += 1;

		if (result.source === "tool") this.toolTitles += 1;
		if (result.source === "text") this.textTitles += 1;

		this.last = {
			at: options.at ?? Date.now(),
			mode: result.mode,
			source: result.source,
			outcome,
			attempts: result.attempts,
			invalidAttempts: result.invalidAttempts,
			providerErrors: result.providerErrors,
			timeouts: result.timeouts,
			latencyMs: result.latencyMs,
			turnStatus: result.turnStatus,
			model: result.model,
			error: result.error,
			preview: options.preview,
		};
	}

	snapshot(): MetricsSnapshot {
		return {
			runs: this.runs,
			previewRuns: this.previewRuns,
			successes: this.successes,
			fallbacks: this.fallbacks,
			failures: this.failures,
			cancelled: this.cancelled,
			toolTitles: this.toolTitles,
			textTitles: this.textTitles,
			retries: this.retries,
			invalidAttempts: this.invalidAttempts,
			providerErrors: this.providerErrors,
			timeouts: this.timeouts,
			totalLatencyMs: this.totalLatencyMs,
			inputTokens: this.inputTokens,
			outputTokens: this.outputTokens,
			cost: this.cost,
			modeRuns: { ...this.modeRuns },
			last: this.last,
		};
	}
}

function formatSeconds(ms: number): string {
	return `${(ms / 1_000).toFixed(1)}s`;
}

export function formatMetrics(snapshot: MetricsSnapshot): string[] {
	const lines: string[] = [];
	const avg = snapshot.runs > 0 ? snapshot.totalLatencyMs / snapshot.runs : 0;
	lines.push(
		`runs ${snapshot.runs}` +
			` | tool ${snapshot.toolTitles}` +
			` | text ${snapshot.textTitles}` +
			` | fallback ${snapshot.fallbacks}` +
			` | failed ${snapshot.failures}` +
			` | cancelled ${snapshot.cancelled}`,
	);
	lines.push(
		`retries ${snapshot.retries}` +
			` | invalid ${snapshot.invalidAttempts}` +
			` | provider errors ${snapshot.providerErrors}` +
			` | timeouts ${snapshot.timeouts}` +
			` | avg ${formatSeconds(avg)}`,
	);
	lines.push(
		`tokens in ${snapshot.inputTokens} | out ${snapshot.outputTokens}` +
			` | cost $${snapshot.cost.toFixed(4)}`,
	);
	lines.push(
		`mode runs: tool ${snapshot.modeRuns.tool} | text ${snapshot.modeRuns.text}` +
			(snapshot.previewRuns > 0 ? ` | previews ${snapshot.previewRuns}` : ""),
	);
	if (snapshot.last) {
		const last = snapshot.last;
		const source = last.source ? ` source=${last.source}` : "";
		const error = last.error && last.outcome !== "success" ? ` error=${last.error}` : "";
		lines.push(
			`last: ${last.outcome}${source} ${formatSeconds(last.latencyMs)}` +
				` attempts=${last.attempts} status=${last.turnStatus}` +
				` mode=${last.mode}${last.preview ? " preview" : ""}${error}`,
		);
	}
	return lines;
}

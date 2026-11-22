import { describe, expect, it } from "vitest";

import { Metrics, formatMetrics } from "./metrics.js";
import type { GenerationResult } from "./types.js";

function result(overrides: Partial<GenerationResult> = {}): GenerationResult {
	return {
		title: "Fix login",
		source: "tool",
		attempts: 1,
		invalidAttempts: 0,
		providerErrors: 0,
		timeouts: 0,
		latencyMs: 100,
		error: undefined,
		cancelled: false,
		mode: "tool",
		model: "test/model",
		turnStatus: "completed",
		usage: { input: 0, output: 0, cost: 0 },
		...overrides,
	};
}

describe("Metrics", () => {
	it("counts outcomes, sources, and retries", () => {
		const metrics = new Metrics();
		metrics.record(result(), { preview: false, at: 1 });
		metrics.record(
			result({ source: "fallback", title: "Fix login", attempts: 2, invalidAttempts: 1 }),
			{ preview: false, at: 2 },
		);
		metrics.record(result({ source: "text", mode: "text", title: "Fix login" }), {
			preview: true,
			at: 3,
		});
		metrics.record(result({ title: undefined, source: undefined, error: "bad" }), {
			preview: false,
			at: 4,
		});
		metrics.record(result({ cancelled: true, title: undefined, source: undefined }), {
			preview: false,
			at: 5,
		});

		const snapshot = metrics.snapshot();
		expect(snapshot.runs).toBe(5);
		expect(snapshot.previewRuns).toBe(1);
		expect(snapshot.successes).toBe(2);
		expect(snapshot.fallbacks).toBe(1);
		expect(snapshot.failures).toBe(1);
		expect(snapshot.cancelled).toBe(1);
		expect(snapshot.toolTitles).toBe(1);
		expect(snapshot.textTitles).toBe(1);
		expect(snapshot.retries).toBe(1);
		expect(snapshot.modeRuns).toEqual({ tool: 4, text: 1 });
	});

	it("accumulates tokens and cost and shows them", () => {
		const metrics = new Metrics();
		metrics.record(result({ usage: { input: 100, output: 10, cost: 0.0012 } }), { preview: false, at: 1 });
		metrics.record(result({ usage: { input: 50, output: 5, cost: 0.0003 } }), { preview: true, at: 2 });
		const snapshot = metrics.snapshot();
		expect(snapshot.inputTokens).toBe(150);
		expect(snapshot.outputTokens).toBe(15);
		expect(snapshot.cost).toBeCloseTo(0.0015);
		expect(formatMetrics(snapshot).join("\n")).toContain("tokens in 150 | out 15 | cost $0.0015");
	});

	it("formats a compact status block", () => {
		const metrics = new Metrics();
		metrics.record(result(), { preview: false, at: 1 });
		const text = formatMetrics(metrics.snapshot()).join("\n");
		expect(text).toContain("runs 1");
		expect(text).toContain("tool 1");
		expect(text).toContain("last: success");
	});
});

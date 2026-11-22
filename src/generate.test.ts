import { describe, expect, it, vi } from "vitest";

import { generateTitle, type GenerationOptions } from "./generate.js";
import {
	fakeAssistant,
	fakeModel,
	textContent,
	toolCallContent,
	ZERO_USAGE,
} from "./test-utils.js";
import type { TitleInput } from "./types.js";

function input(overrides: Partial<TitleInput> = {}): TitleInput {
	return {
		userMessages: ["Fix login"],
		assistantText: "I found the bug in auth.ts",
		toolTrace: "",
		status: "completed",
		...overrides,
	};
}

function options(overrides: Partial<GenerationOptions> = {}): GenerationOptions {
	const controller = new AbortController();
	return {
		model: fakeModel,
		input: input(),
		mode: "tool",
		maxChars: 50,
		timeoutMs: 1_000,
		fallback: true,
		maxInputChars: 8_000,
		signal: controller.signal,
		complete: vi.fn(async () => fakeAssistant([toolCallContent("Fix login")])),
		now: () => 0,
		randomId: () => "id",
		sleep: async () => {},
		...overrides,
	};
}

describe("generateTitle", () => {
	it("extracts a tool title in tool mode", async () => {
		const complete = vi.fn<GenerationOptions["complete"]>(async () =>
			fakeAssistant([toolCallContent("Fix login")]),
		);
		const result = await generateTitle(options({ complete }));
		expect(result).toMatchObject({
			title: "Fix login",
			source: "tool",
			attempts: 1,
			invalidAttempts: 0,
			cancelled: false,
		});
		const context = complete.mock.calls[0]?.[1];
		expect(context?.tools?.[0]?.name).toBe("submit_session_title");
	});

	it("does not parse text in tool mode and retries once", async () => {
		const complete = vi.fn(async () => fakeAssistant([textContent("Fix login")]));
		const result = await generateTitle(options({ complete, fallback: false }));
		expect(result.title).toBeUndefined();
		expect(result.invalidAttempts).toBe(2);
		expect(result.attempts).toBe(2);
		expect(complete).toHaveBeenCalledTimes(2);
	});

	it("uses the fallback title after invalid output when enabled", async () => {
		const complete = vi.fn(async () => fakeAssistant([textContent("Fix login")]));
		const result = await generateTitle(options({ complete }));
		expect(result.title).toBe("Fix login");
		expect(result.source).toBe("fallback");
	});

	it("parses text in text mode without sending tools", async () => {
		const complete = vi.fn<GenerationOptions["complete"]>(async () =>
			fakeAssistant([textContent("Title: Fix login.")]),
		);
		const result = await generateTitle(options({ complete, mode: "text" }));
		expect(result.title).toBe("Fix login");
		expect(result.source).toBe("text");
		const context = complete.mock.calls[0]?.[1];
		expect(context?.tools).toBeUndefined();
	});

	it("retries after an invalid first response", async () => {
		const complete = vi
			.fn<GenerationOptions["complete"]>()
			.mockResolvedValueOnce(fakeAssistant([textContent("not a tool call")]))
			.mockResolvedValueOnce(fakeAssistant([toolCallContent("Fix login")]));
		const result = await generateTitle(options({ complete }));
		expect(result.attempts).toBe(2);
		expect(result.invalidAttempts).toBe(1);
		expect(result.source).toBe("tool");
	});

	it("retries a fast provider error once", async () => {
		const complete = vi
			.fn<GenerationOptions["complete"]>()
			.mockRejectedValueOnce(new Error("network"))
			.mockResolvedValueOnce(fakeAssistant([toolCallContent("Fix login")]));
		const result = await generateTitle(options({ complete }));
		expect(result.attempts).toBe(2);
		expect(result.providerErrors).toBe(1);
		expect(result.title).toBe("Fix login");
	});

	it("adds the correction only after an invalid response, not after a provider error", async () => {
		const promptOf = (call: Parameters<GenerationOptions["complete"]> | undefined): string => {
			const part = call?.[1].messages[0]?.content;
			return Array.isArray(part) && part[0]?.type === "text" ? part[0].text : "";
		};

		const afterError = vi
			.fn<GenerationOptions["complete"]>()
			.mockRejectedValueOnce(new Error("network"))
			.mockResolvedValueOnce(fakeAssistant([toolCallContent("Fix login")]));
		await generateTitle(options({ complete: afterError }));
		expect(promptOf(afterError.mock.calls[1])).not.toContain("previous response");

		const afterInvalid = vi
			.fn<GenerationOptions["complete"]>()
			.mockResolvedValueOnce(fakeAssistant([textContent("Fix login")]))
			.mockResolvedValueOnce(fakeAssistant([toolCallContent("Fix login")]));
		await generateTitle(options({ complete: afterInvalid }));
		expect(promptOf(afterInvalid.mock.calls[0])).not.toContain("previous response");
		expect(promptOf(afterInvalid.mock.calls[1])).toContain("did not call submit_session_title");
	});

	it("sums usage across attempts", async () => {
		const withUsage = (input: number, output: number, total: number) => ({
			...fakeAssistant([textContent("no tool call")]),
			usage: { ...ZERO_USAGE, input, output, cost: { ...ZERO_USAGE.cost, total } },
		});
		const complete = vi
			.fn<GenerationOptions["complete"]>()
			.mockResolvedValueOnce(withUsage(100, 10, 0.001))
			.mockResolvedValueOnce(withUsage(120, 12, 0.002));
		const result = await generateTitle(options({ complete }));
		expect(result.usage.input).toBe(220);
		expect(result.usage.output).toBe(22);
		expect(result.usage.cost).toBeCloseTo(0.003);
	});

	it("does not retry a timeout", async () => {
		const complete: GenerationOptions["complete"] = async (
			_model,
			_context,
			requestOptions,
		) =>
			new Promise((_resolve, reject) => {
				requestOptions.signal?.addEventListener(
					"abort",
					() => reject(new Error("aborted")),
					{ once: true },
				);
			});
		const result = await generateTitle(
			options({
				complete,
				timeoutMs: 1,
				fallback: false,
			}),
		);
		expect(result.attempts).toBe(1);
		expect(result.timeouts).toBe(1);
		expect(result.title).toBeUndefined();
	});

	it("returns cancelled when the caller aborts", async () => {
		const controller = new AbortController();
		controller.abort();
		const result = await generateTitle(options({ signal: controller.signal }));
		expect(result.cancelled).toBe(true);
		expect(result.attempts).toBe(0);
	});
});

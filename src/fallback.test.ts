import { describe, expect, it } from "vitest";

import { fallbackTitle } from "./fallback.js";
import type { TitleInput } from "./types.js";

function input(overrides: Partial<TitleInput> = {}): TitleInput {
	return {
		userMessages: ["Fix login"],
		assistantText: "",
		toolTrace: "",
		status: "completed",
		...overrides,
	};
}

describe("fallbackTitle", () => {
	it("uses the first substantive prompt line", () => {
		expect(fallbackTitle(input({ userMessages: ["\n```\nFix login\n```"] }), 50)).toBe("Fix login");
	});

	it("strips list and quote decorations", () => {
		expect(fallbackTitle(input({ userMessages: ["- Fix login."] }), 50)).toBe("Fix login");
		expect(fallbackTitle(input({ userMessages: ["> Fix login"] }), 50)).toBe("Fix login");
	});

	it("falls back to assistant text when the prompt has no usable line", () => {
		expect(
			fallbackTitle(
				input({ userMessages: ["```"], assistantText: "I'll update the auth flow" }),
				50,
			),
		).toBe("update the auth flow");
	});

	it("truncates and returns undefined for empty input", () => {
		const title = fallbackTitle(input({ userMessages: ["x".repeat(100)] }), 20);
		expect(Array.from(title ?? "")).toHaveLength(20);
		expect(fallbackTitle(input({ userMessages: ["   "], assistantText: "  " }), 50)).toBeUndefined();
	});
});

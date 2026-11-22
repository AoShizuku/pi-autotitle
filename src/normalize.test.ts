import { describe, expect, it } from "vitest";

import { extractTextTitle, extractToolTitle, normalizeTitle } from "./normalize.js";
import { fakeAssistant, textContent, toolCallContent } from "./test-utils.js";

describe("normalizeTitle", () => {
	it("accepts plain titles", () => {
		expect(normalizeTitle("Fix login redirect loop", 50)).toBe("Fix login redirect loop");
	});

	it("strips prefixes, quotes, markdown, and trailing punctuation", () => {
		expect(normalizeTitle('Title: "Fix login."', 50)).toBe("Fix login");
		expect(normalizeTitle("**Fix login**", 50)).toBe("Fix login");
		expect(normalizeTitle("# Fix login", 50)).toBe("Fix login");
		expect(normalizeTitle("- Fix login", 50)).toBe("Fix login");
		expect(normalizeTitle("> Fix login", 50)).toBe("Fix login");
		expect(normalizeTitle("「修复登录」", 50)).toBe("修复登录");
	});

	it("handles code fences and JSON", () => {
		expect(normalizeTitle("```text\nFix login\n```", 50)).toBe("Fix login");
		expect(normalizeTitle('{"title":"Fix login","reason":"x"}', 50)).toBe("Fix login");
		expect(normalizeTitle('```json\n{"title":"Fix login"}\n```', 50)).toBe("Fix login");
	});

	it("takes the first substantive line", () => {
		expect(normalizeTitle("Here is the title: Fix login", 50)).toBe("Fix login");
		expect(normalizeTitle("Sure, here's a title: Fix login", 50)).toBe("Fix login");
		expect(normalizeTitle("Fix login\nThis captures the task.", 50)).toBe("Fix login");
	});

	it("strips ANSI and control characters", () => {
		expect(normalizeTitle("\u001b[31mFix login\u001b[0m", 50)).toBe("Fix login");
		expect(normalizeTitle("Fix\u0000 login", 50)).toBe("Fix login");
	});

	it("rejects empty, generic, and refusal titles", () => {
		expect(normalizeTitle("   ", 50)).toBeUndefined();
		expect(normalizeTitle("Session", 50)).toBeUndefined();
		expect(normalizeTitle("I can't help with that", 50)).toBeUndefined();
	});

	it("truncates by code point", () => {
		const title = normalizeTitle("🚀".repeat(80), 50);
		expect(Array.from(title ?? "")).toHaveLength(50);
	});
});

describe("extractToolTitle", () => {
	it("reads a valid submit_session_title call", () => {
		const message = fakeAssistant([toolCallContent("Fix login")]);
		expect(extractToolTitle(message, 50)).toBe("Fix login");
	});

	it("ignores other tools and malformed arguments", () => {
		const other = fakeAssistant([
			{ type: "toolCall", id: "1", name: "edit", arguments: { title: "Nope" } },
		]);
		expect(extractToolTitle(other, 50)).toBeUndefined();

		const malformed = fakeAssistant([
			{ type: "toolCall", id: "2", name: "submit_session_title", arguments: {} },
		]);
		expect(extractToolTitle(malformed, 50)).toBeUndefined();
	});

	it("does not parse text in tool mode", () => {
		const message = fakeAssistant([textContent("Fix login")]);
		expect(extractToolTitle(message, 50)).toBeUndefined();
	});
});

describe("extractTextTitle", () => {
	it("parses text responses", () => {
		const message = fakeAssistant([textContent("Title: Fix login.")]);
		expect(extractTextTitle(message, 50)).toBe("Fix login");
	});

	it("returns undefined for empty text", () => {
		expect(extractTextTitle(fakeAssistant([textContent("   ")]), 50)).toBeUndefined();
	});
});

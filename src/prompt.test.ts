import { describe, expect, it } from "vitest";

import { SESSION_TITLE_TOOL_NAME, buildSystemPrompt, buildUserPrompt } from "./prompt.js";
import type { TitleInput } from "./types.js";

function input(overrides: Partial<TitleInput> = {}): TitleInput {
	return {
		userMessages: ["Fix login"],
		assistantText: "I found the bug in auth.ts",
		toolTrace: "Read, Edit",
		status: "completed",
		...overrides,
	};
}

describe("buildSystemPrompt", () => {
	it("uses the tool instruction and configured max length", () => {
		const prompt = buildSystemPrompt("tool", 42);
		expect(prompt).toContain(SESSION_TITLE_TOOL_NAME);
		expect(prompt).toContain("Never exceed 42 Unicode characters");
		expect(prompt).not.toContain("Output only the title. No code fences");
	});

	it("uses the text instruction in text mode", () => {
		const prompt = buildSystemPrompt("text", 50);
		expect(prompt).toContain("Output only the title. No code fences");
		expect(prompt).not.toContain("Call submit_session_title");
	});
});

describe("buildUserPrompt", () => {
	it("contains escaped user, assistant, tool, and status sections", () => {
		const prompt = buildUserPrompt(
			input({ userMessages: ["Fix <auth> & login"], assistantText: "See <file>" }),
			"text",
			{ maxInputChars: 8_000, previousInvalid: false },
		);
		expect(prompt).toContain("<user_prompt>");
		expect(prompt).toContain("Fix &lt;auth&gt; &amp; login");
		expect(prompt).toContain("<assistant_output>");
		expect(prompt).toContain("See &lt;file&gt;");
		expect(prompt).toContain("<tool_activity>");
		expect(prompt).toContain("<turn_status>completed</turn_status>");
	});

	it("wraps multiple user messages in message elements", () => {
		const prompt = buildUserPrompt(
			input({ userMessages: ["First", "Second"] }),
			"tool",
			{ maxInputChars: 8_000, previousInvalid: false },
		);
		expect(prompt).toContain("<message>First</message>");
		expect(prompt).toContain("<message>Second</message>");
	});

	it("marks interrupted turns and adds the tool-mode correction", () => {
		const prompt = buildUserPrompt(input({ status: "interrupted" }), "tool", {
			maxInputChars: 8_000,
			previousInvalid: true,
		});
		expect(prompt).toContain("<turn_status>interrupted</turn_status>");
		expect(prompt).toContain(`did not call ${SESSION_TITLE_TOOL_NAME}`);
		// Tool mode must never be nudged toward a plain-text answer.
		expect(prompt).not.toContain("Output exactly one title line");
	});

	it("uses the text correction in text mode", () => {
		const prompt = buildUserPrompt(input(), "text", { maxInputChars: 8_000, previousInvalid: true });
		expect(prompt).toContain("Output exactly one title line and nothing else");
		expect(prompt).not.toContain(SESSION_TITLE_TOOL_NAME);
	});

	it("adds no correction when the previous attempt was not invalid", () => {
		const prompt = buildUserPrompt(input(), "tool", { maxInputChars: 8_000, previousInvalid: false });
		expect(prompt).not.toContain("previous response");
	});

	it("gives budget left over by short messages to later ones", () => {
		const prompt = buildUserPrompt(
			input({ userMessages: ["short", "l".repeat(3_000)], assistantText: "", toolTrace: "" }),
			"text",
			{ maxInputChars: 12_000, previousInvalid: false },
		);
		// User budget is 3,474; an even split would cut the long message at 1,737.
		expect(prompt).toContain(`<message>${"l".repeat(3_000)}</message>`);
	});

	it("bounds long input", () => {
		const prompt = buildUserPrompt(
			input({
				userMessages: ["u".repeat(30_000)],
				assistantText: "a".repeat(30_000),
				toolTrace: "x".repeat(10_000),
			}),
			"text",
			{ maxInputChars: 5_000, previousInvalid: false },
		);
		expect(prompt.length).toBeLessThan(7_000);
		expect(prompt).toContain("chars omitted");
	});
});

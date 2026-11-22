import { describe, expect, it } from "vitest";

import {
	collectTitleInput,
	countUserMessages,
	isRecoveryEligible,
	lastAssistantStopReason,
} from "./collect.js";
import { assistantEntry, toolCallEntry, userEntry } from "./test-utils.js";

describe("collectTitleInput", () => {
	it("collects user and assistant text", () => {
		const input = collectTitleInput(
			[userEntry("Fix login"), assistantEntry("I found the bug in auth.ts")],
			false,
		);
		expect(input).toEqual({
			userMessages: ["Fix login"],
			assistantText: "I found the bug in auth.ts",
			toolTrace: "",
			status: "completed",
		});
	});

	it("keeps partial assistant output when interrupted", () => {
		const input = collectTitleInput(
			[userEntry("继续"), assistantEntry("正在修改 auth.ts", "aborted")],
			true,
		);
		expect(input?.status).toBe("interrupted");
		expect(input?.assistantText).toBe("正在修改 auth.ts");
	});

	it("collects tool names without arguments or results", () => {
		const input = collectTitleInput(
			[userEntry("Fix login"), toolCallEntry("edit", undefined)],
			false,
		);
		expect(input?.toolTrace).toBe("edit");
	});

	it("skips aborted assistant messages when the final run completed", () => {
		const input = collectTitleInput(
			[
				userEntry("Fix login"),
				assistantEntry("partial", "aborted"),
				assistantEntry("final answer", "stop"),
			],
			false,
		);
		expect(input?.status).toBe("completed");
		expect(input?.assistantText).toBe("final answer");
	});

	it("returns undefined when there is no text", () => {
		expect(collectTitleInput([], false)).toBeUndefined();
		expect(collectTitleInput([assistantEntry("   ")], false)).toBeUndefined();
	});
});

describe("branch helpers", () => {
	it("counts user messages and finds the last assistant stop reason", () => {
		const entries = [userEntry("a"), assistantEntry("b", "error"), userEntry("c")];
		expect(countUserMessages(entries)).toBe(2);
		expect(lastAssistantStopReason(entries)).toBe("error");
	});

	it("marks a single-prompt or failed branch as recovery eligible", () => {
		expect(isRecoveryEligible([])).toBe(true);
		expect(isRecoveryEligible([userEntry("a")])).toBe(true);
		expect(isRecoveryEligible([userEntry("a"), assistantEntry("b")])).toBe(true);
		expect(
			isRecoveryEligible([userEntry("a"), assistantEntry("b"), userEntry("c")]),
		).toBe(false);
		expect(
			isRecoveryEligible([
				userEntry("a"),
				assistantEntry("b"),
				userEntry("c"),
				assistantEntry("d", "aborted"),
			]),
		).toBe(true);
	});
});

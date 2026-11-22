import type { SessionEntry } from "@earendil-works/pi-coding-agent";

import type { TitleInput, TurnStatus } from "./types.js";

interface AssistantPart {
	readonly text: string;
	readonly stopReason: string;
	readonly tools: readonly string[];
}

function textParts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];

	const parts: string[] = [];
	for (const part of content) {
		if (
			part !== null &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string"
		) {
			parts.push((part as { text: string }).text);
		}
	}
	return parts;
}

function toolNames(content: unknown): string[] {
	if (!Array.isArray(content)) return [];

	const names: string[] = [];
	for (const part of content) {
		if (
			part !== null &&
			typeof part === "object" &&
			(part as { type?: unknown }).type === "toolCall" &&
			typeof (part as { name?: unknown }).name === "string"
		) {
			names.push((part as { name: string }).name);
		}
	}
	return names;
}

function userMessageTexts(entries: readonly SessionEntry[]): string[] {
	const messages: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "user") continue;
		const text = textParts(entry.message.content).join("\n").trim();
		if (text) messages.push(text);
	}
	return messages;
}

function assistantParts(entries: readonly SessionEntry[]): AssistantPart[] {
	const parts: AssistantPart[] = [];
	for (const entry of entries) {
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		parts.push({
			text: textParts(entry.message.content).join("\n").trim(),
			stopReason: entry.message.stopReason,
			tools: toolNames(entry.message.content),
		});
	}
	return parts;
}

export function countUserMessages(entries: readonly SessionEntry[]): number {
	let count = 0;
	for (const entry of entries) {
		if (entry.type === "message" && entry.message.role === "user") count += 1;
	}
	return count;
}

export function lastAssistantStopReason(entries: readonly SessionEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type === "message" && entry.message.role === "assistant") {
			return entry.message.stopReason;
		}
	}
	return undefined;
}

/** Advice for resume recovery: an empty/single-prompt branch, or a failed/interrupted last turn. */
export function isRecoveryEligible(entries: readonly SessionEntry[]): boolean {
	const users = countUserMessages(entries);
	if (users <= 1) return true;
	const last = lastAssistantStopReason(entries);
	return last === "aborted" || last === "error";
}

export function collectTitleInput(
	entries: readonly SessionEntry[],
	aborted: boolean,
): TitleInput | undefined {
	const users = userMessageTexts(entries);
	const assistants = assistantParts(entries);
	const lastStopReason = assistants.at(-1)?.stopReason;

	let status: TurnStatus = "completed";
	if (aborted || lastStopReason === "aborted") status = "interrupted";
	else if (lastStopReason === "error") status = "error";

	const selected =
		status === "completed"
			? assistants.filter((part) => part.stopReason !== "aborted" && part.stopReason !== "error")
			: assistants;

	const assistantText = selected
		.map((part) => part.text)
		.filter(Boolean)
		.join("\n\n")
		.trim();
	const tools = [...new Set(selected.flatMap((part) => part.tools))];

	if (users.length === 0 && assistantText.length === 0) return undefined;

	return {
		userMessages: users,
		assistantText,
		toolTrace: tools.join(", "),
		status,
	};
}

import type { AssistantMessage } from "@earendil-works/pi-ai";

import { SESSION_TITLE_TOOL_NAME } from "./prompt.js";
import {
	collapseWhitespace,
	isGenericTitle,
	looksLikeRefusal,
	stripMatchingQuotes,
	stripTrailingPunctuation,
	stripUnsafe,
	truncateCodePoints,
} from "./text.js";

const META_LINE =
	/^(?:here(?:'s| is)\b|sure\b|okay\b|of course\b|the user (?:wants|is asking|asked)\b|this (?:session|conversation) is about\b)/iu;
const TITLE_PREFIX = /^(?:session\s+)?title\s*[:：]\s*(.+)$/iu;
const CHINESE_TITLE_PREFIX = /^标题\s*[:：]\s*(.+)$/u;

function stripFence(text: string): string {
	const fenced = text.match(/```[^\n]*\n([\s\S]*?)\n```/u);
	if (fenced?.[1]) return fenced[1].trim();
	return text
		.replace(/^\s*```[^\n]*\n?/u, "")
		.replace(/\n?```\s*$/u, "")
		.trim();
}

function stripLineDecorations(line: string): string {
	let result = line.trim();
	result = result.replace(/^#{1,6}\s+/u, "");
	result = result.replace(/^[-*+]\s+/u, "");
	result = result.replace(/^>\s+/u, "");
	if (result.startsWith("**") && result.endsWith("**") && result.length > 4) {
		result = result.slice(2, -2).trim();
	}
	return result;
}

function stripMetaPrefix(line: string): string {
	const prefixed = line.match(TITLE_PREFIX)?.[1] ?? line.match(CHINESE_TITLE_PREFIX)?.[1];
	if (prefixed) return prefixed.trim();

	return line
		.replace(
			/^(?:(?:sure|okay|of course)[,，]?\s*)?(?:here(?:'s| is)\s+)?(?:a|the)?\s*(?:concise\s+|short\s+)?(?:session\s+)?title\s*(?:is|:)\s*/iu,
			"",
		)
		.replace(/^the user (?:wants|is asking|asked) (?:to|for)\s+/iu, "")
		.replace(/^this (?:session|conversation) is about\s+/iu, "")
		.trim();
}

function pickTitleLine(text: string): string {
	const lines = text
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter(Boolean);
	if (lines.length === 0) return "";

	for (const line of lines) {
		const explicit = line.match(TITLE_PREFIX)?.[1] ?? line.match(CHINESE_TITLE_PREFIX)?.[1];
		if (explicit?.trim()) return explicit.trim();
	}

	const substantive = lines.find((line) => !META_LINE.test(line)) ?? lines[0] ?? "";
	return substantive;
}

/** Turn a free-form title response into a clean, bounded title. */
export function normalizeTitle(raw: string, maxChars: number): string | undefined {
	let text = stripFence(stripUnsafe(raw).trim());
	if (!text) return undefined;

	if (text.startsWith("{")) {
		try {
			const value = JSON.parse(text) as { title?: unknown };
			if (typeof value.title === "string") text = value.title;
		} catch {
			// Keep the text form when the model emitted invalid JSON.
		}
	} else if (text.startsWith("[")) {
		try {
			const value = JSON.parse(text) as unknown;
			if (Array.isArray(value) && typeof value[0] === "string") text = value[0];
		} catch {
			// Keep the text form when the model emitted invalid JSON.
		}
	}

	let line = pickTitleLine(text);
	line = stripLineDecorations(line);
	line = stripMetaPrefix(line);
	line = stripMatchingQuotes(line);
	line = collapseWhitespace(line);
	line = stripTrailingPunctuation(line);
	line = stripMatchingQuotes(line);

	if (!line || isGenericTitle(line) || looksLikeRefusal(line)) return undefined;

	const title = truncateCodePoints(line, Math.max(1, maxChars));
	return title || undefined;
}

/** Tool mode is strict: only a valid submit_session_title call is accepted. */
export function extractToolTitle(message: AssistantMessage, maxChars: number): string | undefined {
	for (const part of message.content) {
		if (part.type !== "toolCall" || part.name !== SESSION_TITLE_TOOL_NAME) continue;
		if (part.argumentsError) continue;
		const value = part.arguments?.title;
		if (typeof value !== "string") continue;
		const title = normalizeTitle(value, maxChars);
		if (title) return title;
	}
	return undefined;
}

/** Text mode: parse the first usable line from the assistant text. */
export function extractTextTitle(message: AssistantMessage, maxChars: number): string | undefined {
	const text = message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return normalizeTitle(text, maxChars);
}

import {
	collapseWhitespace,
	isGenericTitle,
	looksLikeRefusal,
	stripMatchingQuotes,
	stripTrailingPunctuation,
	stripUnsafe,
	truncateCodePoints,
} from "./text.js";
import type { TitleInput } from "./types.js";

function cleanLine(line: string): string | undefined {
	let result = stripUnsafe(line).trim();
	if (!result || result.startsWith("```")) return undefined;
	result = result.replace(/^#{1,6}\s+/u, "");
	result = result.replace(/^[-*+]\s+/u, "");
	result = result.replace(/^>\s+/u, "");
	result = result.replace(/^(?:i(?:'ll| will)|we(?:'ll| will)|let(?:'s| us))\s+/iu, "");
	result = stripMatchingQuotes(result);
	result = collapseWhitespace(result);
	result = stripTrailingPunctuation(result);
	result = stripMatchingQuotes(result);
	if (!result || isGenericTitle(result) || looksLikeRefusal(result)) return undefined;
	return result;
}

function fromText(text: string, maxChars: number): string | undefined {
	for (const line of text.split(/\r?\n/u)) {
		const cleaned = cleanLine(line);
		if (cleaned) return truncateCodePoints(cleaned, Math.max(1, maxChars));
	}
	return undefined;
}

/** Last-resort title from the first substantive line of the prompt (or assistant output). */
export function fallbackTitle(input: TitleInput, maxChars: number): string | undefined {
	for (const message of input.userMessages) {
		const title = fromText(message, maxChars);
		if (title) return title;
	}
	return fromText(input.assistantText, maxChars);
}

const ANSI_OSC = /\x1b\][^\x07]*(?:\x07|\x1b\\)/g;
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_ESCAPE = /\x1b[@-_]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;
const TRAILING_PUNCTUATION = /[\s.。!！?？;；,，:：…]+$/u;
const GENERIC_TITLES = /^(?:untitled|new (?:chat|session|conversation)|session|conversation|chat)$/iu;
// A bare "Unable to ..." is a legitimate title ("Unable to connect to Redis"), so
// only first-person refusals count.
const REFUSAL = /^(?:i can(?:'t|not)|sorry|i'm unable to|i am unable to)\b/iu;
const QUOTE_PAIRS: ReadonlyArray<readonly [string, string]> = [
	['"', '"'],
	["'", "'"],
	["`", "`"],
	["“", "”"],
	["‘", "’"],
	["「", "」"],
	["『", "』"],
];

/** Remove terminal control sequences and bidi controls from untrusted model/user text. */
export function stripUnsafe(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(ANSI_OSC, "")
		.replace(ANSI_CSI, "")
		.replace(ANSI_ESCAPE, "")
		.replace(CONTROL, " ")
		.replace(BIDI, "");
}

export function collapseWhitespace(text: string): string {
	return text.replace(/\s+/gu, " ").trim();
}

/** Bounded, terminal-safe error text for status lines and notifications. */
export function describeError(error: unknown): string {
	const text = error instanceof Error ? error.message : String(error);
	return truncateCodePoints(stripUnsafe(text), 200, false);
}

/** Truncate by Unicode code point, optionally avoiding cutting the last English word. */
export function truncateCodePoints(text: string, max: number, wordBoundary = true): string {
	const characters = Array.from(text);
	if (characters.length <= max) return text;
	let cut = characters.slice(0, max).join("");
	if (wordBoundary && /[\p{L}\p{N}_]/u.test(characters[max] ?? "")) {
		const lastSpace = cut.lastIndexOf(" ");
		if (lastSpace > max - 12) cut = cut.slice(0, lastSpace);
	}
	return cut.trim();
}

/**
 * Bound a long block by keeping its head and tail. The output never exceeds `max`
 * code points, and the omission marker is included in that budget.
 */
export function headTail(text: string, max: number, headRatio = 0.55): string {
	const characters = Array.from(text);
	if (characters.length <= max) return text;

	// The marker length depends on the digit count of the omitted number, which in
	// turn depends on the marker length. Size the marker for the worst case first,
	// then report the exact number of characters actually dropped.
	const markerFor = (omitted: number): string => `\n[… ${omitted} chars omitted …]\n`;
	const markerLength = Array.from(markerFor(characters.length)).length;
	const retained = max - markerLength;
	if (retained <= 0) return characters.slice(0, max).join("");
	const marker = markerFor(characters.length - retained);

	const headLength = Math.max(1, Math.floor(retained * headRatio));
	const tailLength = retained - headLength;
	return `${characters.slice(0, headLength).join("")}${marker}${characters
		.slice(characters.length - tailLength)
		.join("")}`;
}

export function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function stripMatchingQuotes(text: string): string {
	let result = text.trim();
	let changed = true;
	while (changed && result.length >= 2) {
		changed = false;
		for (const [open, close] of QUOTE_PAIRS) {
			if (result.startsWith(open) && result.endsWith(close)) {
				result = result.slice(open.length, result.length - close.length).trim();
				changed = true;
				break;
			}
		}
	}
	return result;
}

export function stripTrailingPunctuation(text: string): string {
	return text.replace(TRAILING_PUNCTUATION, "").trim();
}

export function isGenericTitle(text: string): boolean {
	return GENERIC_TITLES.test(text.trim());
}

export function looksLikeRefusal(text: string): boolean {
	return REFUSAL.test(text.trim());
}

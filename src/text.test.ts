import { describe, expect, it } from "vitest";

import { describeError, headTail, looksLikeRefusal } from "./text.js";

describe("headTail", () => {
	it("reports the number of characters actually omitted", () => {
		const out = headTail("x".repeat(1_000), 200);
		const omitted = Number(out.match(/\[… (\d+) chars omitted …\]/u)?.[1]);
		const kept = Array.from(out.replace(/\n\[… \d+ chars omitted …\]\n/u, "")).length;
		expect(kept + omitted).toBe(1_000);
		expect(Array.from(out).length).toBeLessThanOrEqual(200);
	});

	it("stays within the limit when the omitted count has fewer digits than the total", () => {
		// 10,010 total with a 27-char marker keeps 13 and omits 9,997: one digit fewer.
		const out = headTail("y".repeat(10_010), 40);
		expect(Array.from(out).length).toBeLessThanOrEqual(40);
		const omitted = Number(out.match(/\[… (\d+) chars omitted …\]/u)?.[1]);
		expect(omitted).toBe(9_997);
		const kept = Array.from(out.replace(/\n\[… \d+ chars omitted …\]\n/u, "")).length;
		expect(kept + omitted).toBe(10_010);
	});

	it("returns short text unchanged", () => {
		expect(headTail("short", 100)).toBe("short");
	});
});

describe("looksLikeRefusal", () => {
	it("flags first-person refusals", () => {
		expect(looksLikeRefusal("I can't help with that")).toBe(true);
		expect(looksLikeRefusal("Sorry, no title")).toBe(true);
		expect(looksLikeRefusal("I'm unable to do this")).toBe(true);
		expect(looksLikeRefusal("I am unable to do this")).toBe(true);
	});

	it("keeps titles that start with 'Unable to'", () => {
		expect(looksLikeRefusal("Unable to connect to Redis")).toBe(false);
	});
});

describe("describeError", () => {
	it("strips control sequences and bounds the length", () => {
		const text = describeError(new Error(`\u001b[31mboom\u001b[0m ${"z".repeat(500)}`));
		expect(text.startsWith("boom")).toBe(true);
		expect(Array.from(text).length).toBeLessThanOrEqual(200);
	});
});

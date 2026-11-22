import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { parseModeArg, readConfig, readFileSettings, resolveConfig } from "./config.js";

describe("readConfig", () => {
	it("uses tool mode, current model, fallback on by default", () => {
		const config = readConfig({});
		expect(config.enabled).toBe(true);
		expect(config.format).toBe("tool");
		expect(config.fallback).toBe(true);
		expect(config.maxChars).toBe(50);
		expect(config.timeoutMs).toBe(12_000);
		expect(config.scope).toBe("tui");
		expect(config.modelSpec).toBeUndefined();
	});

	it("reads overrides and clamps numbers", () => {
		const config = readConfig({
			PI_AUTOTITLE: "0",
			PI_AUTOTITLE_FORMAT: "text",
			PI_AUTOTITLE_FALLBACK: "off",
			PI_AUTOTITLE_MAX_CHARS: "999",
			PI_AUTOTITLE_TIMEOUT_MS: "1",
			PI_AUTOTITLE_SCOPE: "all",
			PI_AUTOTITLE_MODEL: " test/model ",
		});
		expect(config.enabled).toBe(false);
		expect(config.format).toBe("text");
		expect(config.fallback).toBe(false);
		expect(config.maxChars).toBe(100);
		expect(config.timeoutMs).toBe(1_000);
		expect(config.scope).toBe("all");
		expect(config.modelSpec).toBe("test/model");
	});

	it("ignores invalid mode/scope values", () => {
		const config = readConfig({ PI_AUTOTITLE_FORMAT: "json", PI_AUTOTITLE_SCOPE: "rpc" });
		expect(config.format).toBe("tool");
		expect(config.scope).toBe("tui");
	});
});

describe("config file", () => {
	it("ignores a broken file and fields of the wrong type, and clamps numbers", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-autotitle-config-"));
		try {
			const path = join(dir, "pi-autotitle.json");
			expect(readFileSettings(path)).toEqual({});
			writeFileSync(path, "{ not json");
			expect(readFileSettings(path)).toEqual({});
			writeFileSync(path, JSON.stringify({ enabled: "no", format: "json", maxChars: 500, timeoutMs: 2500, modelSpec: " " }));
			expect(readFileSettings(path)).toEqual({ maxChars: 100, timeoutMs: 2500 });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("puts the environment over the file and reports what it locks", () => {
		const { config, locked } = resolveConfig({ format: "text", scope: "all" }, { PI_AUTOTITLE_SCOPE: "tui", PI_AUTOTITLE_MAX_CHARS: "abc" });
		expect(config.format).toBe("text");
		expect(config.scope).toBe("tui");
		expect(config.maxChars).toBe(50);
		expect([...locked]).toEqual(["scope"]);
	});
});

describe("parseModeArg", () => {
	it("parses text/tool case-insensitively", () => {
		expect(parseModeArg("TEXT")).toBe("text");
		expect(parseModeArg("tool")).toBe("tool");
		expect(parseModeArg("json")).toBeUndefined();
	});
});

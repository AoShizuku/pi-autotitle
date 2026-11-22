// Settings come from three places, highest first: environment variables, <agent dir>/pi-autotitle.json, defaults.
// A variable that is set decides its field outright (the settings panel shows it locked); the file holds what
// /autotitle and the panel change, so those changes survive a restart (DESIGN.md §13).

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type TitleMode = "tool" | "text";
export type TitleScope = "tui" | "all";

export interface AutotitleConfig {
	readonly enabled: boolean;
	readonly format: TitleMode;
	readonly fallback: boolean;
	readonly maxChars: number;
	readonly timeoutMs: number;
	readonly scope: TitleScope;
	readonly modelSpec?: string;
}

export type SettingKey = keyof AutotitleConfig;

export type Env = Record<string, string | undefined>;

export const CONFIG_FILE_NAME = "pi-autotitle.json";

export const DEFAULT_CONFIG: AutotitleConfig = {
	enabled: true,
	format: "tool",
	fallback: true,
	maxChars: 50,
	timeoutMs: 12_000,
	scope: "tui",
};

export const LIMITS = {
	maxChars: { min: 10, max: 100 },
	timeoutMs: { min: 1_000, max: 60_000 },
} as const;

/** The variable that decides each field when it is set. */
export const ENV_VARS: Record<SettingKey, string> = {
	enabled: "PI_AUTOTITLE",
	format: "PI_AUTOTITLE_FORMAT",
	fallback: "PI_AUTOTITLE_FALLBACK",
	maxChars: "PI_AUTOTITLE_MAX_CHARS",
	timeoutMs: "PI_AUTOTITLE_TIMEOUT_MS",
	scope: "PI_AUTOTITLE_SCOPE",
	modelSpec: "PI_AUTOTITLE_MODEL",
};

const FALSEY = new Set(["0", "false", "off", "no", "none", "disabled"]);

export function isFalsey(value: string | undefined): boolean {
	return value !== undefined && FALSEY.has(value.trim().toLowerCase());
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function parseInteger(value: string, min: number, max: number): number | undefined {
	const parsed = Number.parseInt(value.trim(), 10);
	return Number.isFinite(parsed) ? clamp(parsed, min, max) : undefined;
}

function parseMode(value: string | undefined): TitleMode {
	return value?.trim().toLowerCase() === "text" ? "text" : "tool";
}

function parseScope(value: string | undefined): TitleScope {
	return value?.trim().toLowerCase() === "all" ? "all" : "tui";
}

/**
 * Fields decided by the environment. A variable counts once it holds something; a number that does not parse
 * is ignored, as before, and leaves the field to the file.
 */
export function readEnvOverrides(env: Env = process.env): Partial<AutotitleConfig> {
	const out: { -readonly [K in SettingKey]?: AutotitleConfig[K] } = {};
	const value = (key: SettingKey): string | undefined => {
		const raw = env[ENV_VARS[key]];
		return raw !== undefined && raw.trim() !== "" ? raw : undefined;
	};
	const enabled = value("enabled");
	if (enabled !== undefined) out.enabled = !isFalsey(enabled);
	const format = value("format");
	if (format !== undefined) out.format = parseMode(format);
	const fallback = value("fallback");
	if (fallback !== undefined) out.fallback = !isFalsey(fallback);
	const maxChars = value("maxChars");
	const parsedMax = maxChars === undefined ? undefined : parseInteger(maxChars, LIMITS.maxChars.min, LIMITS.maxChars.max);
	if (parsedMax !== undefined) out.maxChars = parsedMax;
	const timeout = value("timeoutMs");
	const parsedTimeout = timeout === undefined ? undefined : parseInteger(timeout, LIMITS.timeoutMs.min, LIMITS.timeoutMs.max);
	if (parsedTimeout !== undefined) out.timeoutMs = parsedTimeout;
	const scope = value("scope");
	if (scope !== undefined) out.scope = parseScope(scope);
	const model = value("modelSpec");
	if (model !== undefined) out.modelSpec = model.trim();
	return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRaw(path: string): Record<string, unknown> {
	try {
		if (!existsSync(path)) return {};
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

/** Valid fields of the file; a missing or broken file, or a field of the wrong type, is left out. */
export function readFileSettings(path: string): Partial<AutotitleConfig> {
	const raw = readRaw(path);
	const out: { -readonly [K in SettingKey]?: AutotitleConfig[K] } = {};
	if (typeof raw.enabled === "boolean") out.enabled = raw.enabled;
	if (raw.format === "tool" || raw.format === "text") out.format = raw.format;
	if (typeof raw.fallback === "boolean") out.fallback = raw.fallback;
	if (typeof raw.maxChars === "number" && Number.isFinite(raw.maxChars)) {
		out.maxChars = clamp(Math.floor(raw.maxChars), LIMITS.maxChars.min, LIMITS.maxChars.max);
	}
	if (typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)) {
		out.timeoutMs = clamp(Math.floor(raw.timeoutMs), LIMITS.timeoutMs.min, LIMITS.timeoutMs.max);
	}
	if (raw.scope === "tui" || raw.scope === "all") out.scope = raw.scope;
	if (typeof raw.modelSpec === "string" && raw.modelSpec.trim()) out.modelSpec = raw.modelSpec.trim();
	return out;
}

/**
 * Merge one change into the file. Other keys, unknown ones included, are kept; `undefined` removes the key
 * (the model override going back to "current model").
 */
export function saveFileSetting<K extends SettingKey>(path: string, key: K, value: AutotitleConfig[K] | undefined): void {
	const raw = readRaw(path);
	if (value === undefined) delete raw[key];
	else raw[key] = value;
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`, "utf8");
}

export interface ResolvedConfig {
	config: AutotitleConfig;
	/** Fields an environment variable decides. */
	locked: ReadonlySet<SettingKey>;
}

export function resolveConfig(file: Partial<AutotitleConfig>, env: Env = process.env): ResolvedConfig {
	const overrides = readEnvOverrides(env);
	const config = { ...DEFAULT_CONFIG, ...file, ...overrides };
	if (!config.modelSpec) delete (config as { modelSpec?: string }).modelSpec;
	return { config, locked: new Set(Object.keys(overrides) as SettingKey[]) };
}

/** Defaults plus the environment, without the file. */
export function readConfig(env: Env = process.env): AutotitleConfig {
	return resolveConfig({}, env).config;
}

export function parseModeArg(value: string): TitleMode | undefined {
	const normalized = value.trim().toLowerCase();
	return normalized === "tool" || normalized === "text" ? normalized : undefined;
}

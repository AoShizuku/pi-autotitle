import type { Model } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir, type SessionEntry } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import { collectTitleInput, countUserMessages, isRecoveryEligible, lastAssistantStopReason } from "./collect.js";
import {
	CONFIG_FILE_NAME,
	DEFAULT_CONFIG,
	ENV_VARS,
	LIMITS,
	parseModeArg,
	readFileSettings,
	resolveConfig,
	saveFileSetting,
	type AutotitleConfig,
	type Env,
	type SettingKey,
	type TitleMode,
} from "./config.js";
import { generateTitle } from "./generate.js";
import { Metrics, formatMetrics } from "./metrics.js";
import { exposeSettings, type SetResult, type SettingItem, type SettingValue } from "./shizuku-settings.js";
import { describeError } from "./text.js";
import {
	ZERO_TITLE_USAGE,
	type CompleteFn,
	type GenerationResult,
	type RuntimeSettings,
	type TitleInput,
} from "./types.js";

export interface AutotitleDeps {
	readonly complete?: CompleteFn;
	readonly now?: () => number;
	readonly env?: Env;
	readonly randomId?: () => string;
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
	/** Default: <agent dir>/pi-autotitle.json. */
	readonly configPath?: string;
}

interface PendingGeneration {
	readonly controller: AbortController;
	readonly mode: TitleMode;
	readonly startedAt: number;
}

interface RunOptions {
	readonly interrupted?: boolean;
	readonly force?: boolean;
	readonly overwrite?: boolean;
	readonly expectedName?: string;
	readonly preview?: boolean;
	readonly modeOverride?: TitleMode;
	readonly notify?: boolean;
}

const USAGE = [
	"Usage: /autotitle [status|on|off|tool|text|retry [force]|preview [text|tool]|model <provider/model>|model default]",
	"  status                  show mode, model, session, and counters",
	"  on | off                enable or disable automatic titles (saved)",
	"  tool | text             switch the title output channel (saved)",
	"  retry [force]           regenerate the current session title",
	"  preview [text|tool]     generate and show a title without saving it",
	"  model <provider/model>  override the title model (saved)",
	"  model default           use the current session model (saved)",
].join("\n");

const STATE_KEY = Symbol.for("pi-autotitle.state");
const STATE_VERSION = 1;

/**
 * State that must outlive one extension instance. pi rebuilds every extension
 * on /new, /resume, /fork, and /reload, so closure state would reset there.
 * Settings are re-read from the environment and the config file by every
 * instance (changes are saved there); counters and per-session bookkeeping
 * live on for the whole process. In-flight requests stay per instance and are
 * cancelled on shutdown.
 */
interface SharedState {
	readonly version: typeof STATE_VERSION;
	readonly settings: RuntimeSettings;
	readonly metrics: Metrics;
	readonly attempted: Set<string>;
	readonly lastCommitted: Map<string, string>;
}

type StateHolder = { [STATE_KEY]?: SharedState };

function toRuntime(config: AutotitleConfig): RuntimeSettings {
	return {
		enabled: config.enabled,
		format: config.format,
		fallback: config.fallback,
		maxChars: config.maxChars,
		timeoutMs: config.timeoutMs,
		scope: config.scope,
		modelSpec: config.modelSpec,
	};
}

function sharedState(config: AutotitleConfig): SharedState {
	const holder = globalThis as StateHolder;
	const existing = holder[STATE_KEY];
	// A /reload after editing this file may meet state shaped by an older build.
	if (existing?.version === STATE_VERSION) {
		Object.assign(existing.settings, toRuntime(config));
		return existing;
	}
	const created: SharedState = {
		version: STATE_VERSION,
		settings: toRuntime(config),
		metrics: new Metrics(),
		attempted: new Set(),
		lastCommitted: new Map(),
	};
	holder[STATE_KEY] = created;
	return created;
}

/** Drops the process-wide state (counters, bookkeeping). Tests only. */
export function resetAutotitleState(): void {
	delete (globalThis as StateHolder)[STATE_KEY];
}

function notify(
	ctx: ExtensionContext | ExtensionCommandContext,
	message: string,
	type: "info" | "warning" | "error" = "info",
): void {
	try {
		if (ctx.hasUI) ctx.ui.notify(message, type);
	} catch {
		// A stale context after a session switch cannot show notifications.
	}
}

function modelLabel(model: Model<any> | undefined): string {
	return model ? `${model.provider}/${model.id}` : "(none)";
}

function resolveModel(
	ctx: ExtensionContext | ExtensionCommandContext,
	spec: string | undefined,
): { model: Model<any> | undefined; note: string | undefined } {
	let current: Model<any> | undefined;
	try {
		current = ctx.model;
	} catch {
		return { model: undefined, note: "model context is stale" };
	}
	if (!spec) return { model: current, note: undefined };

	const slash = spec.indexOf("/");
	if (slash <= 0 || slash === spec.length - 1) {
		return { model: current, note: `invalid model spec: ${spec}` };
	}
	const provider = spec.slice(0, slash);
	const id = spec.slice(slash + 1);
	try {
		const found = ctx.modelRegistry.find(provider, id);
		if (!found) return { model: current, note: `model not found: ${spec}` };
		if (!ctx.modelRegistry.hasConfiguredAuth(found)) {
			return { model: current, note: `no auth for: ${spec}` };
		}
		return { model: found, note: undefined };
	} catch (error) {
		return { model: current, note: `model lookup failed: ${describeError(error)}` };
	}
}

function maxInputCharsFor(model: Model<any>): number {
	if (!Number.isFinite(model.contextWindow) || model.contextWindow <= 0) return 2_000;
	return Math.max(2_000, Math.min(14_000, Math.floor(model.contextWindow * 0.8)));
}

function makeGenerationFailure(
	error: string,
	mode: TitleMode,
	model: Model<any> | undefined,
	turnStatus: TitleInput["status"],
): GenerationResult {
	return {
		title: undefined,
		source: undefined,
		attempts: 0,
		invalidAttempts: 0,
		providerErrors: 1,
		timeouts: 0,
		latencyMs: 0,
		error,
		cancelled: false,
		mode,
		model: model ? modelLabel(model) : undefined,
		turnStatus,
		usage: ZERO_TITLE_USAGE,
	};
}

export default function piAutotitle(pi: ExtensionAPI, deps: AutotitleDeps = {}): void {
	const configPath = deps.configPath ?? join(getAgentDir(), CONFIG_FILE_NAME);
	const resolved = resolveConfig(readFileSettings(configPath), deps.env);
	const locked = resolved.locked;
	const { settings, metrics, attempted, lastCommitted } = sharedState(resolved.config);
	// The latest context, for model checks made from the settings panel (it has none of its own).
	let lastCtx: ExtensionContext | undefined;
	const pending = new Map<string, PendingGeneration>();
	const autoEligible = new Set<string>();
	const now = deps.now ?? Date.now;

	function sessionId(ctx: ExtensionContext): string | undefined {
		try {
			return ctx.sessionManager.getSessionId();
		} catch {
			return undefined;
		}
	}

	function cancelPendingForSession(sid: string): void {
		const entry = pending.get(sid);
		if (!entry) return;
		entry.controller.abort();
		pending.delete(sid);
	}

	function cancelAllPending(): void {
		for (const entry of pending.values()) entry.controller.abort();
		pending.clear();
	}

	function scopeAllows(ctx: ExtensionContext): boolean {
		return settings.scope === "all" || ctx.mode === "tui";
	}

	function readName(ctx: ExtensionContext): string | undefined {
		try {
			return ctx.sessionManager.getSessionName();
		} catch {
			return undefined;
		}
	}

	function seedEligibility(ctx: ExtensionContext, reason: "startup" | "reload" | "new" | "resume" | "fork"): void {
		const sid = sessionId(ctx);
		if (!sid) return;
		autoEligible.delete(sid);
		if (readName(ctx)) return;
		let branch: SessionEntry[];
		try {
			branch = ctx.sessionManager.getBranch();
		} catch {
			return;
		}
		if (reason === "new" || countUserMessages(branch) === 0) {
			autoEligible.add(sid);
			return;
		}
		if (isRecoveryEligible(branch)) autoEligible.add(sid);
	}

	function shouldRecoverNow(ctx: ExtensionContext): boolean {
		const sid = sessionId(ctx);
		if (!sid || !autoEligible.has(sid)) return false;
		if (readName(ctx)) return false;
		try {
			const branch = ctx.sessionManager.getBranch();
			if (countUserMessages(branch) === 0) return false;
			const last = lastAssistantStopReason(branch);
			return countUserMessages(branch) === 1 || last === "aborted" || last === "error";
		} catch {
			return false;
		}
	}

	async function runGeneration(
		ctx: ExtensionContext,
		options: RunOptions = {},
	): Promise<GenerationResult | undefined> {
		const sid = sessionId(ctx);
		if (!sid) return undefined;
		if (!settings.enabled && !options.force) return undefined;
		if (!scopeAllows(ctx) && !options.force) return undefined;
		if (pending.has(sid)) {
			if (options.notify) notify(ctx, "Title generation is already running for this session.");
			return undefined;
		}
		if (!options.force && attempted.has(sid)) return undefined;
		if (!options.force && !autoEligible.has(sid)) return undefined;

		const name = readName(ctx);
		if (!options.force && !options.preview && name) return undefined;

		let branch: SessionEntry[];
		try {
			branch = ctx.sessionManager.getBranch();
		} catch {
			return undefined;
		}
		const interrupted = options.interrupted ?? (lastAssistantStopReason(branch) === "aborted");
		const input = collectTitleInput(branch, interrupted);
		if (!input) {
			if (options.notify) notify(ctx, "No user or assistant text is available for a title.", "warning");
			return undefined;
		}

		const resolved = resolveModel(ctx, settings.modelSpec);
		if (!resolved.model) {
			const result = makeGenerationFailure(
				resolved.note ?? "no model available",
				options.modeOverride ?? settings.format,
				undefined,
				input.status,
			);
			if (!options.preview) {
				attempted.add(sid);
				autoEligible.delete(sid);
			}
			metrics.record(result, { preview: options.preview === true, at: now() });
			if (options.notify) notify(ctx, `Title generation failed: ${result.error ?? "no model"}`, "warning");
			return result;
		}

		const mode = options.modeOverride ?? settings.format;
		const controller = new AbortController();
		const entry: PendingGeneration = { controller, mode, startedAt: now() };
		pending.set(sid, entry);

		const complete: CompleteFn =
			deps.complete ??
			((model, context, requestOptions) =>
				ctx.modelRegistry.streamSimple(model, context, requestOptions).result());

		let result: GenerationResult;
		try {
			result = await generateTitle({
				model: resolved.model,
				input,
				mode,
				maxChars: settings.maxChars,
				timeoutMs: settings.timeoutMs,
				fallback: settings.fallback,
				maxInputChars: maxInputCharsFor(resolved.model),
				signal: controller.signal,
				complete,
				...(deps.now ? { now: deps.now } : {}),
				...(deps.randomId ? { randomId: deps.randomId } : {}),
				...(deps.sleep ? { sleep: deps.sleep } : {}),
			});
		} catch (error) {
			result = {
				...makeGenerationFailure(describeError(error), mode, resolved.model, input.status),
				cancelled: controller.signal.aborted,
			};
		} finally {
			if (pending.get(sid) === entry) pending.delete(sid);
		}

		if (result.cancelled) {
			metrics.record(result, { preview: options.preview === true, at: now() });
			if (options.notify) notify(ctx, "Title generation was cancelled.", "warning");
			return result;
		}

		if (result.title) {
			if (options.preview) {
				metrics.record(result, { preview: true, at: now() });
				if (options.notify) {
					notify(
						ctx,
						`Preview (${result.source ?? "unknown"}): ${result.title} [${result.latencyMs}ms, ${result.attempts} attempt(s)]`,
					);
				}
				return result;
			}

			const currentName = readName(ctx);
			const nameChanged =
				options.expectedName !== undefined && currentName !== options.expectedName;
			if (nameChanged || (currentName && !options.overwrite)) {
				const cancelled: GenerationResult = {
					...result,
					title: undefined,
					cancelled: true,
					error: "session name changed before commit",
				};
				metrics.record(cancelled, { preview: false, at: now() });
				autoEligible.delete(sid);
				if (options.notify) notify(ctx, "Session was named manually; generated title was discarded.", "warning");
				return cancelled;
			}

			try {
				lastCommitted.set(sid, result.title);
				pi.setSessionName(result.title);
				attempted.add(sid);
				autoEligible.delete(sid);
				metrics.record(result, { preview: false, at: now() });
				if (options.notify) {
					notify(ctx, `Session title set (${result.source ?? "unknown"}): ${result.title}`);
				}
				return result;
			} catch (error) {
				lastCommitted.delete(sid);
				const cancelled: GenerationResult = {
					...result,
					title: undefined,
					cancelled: true,
					error: describeError(error),
				};
				metrics.record(cancelled, { preview: false, at: now() });
				if (options.notify) notify(ctx, `Could not set the session title: ${cancelled.error}`, "warning");
				return cancelled;
			}
		}

		if (!options.preview) {
			attempted.add(sid);
			autoEligible.delete(sid);
		}
		metrics.record(result, { preview: options.preview === true, at: now() });
		if (options.notify) {
			notify(ctx, `Title generation failed: ${result.error ?? "unknown error"}`, "warning");
		}
		return result;
	}

	function startBackground(ctx: ExtensionContext, options: RunOptions = {}): void {
		void runGeneration(ctx, options).catch(() => {
			// Background title generation must never surface an unhandled rejection.
		});
	}

	function processMayExitAfterSettle(ctx: ExtensionContext): boolean {
		return ctx.mode === "print" || ctx.mode === "json";
	}

	pi.on("session_start", async (event, ctx) => {
		lastCtx = ctx;
		const sid = sessionId(ctx);
		if (sid) attempted.delete(sid);
		seedEligibility(ctx, event.reason);
		if (event.reason === "new") return;
		if (!scopeAllows(ctx)) return;
		if (!shouldRecoverNow(ctx)) return;
		if (!ctx.isIdle()) return;
		const sidValue = sessionId(ctx);
		if (!sidValue) return;
		if (processMayExitAfterSettle(ctx)) {
			await runGeneration(ctx, { notify: false });
			return;
		}
		queueMicrotask(() => {
			if (pending.has(sidValue)) return;
			startBackground(ctx, { notify: false });
		});
	});

	pi.on("agent_settled", async (event, ctx) => {
		lastCtx = ctx;
		if (!settings.enabled || !scopeAllows(ctx)) return;
		const sid = sessionId(ctx);
		if (!sid) return;
		if (!autoEligible.has(sid)) return;
		if (attempted.has(sid) || pending.has(sid)) return;
		if (readName(ctx)) {
			autoEligible.delete(sid);
			return;
		}
		const options: RunOptions = { interrupted: event.aborted, notify: false };
		if (processMayExitAfterSettle(ctx)) {
			await runGeneration(ctx, options);
			return;
		}
		startBackground(ctx, options);
	});

	pi.on("session_info_changed", (event, ctx) => {
		const sid = sessionId(ctx);
		if (!sid) return;
		const committed = lastCommitted.get(sid);
		if (event.name && event.name === committed) return;
		// A manual name (or an explicit clear) wins. Never write over it later.
		attempted.add(sid);
		autoEligible.delete(sid);
		cancelPendingForSession(sid);
	});

	pi.on("session_before_switch", () => {
		cancelAllPending();
	});

	pi.on("session_before_fork", () => {
		cancelAllPending();
	});

	// /reload and process exit emit no before_* event; this instance is about to
	// be discarded, so its in-flight request has nowhere to commit.
	pi.on("session_shutdown", () => {
		cancelAllPending();
		lastCtx = undefined;
	});

	// ------------------------------------------------------------- settings

	function lockedBy(key: SettingKey): string | undefined {
		return locked.has(key) ? `Set by ${ENV_VARS[key]}` : undefined;
	}

	function persist<K extends SettingKey>(key: K, value: AutotitleConfig[K] | undefined): SetResult {
		try {
			saveFileSetting(configPath, key, value);
		} catch (error) {
			return { ok: false, error: `Could not save ${configPath}: ${describeError(error)}` };
		}
		(settings as unknown as Record<string, unknown>)[key] = value;
		return { ok: true };
	}

	function intInRange(value: SettingValue, key: "maxChars" | "timeoutMs"): number | undefined {
		const { min, max } = LIMITS[key];
		return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : undefined;
	}

	/**
	 * Validate, save, and apply one setting. Shared by /autotitle and the settings panel. A field decided by an
	 * environment variable is refused rather than changed for this process only, so what the panel shows and
	 * what runs never differ.
	 */
	function change(key: SettingKey, value: SettingValue, ctx: ExtensionContext | undefined = lastCtx): SetResult {
		if (locked.has(key)) {
			return { ok: false, error: `${ENV_VARS[key]} is set; unset it to change this here.` };
		}
		switch (key) {
			case "enabled":
			case "fallback": {
				if (typeof value !== "boolean") return { ok: false, error: `${key} must be on or off` };
				const result = persist(key, value);
				if (result.ok && key === "enabled" && !value) cancelAllPending();
				return result;
			}
			case "format": {
				const mode = typeof value === "string" ? parseModeArg(value) : undefined;
				if (!mode) return { ok: false, error: "format must be tool or text" };
				const result = persist("format", mode);
				// A running request was built for the other channel.
				if (result.ok) cancelAllPending();
				return result;
			}
			case "scope": {
				if (value !== "tui" && value !== "all") return { ok: false, error: "scope must be tui or all" };
				return persist("scope", value);
			}
			case "maxChars":
			case "timeoutMs": {
				const number = intInRange(value, key);
				if (number === undefined) {
					return { ok: false, error: `${key} must be an integer from ${LIMITS[key].min} to ${LIMITS[key].max}` };
				}
				return persist(key, number);
			}
			case "modelSpec": {
				if (typeof value !== "string") return { ok: false, error: "model must be provider/model" };
				const spec = value.trim();
				if (!spec || spec.toLowerCase() === "default") return persist("modelSpec", undefined);
				if (ctx) {
					const check = resolveModel(ctx, spec);
					if (check.note) return { ok: false, error: `Cannot use ${spec}: ${check.note}` };
				} else {
					const slash = spec.indexOf("/");
					if (slash <= 0 || slash === spec.length - 1) return { ok: false, error: `invalid model spec: ${spec}` };
				}
				return persist("modelSpec", spec);
			}
		}
	}

	function settingItems(): SettingItem[] {
		const base = (id: SettingKey, label: string, description: string) => {
			const lock = lockedBy(id);
			return { id, label, description, ...(lock ? { locked: lock } : {}) };
		};
		return [
			{
				...base("enabled", "Automatic titles", "Name a new session after its first turn."),
				kind: "bool",
				value: settings.enabled,
				default: DEFAULT_CONFIG.enabled,
			},
			{
				...base("format", "Output mode", "tool: the model calls submit_session_title. text: it answers with the bare title."),
				kind: "enum",
				values: ["tool", "text"],
				value: settings.format,
				default: DEFAULT_CONFIG.format,
			},
			{
				...base("fallback", "Fallback title", "When the model fails twice, use the first line of the prompt."),
				kind: "bool",
				value: settings.fallback,
				default: DEFAULT_CONFIG.fallback,
			},
			{
				...base("modelSpec", "Title model", "provider/model used for title requests. Empty follows the session's current model."),
				kind: "text",
				value: settings.modelSpec ?? "",
				default: "",
				placeholder: "provider/model",
			},
			{
				...base("maxChars", "Max length", "Longest title, in Unicode characters."),
				kind: "int",
				value: settings.maxChars,
				default: DEFAULT_CONFIG.maxChars,
				min: LIMITS.maxChars.min,
				max: LIMITS.maxChars.max,
				step: 5,
			},
			{
				...base("timeoutMs", "Timeout (ms)", "Limit for one title request."),
				kind: "int",
				value: settings.timeoutMs,
				default: DEFAULT_CONFIG.timeoutMs,
				min: LIMITS.timeoutMs.min,
				max: LIMITS.timeoutMs.max,
				step: 1_000,
			},
			{
				...base("scope", "Modes", "tui: interactive sessions only. all: also print, json and rpc."),
				kind: "enum",
				values: ["tui", "all"],
				value: settings.scope,
				default: DEFAULT_CONFIG.scope,
			},
		];
	}

	const settingKeys = new Set<string>(Object.keys(ENV_VARS));
	exposeSettings(pi, {
		id: "pi-autotitle",
		title: "pi-autotitle",
		description: "Automatic session titles after the first turn",
		file: configPath,
		items: settingItems,
		set: (id, value) =>
			settingKeys.has(id) ? change(id as SettingKey, value) : { ok: false, error: `unknown setting: ${id}` },
	});

	function statusText(ctx: ExtensionCommandContext): string {
		const sid = sessionId(ctx);
		const name = readName(ctx);
		const resolved = resolveModel(ctx, settings.modelSpec);
		const currentPending = sid ? pending.has(sid) : false;
		const auto = name && sid && lastCommitted.get(sid) === name ? " [auto]" : "";
		const lines = [
			`pi-autotitle: ${settings.enabled ? "on" : "off"} | mode=${settings.format}` +
				` | scope=${settings.scope} | fallback=${settings.fallback ? "on" : "off"}`,
			`model: ${modelLabel(resolved.model)} (${settings.modelSpec ? `override ${settings.modelSpec}` : "current"})` +
				(resolved.note ? ` | ${resolved.note}` : ""),
			`session: ${name ?? "(unnamed)"}${auto} | pending: ${currentPending ? "yes" : "no"}`,
			...formatMetrics(metrics.snapshot()),
		];
		return lines.join("\n");
	}

	pi.registerCommand("autotitle", {
		description: "Show or control automatic session titles",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/u).filter(Boolean);
			const subcommand = (tokens[0] ?? "status").toLowerCase();
			const rest = tokens.slice(1);

			if (subcommand === "status") {
				notify(ctx, statusText(ctx));
				return;
			}

			if (subcommand === "on" || subcommand === "off") {
				const result = change("enabled", subcommand === "on", ctx);
				if (!result.ok) notify(ctx, result.error, "warning");
				else notify(ctx, `Automatic session titles ${subcommand === "on" ? "enabled" : "disabled"}.`);
				return;
			}

			if (subcommand === "tool" || subcommand === "text") {
				const result = change("format", subcommand, ctx);
				if (!result.ok) notify(ctx, result.error, "warning");
				else notify(ctx, `Title output mode: ${settings.format}.`);
				return;
			}

			if (subcommand === "model") {
				const spec = rest.join(" ").trim();
				if (!spec) {
					const resolved = resolveModel(ctx, settings.modelSpec);
					notify(
						ctx,
						`Title model: ${modelLabel(resolved.model)}` +
							(settings.modelSpec ? ` (override ${settings.modelSpec})` : " (current)") +
							(resolved.note ? ` | ${resolved.note}` : ""),
					);
					return;
				}
				const result = change("modelSpec", spec, ctx);
				if (!result.ok) {
					notify(ctx, result.error, "warning");
					return;
				}
				if (!settings.modelSpec) {
					notify(ctx, "Title model reset to the current session model.");
					return;
				}
				notify(ctx, `Title model: ${modelLabel(resolveModel(ctx, spec).model)}.`);
				return;
			}

			if (subcommand === "retry") {
				const sid = sessionId(ctx);
				if (!sid) return;
				if (pending.has(sid)) {
					notify(ctx, "Title generation is already running.", "warning");
					return;
				}
				if (!ctx.isIdle()) {
					notify(ctx, "Wait for the current run to finish before retrying.", "warning");
					return;
				}
				const force = rest.some((token) => token.toLowerCase() === "force");
				const name = readName(ctx);
				const ours = name !== undefined && lastCommitted.get(sid) === name;
				if (name && !ours && !force) {
					notify(ctx, "Session already has a name. Use /autotitle retry force to overwrite.", "warning");
					return;
				}
				attempted.delete(sid);
				autoEligible.add(sid);
				await runGeneration(ctx, {
					force: true,
					overwrite: ours || force,
					...(ours && name ? { expectedName: name } : {}),
					notify: true,
				});
				return;
			}

			if (subcommand === "preview") {
				const sid = sessionId(ctx);
				if (!sid) return;
				if (pending.has(sid)) {
					notify(ctx, "Title generation is already running.", "warning");
					return;
				}
				if (!ctx.isIdle()) {
					notify(ctx, "Wait for the current run to finish before previewing.", "warning");
					return;
				}
				const requestedMode = rest[0] ? parseModeArg(rest[0]) : undefined;
				if (rest[0] && !requestedMode) {
					notify(ctx, `Unknown mode ${rest[0]}; use text or tool.`, "warning");
					return;
				}
				await runGeneration(ctx, {
					force: true,
					preview: true,
					...(requestedMode ? { modeOverride: requestedMode } : {}),
					notify: true,
				});
				return;
			}

			notify(ctx, USAGE, "warning");
		},
	});
}

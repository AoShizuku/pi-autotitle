import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";

import piAutotitle, { resetAutotitleState } from "./index.js";
import { SETTINGS_CHANNEL, SETTINGS_PROTOCOL, type SettingsProvider } from "./shizuku-settings.js";
import {
	assistantEntry,
	fakeAssistant,
	fakeModel,
	flush,
	textContent,
	toolCallContent,
	userEntry,
} from "./test-utils.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

interface FakeState {
	id: string;
	name: string | undefined;
	branch: SessionEntry[];
}

function createHarness(options: {
	env?: Record<string, string | undefined>;
	complete?: ReturnType<typeof vi.fn>;
	state?: Partial<FakeState>;
	configPath?: string;
} = {}) {
	const state: FakeState = {
		id: "session-1",
		name: undefined,
		branch: [userEntry("Fix login"), assistantEntry("I found the bug in auth.ts")],
		...options.state,
	};
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const listeners = new Map<string, Array<(data: unknown) => void>>();
	const setSessionName = vi.fn((name: string) => {
		state.name = name;
	});
	const pi = {
		on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerCommand: (
			name: string,
			command: { handler: (args: string, ctx: unknown) => Promise<void> },
		) => {
			commands.set(name, command);
		},
		setSessionName,
		events: {
			on: (channel: string, handler: (data: unknown) => void) => {
				const list = listeners.get(channel) ?? [];
				list.push(handler);
				listeners.set(channel, list);
				return () => listeners.set(channel, (listeners.get(channel) ?? []).filter((entry) => entry !== handler));
			},
			emit: (channel: string, data: unknown) => {
				for (const handler of listeners.get(channel) ?? []) handler(data);
			},
		},
	} as unknown as ExtensionAPI;

	const modelRegistry = {
		find: vi.fn(() => fakeModel),
		hasConfiguredAuth: vi.fn(() => true),
		streamSimple: vi.fn(),
	};
	const ui = { notify: vi.fn() };
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui,
		sessionManager: {
			getSessionId: () => state.id,
			getSessionName: () => state.name,
			getBranch: () => state.branch,
			getEntries: () => state.branch,
		},
		modelRegistry,
		model: fakeModel,
		isIdle: () => true,
		waitForIdle: async () => {},
	} as unknown as ExtensionContext;

	const complete =
		options.complete ??
		vi.fn(async () => fakeAssistant([toolCallContent("Fix login")]));
	piAutotitle(pi, {
		env: options.env ?? {},
		configPath: options.configPath ?? configPath,
		complete: complete as never,
		now: () => 0,
		randomId: () => "id",
		sleep: async () => {},
	});

	async function emit(event: string, payload: unknown): Promise<void> {
		for (const handler of handlers.get(event) ?? []) {
			await handler(payload, ctx);
		}
	}

	/** The provider handed to the settings panel. */
	function settings(): SettingsProvider {
		const providers: SettingsProvider[] = [];
		pi.events.emit(SETTINGS_CHANNEL, { protocol: SETTINGS_PROTOCOL, register: (p: SettingsProvider) => providers.push(p) });
		expect(providers).toHaveLength(1);
		return providers[0]!;
	}

	async function command(args: string): Promise<void> {
		await commands.get("autotitle")?.handler(args, ctx as unknown as ExtensionCommandContext);
	}

	return { state, handlers, commands, setSessionName, complete, ctx, emit, ui, settings, command, modelRegistry };
}

async function startNew(harness: ReturnType<typeof createHarness>): Promise<void> {
	harness.state.branch = [];
	await harness.emit("session_start", { type: "session_start", reason: "new" });
}

async function settle(harness: ReturnType<typeof createHarness>, aborted = false): Promise<void> {
	await harness.emit("agent_settled", { type: "agent_settled", aborted });
	await flush();
	await flush();
}

function hangingComplete(signals: AbortSignal[]) {
	return vi.fn(
		async (_model: unknown, _context: unknown, requestOptions: { signal?: AbortSignal }) =>
			new Promise((_resolve, reject) => {
				if (requestOptions.signal) signals.push(requestOptions.signal);
				requestOptions.signal?.addEventListener("abort", () => reject(new Error("aborted")), {
					once: true,
				});
			}),
	);
}

let configDir: string;
let configPath: string;

beforeEach(() => {
	resetAutotitleState();
	configDir = mkdtempSync(join(tmpdir(), "pi-autotitle-test-"));
	configPath = join(configDir, "pi-autotitle.json");
});

afterEach(() => {
	rmSync(configDir, { recursive: true, force: true });
});

function savedFile(): Record<string, unknown> {
	return JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
}

describe("settings", () => {
	it("lists every setting with its current value and default", () => {
		writeFileSync(configPath, JSON.stringify({ format: "text", maxChars: 30 }));
		const items = createHarness().settings().items();
		expect(items.map((item) => item.id)).toEqual(["enabled", "format", "fallback", "modelSpec", "maxChars", "timeoutMs", "scope"]);
		expect(items.find((item) => item.id === "format")).toMatchObject({ kind: "enum", value: "text", default: "tool" });
		expect(items.find((item) => item.id === "maxChars")).toMatchObject({ kind: "int", value: 30, default: 50, min: 10, max: 100 });
		expect(items.find((item) => item.id === "modelSpec")).toMatchObject({ kind: "text", value: "", default: "" });
		expect(items.every((item) => !("locked" in item))).toBe(true);
	});

	it("saves a change, keeps unknown keys, and applies it", async () => {
		writeFileSync(configPath, JSON.stringify({ custom: 1 }));
		const harness = createHarness();
		const provider = harness.settings();
		expect(provider.file).toBe(configPath);
		expect(await provider.set("scope", "all")).toEqual({ ok: true });
		expect(await provider.set("maxChars", 20)).toEqual({ ok: true });
		expect(savedFile()).toEqual({ custom: 1, scope: "all", maxChars: 20 });
		expect(provider.items().find((item) => item.id === "scope")).toMatchObject({ value: "all" });

		await harness.command("status");
		expect(String(harness.ui.notify.mock.calls.at(-1)?.[0])).toContain("scope=all");
	});

	it("rejects invalid values without saving", async () => {
		const provider = createHarness().settings();
		expect(await provider.set("maxChars", 5)).toMatchObject({ ok: false });
		expect(await provider.set("timeoutMs", 1500.5)).toMatchObject({ ok: false });
		expect(await provider.set("format", "json")).toMatchObject({ ok: false });
		expect(await provider.set("enabled", "yes")).toMatchObject({ ok: false });
		expect(await provider.set("modelSpec", "no-slash")).toMatchObject({ ok: false });
		expect(await provider.set("nope", true)).toMatchObject({ ok: false });
		expect(() => readFileSync(configPath)).toThrow();
	});

	it("validates the model against the registry and resets it with the empty default", async () => {
		const harness = createHarness();
		await harness.emit("session_start", { type: "session_start", reason: "startup" });
		const provider = harness.settings();
		harness.modelRegistry.hasConfiguredAuth.mockReturnValueOnce(false);
		expect(await provider.set("modelSpec", "test/model")).toMatchObject({ ok: false, error: expect.stringContaining("no auth") });
		expect(await provider.set("modelSpec", "test/model")).toEqual({ ok: true });
		expect(savedFile()).toEqual({ modelSpec: "test/model" });
		expect(await provider.set("modelSpec", "")).toEqual({ ok: true });
		expect(savedFile()).toEqual({});
	});

	it("locks fields set by the environment", async () => {
		const harness = createHarness({ env: { PI_AUTOTITLE_FORMAT: "text" } });
		const provider = harness.settings();
		expect(provider.items().find((item) => item.id === "format")).toMatchObject({ value: "text", locked: "Set by PI_AUTOTITLE_FORMAT" });
		expect(await provider.set("format", "tool")).toMatchObject({ ok: false, error: expect.stringContaining("PI_AUTOTITLE_FORMAT") });

		await harness.command("tool");
		expect(harness.ui.notify).toHaveBeenLastCalledWith(expect.stringContaining("PI_AUTOTITLE_FORMAT"), "warning");
		expect(() => readFileSync(configPath)).toThrow();
	});

	it("lets the environment win over the file", () => {
		writeFileSync(configPath, JSON.stringify({ enabled: false, maxChars: 30 }));
		const items = createHarness({ env: { PI_AUTOTITLE: "1" } }).settings().items();
		expect(items.find((item) => item.id === "enabled")).toMatchObject({ value: true, locked: "Set by PI_AUTOTITLE" });
		expect(items.find((item) => item.id === "maxChars")).toMatchObject({ value: 30 });
	});

	it("saves /autotitle changes so they survive a restart", async () => {
		const first = createHarness();
		await first.command("off");
		await first.command("text");
		expect(savedFile()).toEqual({ enabled: false, format: "text" });

		// A restart drops the process-wide state; the file brings the settings back.
		resetAutotitleState();
		const items = createHarness().settings().items();
		expect(items.find((item) => item.id === "enabled")).toMatchObject({ value: false });
		expect(items.find((item) => item.id === "format")).toMatchObject({ value: "text" });
	});
});

describe("pi-autotitle wiring", () => {
	it("keeps /autotitle off when pi rebuilds the extension for a new session", async () => {
		const first = createHarness();
		await first.commands
			.get("autotitle")
			?.handler("off", first.ctx as unknown as ExtensionCommandContext);

		// pi calls the factory again on /new, /resume, /fork, and /reload.
		const second = createHarness();
		await startNew(second);
		second.state.branch = [userEntry("Fix login"), assistantEntry("done")];
		await settle(second);
		expect(second.complete).not.toHaveBeenCalled();
	});

	it("keeps counters across extension instances", async () => {
		const first = createHarness();
		await startNew(first);
		first.state.branch = [userEntry("Fix login"), assistantEntry("done")];
		await settle(first);

		const second = createHarness({ state: { id: "session-2" } });
		await second.commands
			.get("autotitle")
			?.handler("status", second.ctx as unknown as ExtensionCommandContext);
		const message = second.ui.notify.mock.calls.map(([text]) => String(text)).join("\n");
		expect(message).toContain("runs 1");
	});

	it("aborts an in-flight request on session_shutdown", async () => {
		const signals: AbortSignal[] = [];
		const harness = createHarness({ complete: hangingComplete(signals) });
		await startNew(harness);
		harness.state.branch = [userEntry("Fix login"), assistantEntry("partial")];
		await harness.emit("agent_settled", { type: "agent_settled", aborted: false });
		await flush();
		expect(signals).toHaveLength(1);

		await harness.emit("session_shutdown", { type: "session_shutdown", reason: "reload" });
		await flush();
		await flush();
		expect(signals[0]?.aborted).toBe(true);
		expect(harness.setSessionName).not.toHaveBeenCalled();
	});

	it("generates and commits a title after the first settle", async () => {
		const harness = createHarness();
		await startNew(harness);
		harness.state.branch = [userEntry("Fix login"), assistantEntry("I found the bug in auth.ts")];
		await settle(harness);
		expect(harness.setSessionName).toHaveBeenCalledWith("Fix login");
		expect(harness.complete).toHaveBeenCalledTimes(1);
	});

	it("does not generate when the session already has a name", async () => {
		const harness = createHarness({ state: { name: "Manual" } });
		await startNew(harness);
		harness.state.branch = [userEntry("Fix login"), assistantEntry("done")];
		await settle(harness);
		expect(harness.complete).not.toHaveBeenCalled();
	});

	it("generates only once across multiple settles", async () => {
		const harness = createHarness();
		await startNew(harness);
		harness.state.branch = [userEntry("Fix login"), assistantEntry("done")];
		await settle(harness);
		await settle(harness);
		expect(harness.complete).toHaveBeenCalledTimes(1);
	});

	it("discards a generated title when a manual name arrives during generation", async () => {
		const complete = vi.fn(
			async (
				_model: unknown,
				_context: unknown,
				requestOptions: { signal?: AbortSignal },
			) =>
				new Promise((_resolve, reject) => {
					requestOptions.signal?.addEventListener(
						"abort",
						() => reject(new Error("aborted")),
						{ once: true },
					);
				}),
		);
		const harness = createHarness({ complete });
		await startNew(harness);
		harness.state.branch = [userEntry("Fix login"), assistantEntry("partial")];
		await harness.emit("agent_settled", { type: "agent_settled", aborted: false });
		await flush();
		harness.state.name = "Manual";
		await harness.emit("session_info_changed", {
			type: "session_info_changed",
			name: "Manual",
		});
		await flush();
		await flush();
		expect(harness.setSessionName).not.toHaveBeenCalled();
	});

	it("passes partial output and interrupted status to the title model", async () => {
		const complete = vi.fn(async () => fakeAssistant([toolCallContent("修改 auth 登录逻辑")]));
		const harness = createHarness({ complete });
		await startNew(harness);
		harness.state.branch = [userEntry("继续"), assistantEntry("正在修改 auth.ts", "aborted")];
		await settle(harness, true);
		expect(harness.setSessionName).toHaveBeenCalledWith("修改 auth 登录逻辑");
		const call = complete.mock.calls[0] as unknown[] | undefined;
		const context = call?.[1] as { messages?: Array<{ content?: Array<{ text?: string }> }> } | undefined;
		const prompt = context?.messages?.[0]?.content?.[0]?.text ?? "";
		expect(prompt).toContain("正在修改 auth.ts");
		expect(prompt).toContain("<turn_status>interrupted</turn_status>");
	});

	it("uses text mode and parses plain text", async () => {
		const complete = vi.fn(async () => fakeAssistant([textContent("Title: Fix login.")]));
		const harness = createHarness({ env: { PI_AUTOTITLE_FORMAT: "text" }, complete });
		await startNew(harness);
		harness.state.branch = [userEntry("Fix login"), assistantEntry("done")];
		await settle(harness);
		expect(harness.setSessionName).toHaveBeenCalledWith("Fix login");
		const call = complete.mock.calls[0] as unknown[] | undefined;
		const context = call?.[1] as { tools?: unknown } | undefined;
		expect(context?.tools).toBeUndefined();
	});

	it("preview generates without committing and reports the source", async () => {
		const harness = createHarness();
		await startNew(harness);
		harness.state.branch = [userEntry("Fix login"), assistantEntry("done")];
		const command = harness.commands.get("autotitle");
		expect(command).toBeDefined();
		await command?.handler("preview", harness.ctx as unknown as ExtensionCommandContext);
		expect(harness.setSessionName).not.toHaveBeenCalled();
		expect(harness.ui.notify.mock.calls.some(([message]) => String(message).includes("Preview"))).toBe(true);
	});

	it("status includes counters after a run", async () => {
		const harness = createHarness();
		await startNew(harness);
		harness.state.branch = [userEntry("Fix login"), assistantEntry("done")];
		await settle(harness);
		await harness.commands
			.get("autotitle")
			?.handler("status", harness.ctx as unknown as ExtensionCommandContext);
		const message = harness.ui.notify.mock.calls.map(([text]) => String(text)).join("\n");
		expect(message).toContain("runs 1");
		expect(message).toContain("tool 1");
	});

	it("retry force overwrites a manual name", async () => {
		const harness = createHarness({ state: { name: "Manual" } });
		await startNew(harness);
		harness.state.branch = [userEntry("Fix login"), assistantEntry("done")];
		await harness.commands
			.get("autotitle")
			?.handler("retry force", harness.ctx as unknown as ExtensionCommandContext);
		expect(harness.setSessionName).toHaveBeenCalledWith("Fix login");
	});
});

import { randomUUID } from "node:crypto";

import type {
	AssistantMessage,
	Context,
	Model,
	ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";

import type { TitleMode } from "./config.js";
import { fallbackTitle } from "./fallback.js";
import { extractTextTitle, extractToolTitle } from "./normalize.js";
import {
	buildSessionTitleTool,
	buildSystemPrompt,
	buildUserPrompt,
} from "./prompt.js";
import { describeError } from "./text.js";
import { ZERO_TITLE_USAGE, type CompleteFn, type GenerationResult, type TitleInput, type TitleUsage } from "./types.js";

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 500;
const PROVIDER_RETRY_WINDOW_MS = 6_000;
const MAX_OUTPUT_TOKENS = 512;

export interface GenerationOptions {
	readonly model: Model<any>;
	readonly input: TitleInput;
	readonly mode: TitleMode;
	readonly maxChars: number;
	readonly timeoutMs: number;
	readonly fallback: boolean;
	readonly maxInputChars: number;
	readonly signal: AbortSignal;
	readonly complete: CompleteFn;
	readonly now?: () => number;
	readonly randomId?: () => string;
	readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(new Error("aborted"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

function addUsage(total: TitleUsage, message: AssistantMessage): TitleUsage {
	const usage = message.usage;
	if (!usage) return total;
	return {
		input: total.input + (usage.input ?? 0),
		output: total.output + (usage.output ?? 0),
		cost: total.cost + (usage.cost?.total ?? 0),
	};
}

export async function generateTitle(options: GenerationOptions): Promise<GenerationResult> {
	const now = options.now ?? Date.now;
	const makeId = options.randomId ?? randomUUID;
	const sleep = options.sleep ?? defaultSleep;
	const startedAt = now();
	const modelLabel = `${options.model.provider}/${options.model.id}`;

	let attempts = 0;
	let invalidAttempts = 0;
	let providerErrors = 0;
	let timeouts = 0;
	let lastError: string | undefined;
	let usage: TitleUsage = ZERO_TITLE_USAGE;
	// Only an unusable response earns the correction line; a provider error says
	// nothing about what the model would have answered.
	let previousInvalid = false;

	function finish(
		fields: Pick<GenerationResult, "title" | "source" | "error" | "cancelled">,
	): GenerationResult {
		return {
			...fields,
			attempts,
			invalidAttempts,
			providerErrors,
			timeouts,
			latencyMs: Math.max(0, now() - startedAt),
			mode: options.mode,
			model: modelLabel,
			turnStatus: options.input.status,
			usage,
		};
	}

	const cancelled = (): GenerationResult =>
		finish({ title: undefined, source: undefined, error: "cancelled", cancelled: true });

	const systemPrompt = buildSystemPrompt(options.mode, options.maxChars);
	const maxUserChars = Math.max(1_000, options.maxInputChars - systemPrompt.length - 200);

	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
		if (options.signal.aborted) return cancelled();

		attempts += 1;
		const userPrompt = buildUserPrompt(options.input, options.mode, {
			maxInputChars: maxUserChars,
			previousInvalid,
		});
		previousInvalid = false;
		const context: Context = {
			systemPrompt,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: userPrompt }],
					timestamp: now(),
				},
			],
		};
		if (options.mode === "tool") {
			context.tools = [buildSessionTitleTool(options.maxChars)];
		}

		const timeoutController = new AbortController();
		const timer = setTimeout(() => timeoutController.abort(new Error("timeout")), options.timeoutMs);
		const signal = AbortSignal.any([options.signal, timeoutController.signal]);
		const requestOptions: ModelsSimpleStreamOptions = {
			maxTokens: MAX_OUTPUT_TOKENS,
			timeoutMs: options.timeoutMs,
			maxRetries: 0,
			cacheRetention: "none",
			sessionId: makeId(),
			signal,
		};

		const attemptStartedAt = now();
		let message: AssistantMessage;
		try {
			message = await options.complete(options.model, context, requestOptions);
		} catch (error) {
			clearTimeout(timer);
			if (options.signal.aborted) return cancelled();
			if (timeoutController.signal.aborted) {
				timeouts += 1;
				lastError = "timed out";
				break;
			}
			providerErrors += 1;
			lastError = describeError(error);
			const elapsed = Math.max(0, now() - attemptStartedAt);
			if (attempt === 0 && elapsed < PROVIDER_RETRY_WINDOW_MS) {
				try {
					await sleep(RETRY_DELAY_MS, options.signal);
				} catch {
					return cancelled();
				}
				continue;
			}
			break;
		} finally {
			clearTimeout(timer);
		}

		usage = addUsage(usage, message);
		if (options.signal.aborted) return cancelled();
		if (message.stopReason === "aborted") {
			if (timeoutController.signal.aborted) {
				timeouts += 1;
				lastError = "timed out";
			} else {
				providerErrors += 1;
				lastError = message.errorMessage ?? "aborted";
			}
			break;
		}
		if (message.stopReason === "error") {
			if (timeoutController.signal.aborted) {
				timeouts += 1;
				lastError = "timed out";
				break;
			}
			providerErrors += 1;
			lastError = message.errorMessage ?? "provider error";
			const elapsed = Math.max(0, now() - attemptStartedAt);
			if (attempt === 0 && elapsed < PROVIDER_RETRY_WINDOW_MS) {
				try {
					await sleep(RETRY_DELAY_MS, options.signal);
				} catch {
					return cancelled();
				}
				continue;
			}
			break;
		}

		const title =
			options.mode === "tool"
				? extractToolTitle(message, options.maxChars)
				: extractTextTitle(message, options.maxChars);
		if (title) {
			return finish({ title, source: options.mode, error: undefined, cancelled: false });
		}

		invalidAttempts += 1;
		lastError = "invalid title output";
		previousInvalid = true;
	}

	if (options.fallback && !options.signal.aborted) {
		const title = fallbackTitle(options.input, options.maxChars);
		if (title) {
			return finish({ title, source: "fallback", error: lastError, cancelled: false });
		}
	}

	return finish({
		title: undefined,
		source: undefined,
		error: lastError,
		cancelled: options.signal.aborted,
	});
}

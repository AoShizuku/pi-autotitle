import type {
	AssistantMessage,
	Context,
	Model,
	ModelsSimpleStreamOptions,
} from "@earendil-works/pi-ai";

import type { TitleMode, TitleScope } from "./config.js";

export type TurnStatus = "completed" | "interrupted" | "error";
export type TitleSource = "tool" | "text" | "fallback";

export interface TitleInput {
	readonly userMessages: readonly string[];
	readonly assistantText: string;
	readonly toolTrace: string;
	readonly status: TurnStatus;
}

export interface GenerationResult {
	readonly title: string | undefined;
	readonly source: TitleSource | undefined;
	readonly attempts: number;
	readonly invalidAttempts: number;
	readonly providerErrors: number;
	readonly timeouts: number;
	readonly latencyMs: number;
	readonly error: string | undefined;
	readonly cancelled: boolean;
	readonly mode: TitleMode;
	readonly model: string | undefined;
	readonly turnStatus: TurnStatus;
	/** Tokens and cost summed over every attempt that returned a response. */
	readonly usage: TitleUsage;
}

/** Title calls stay out of the session's own accounting, so they are tallied here. */
export interface TitleUsage {
	readonly input: number;
	readonly output: number;
	readonly cost: number;
}

export const ZERO_TITLE_USAGE: TitleUsage = { input: 0, output: 0, cost: 0 };

export type CompleteFn = (
	model: Model<any>,
	context: Context,
	options: ModelsSimpleStreamOptions,
) => Promise<AssistantMessage>;

/** Live settings: environment over <agent dir>/pi-autotitle.json over defaults (config.ts). */
export interface RuntimeSettings {
	enabled: boolean;
	format: TitleMode;
	fallback: boolean;
	maxChars: number;
	timeoutMs: number;
	scope: TitleScope;
	modelSpec: string | undefined;
}

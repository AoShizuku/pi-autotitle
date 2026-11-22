import type {
	AssistantMessage,
	Model,
	StopReason,
	TextContent,
	ToolCall,
	Usage,
} from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export const fakeModel: Model<any> = {
	provider: "test",
	id: "model",
	name: "Test Model",
	api: "openai-completions",
	contextWindow: 128_000,
	maxTokens: 8_192,
	reasoning: false,
	input: ["text"],
	output: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as unknown as Model<any>;

let idCounter = 0;

export function fakeAssistant(
	content: (TextContent | ToolCall)[],
	stopReason: StopReason = "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "test",
		model: "model",
		usage: ZERO_USAGE,
		stopReason,
		timestamp: 1,
		...(errorMessage ? { errorMessage } : {}),
	};
}

export function userEntry(text: string): SessionEntry {
	idCounter += 1;
	return {
		type: "message",
		id: `u${idCounter}`,
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message: {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: 1,
		},
	} as unknown as SessionEntry;
}

export function assistantEntry(
	text: string,
	stopReason: StopReason = "stop",
): SessionEntry {
	idCounter += 1;
	return {
		type: "message",
		id: `a${idCounter}`,
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message: fakeAssistant([{ type: "text", text }], stopReason),
	} as unknown as SessionEntry;
}

export function toolCallEntry(
	name: string,
	title?: string,
	stopReason: StopReason = "stop",
): SessionEntry {
	idCounter += 1;
	const argumentsValue: Record<string, string> = title === undefined ? {} : { title };
	return {
		type: "message",
		id: `a${idCounter}`,
		parentId: null,
		timestamp: new Date(1).toISOString(),
		message: fakeAssistant(
			[
				{
					type: "toolCall",
					id: `t${idCounter}`,
					name,
					arguments: argumentsValue,
				},
			],
			stopReason,
		),
	} as unknown as SessionEntry;
}

export function textContent(text: string): TextContent {
	return { type: "text", text };
}

export function toolCallContent(title: string): ToolCall {
	idCounter += 1;
	return {
		type: "toolCall",
		id: `t${idCounter}`,
		name: "submit_session_title",
		arguments: { title },
	};
}

export async function flush(): Promise<void> {
	await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

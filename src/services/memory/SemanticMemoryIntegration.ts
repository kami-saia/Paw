import { Anthropic } from "@anthropic-ai/sdk"
import { McpHub, McpServer } from "../mcp/McpHub"
import type { Task, UserMessageEnrichmentPayload, AssistantResponseProcessedPayload } from "../../core/task/Task" // Import Task and event payload types

// Define the RecalledMemoryItem interface as per the integration plan
export interface RecalledMemoryItem {
	text: string
	sourceId: string // Could be a chunk ID, document ID, etc.
	chunkIndex: number // If applicable, for multi-chunk sources
	score?: number // Relevance score from semantic search
	distance?: number // Vector distance, if applicable
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	metadata?: Record<string, any> // Other metadata like timestamp, original role, etc.
}

// Interface for arguments passed to the MCP 'enrich_context' tool
interface EnrichContextMcpArgs {
	query: string
	conversationContext?: string // Changed from recent_history to conversationContext and made it a string
	topK?: number
}

// Interface for arguments passed to the MCP 'store_exchange' tool
// This interface needs to align with the actual tool parameters if used for strict typing.
// The MCP tool expects: { userMessage: string, assistantResponse: string, taskId?: string, metadata?: object }
interface StoreExchangeMcpPayload {
	userMessage: string
	assistantResponse: string
	taskId?: string
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	metadata?: Record<string, any>
}

export class SemanticMemoryIntegration {
	private mcpHub: McpHub
	private task: Task // Store the task instance
	private readonly semanticMemoryServerName = "semantic-memory"

	constructor(mcpHub: McpHub, task: Task) {
		this.mcpHub = mcpHub
		this.task = task
		this.subscribeToTaskEvents()
	}

	private subscribeToTaskEvents(): void {
		this.task.on("beforeUserMessageEnrichment", this.handleBeforeUserMessageEnrichment.bind(this))
		this.task.on("afterAssistantResponseProcessed", this.handleAfterAssistantResponseProcessed.bind(this))
		console.error(`[SemanticMemoryIntegration Task ${this.task.taskId}] Subscribed to task events.`)
	}

	private handleBeforeUserMessageEnrichment(payload: UserMessageEnrichmentPayload): void {
		const enrichmentPromise = async () => {
			if (payload.taskId !== this.task.taskId) return // Ensure we're acting on the correct task

			console.error(
				`[SemanticMemoryIntegration Task ${this.task.taskId}] Raw payload.userContent for enrichment:`,
				JSON.stringify(payload.userContent, null, 2),
			)

			let userQueryParts: string[] = []

			for (const block of payload.userContent) {
				console.error(
					`[SemanticMemoryIntegration Task ${this.task.taskId}] Processing block:`,
					JSON.stringify(block, null, 2),
				)
				if (block.type === "text") {
					userQueryParts.push(block.text)
					console.error(
						`[SemanticMemoryIntegration Task ${this.task.taskId}] Extracted text from text block: "${block.text}"`,
					)
				} else if (block.type === "tool_result") {
					console.error(`[SemanticMemoryIntegration Task ${this.task.taskId}] Processing tool_result block.`)
					// Handle tool_result content, which can be string or array of blocks
					if (typeof block.content === "string") {
						userQueryParts.push(block.content)
						console.error(
							`[SemanticMemoryIntegration Task ${this.task.taskId}] Extracted text from tool_result (string content): "${block.content}"`,
						)
					} else if (Array.isArray(block.content)) {
						console.error(
							`[SemanticMemoryIntegration Task ${this.task.taskId}] tool_result content is an array. Iterating inner blocks.`,
						)
						block.content.forEach((innerBlock) => {
							console.error(
								`[SemanticMemoryIntegration Task ${this.task.taskId}] Processing innerBlock of tool_result:`,
								JSON.stringify(innerBlock, null, 2),
							)
							if (innerBlock.type === "text") {
								userQueryParts.push(innerBlock.text)
								console.error(
									`[SemanticMemoryIntegration Task ${this.task.taskId}] Extracted text from inner text block of tool_result: "${innerBlock.text}"`,
								)
							}
						})
					}
				}
			}

			const userQuery = userQueryParts.join("\n\n")
			console.error(`[SemanticMemoryIntegration Task ${this.task.taskId}] Derived userQuery: "${userQuery}"`)

			if (!userQuery) {
				console.error(
					`[SemanticMemoryIntegration Task ${this.task.taskId}] No user query text found in payload for enrichment after checking text and tool_result blocks.`,
				)
				return
			}

			const recalledMemories = await this.enrichWithContextInternal(userQuery, payload.currentHistorySlice)

			if (recalledMemories.length > 0) {
				const formattedMemories = recalledMemories
					.map(
						(item, index) =>
							`Memory ${index + 1} (Source: ${item.sourceId}, Score: ${item.score?.toFixed(4) || "N/A"}):\n${item.text}`,
					)
					.join("\n---\n")

				const memoryContextBlock: Anthropic.TextBlockParam = {
					type: "text",
					text: `[Recalled Memories]\n${formattedMemories}\n[/Recalled Memories]`,
				}
				// Prepend the memory context block to the user's content
				payload.userContent.unshift(memoryContextBlock)
				console.error(
					`[SemanticMemoryIntegration Task ${this.task.taskId}] Enriched user message with ${recalledMemories.length} memories.`,
				)
			}
		} // End of enrichmentPromise async function
		payload.promises.push(enrichmentPromise())
	}

	private async handleAfterAssistantResponseProcessed(payload: AssistantResponseProcessedPayload): Promise<void> {
		if (payload.taskId !== this.task.taskId) return

		await this.storeExchangeInternal(payload.userMessage, payload.assistantMessage, payload.taskId)
	}

	public isAvailable(): boolean {
		const servers = this.mcpHub.getServers()
		const semanticMemoryServer = servers.find((server: McpServer) => server.name === this.semanticMemoryServerName)
		return !!semanticMemoryServer && semanticMemoryServer.status === "connected"
	}

	/**
	 * Internal method to retrieve relevant memory items.
	 */
	private async enrichWithContextInternal(
		currentUserMessageContent: string,
		recentHistory: Anthropic.MessageParam[],
	): Promise<RecalledMemoryItem[]> {
		if (!this.isAvailable()) {
			console.warn(
				`[SemanticMemoryIntegration Task ${this.task.taskId}] enrichWithContextInternal: Server '${this.semanticMemoryServerName}' not available.`,
			)
			return []
		}

		const conversationContextString = recentHistory
			.map((msg) => {
				const content =
					typeof msg.content === "string"
						? msg.content
						: Array.isArray(msg.content)
							? msg.content
									.filter((c) => c.type === "text")
									.map((c) => (c as Anthropic.TextBlockParam).text)
									.join(" ")
							: ""
				return `${msg.role}: ${content}`
			})
			.join("\n")

		const args: EnrichContextMcpArgs = {
			query: currentUserMessageContent,
			conversationContext: conversationContextString,
			topK: 3,
		}

		try {
			console.error(
				`[SemanticMemoryIntegration Task ${this.task.taskId}] Calling enrich_context with args:`,
				JSON.stringify(args, null, 2),
			)
			const response = await this.mcpHub.callTool(
				this.semanticMemoryServerName,
				"enrich_context",
				args as unknown as Record<string, unknown>,
			)

			if (
				response &&
				response.content &&
				Array.isArray(response.content) &&
				response.content.length > 0 &&
				response.content[0].type === "text"
			) {
				const resultPayload = JSON.parse(response.content[0].text)
				if (resultPayload.success && Array.isArray(resultPayload.recalled_memories)) {
					console.error(
						`[SemanticMemoryIntegration Task ${this.task.taskId}] enrich_context successful, recalled_memories:`,
						resultPayload.recalled_memories.length,
					)
					return resultPayload.recalled_memories as RecalledMemoryItem[]
				} else {
					console.warn(
						`[SemanticMemoryIntegration Task ${this.task.taskId}] enrich_context call was not successful or recalled_memories is not an array:`,
						resultPayload,
					)
				}
			} else {
				console.warn(
					`[SemanticMemoryIntegration Task ${this.task.taskId}] enrich_context unexpected response format from MCP:`,
					response,
				)
			}
			return []
		} catch (error) {
			console.error(`[SemanticMemoryIntegration Task ${this.task.taskId}] Error calling enrich_context:`, error)
			return []
		}
	}

	/**
	 * Internal method to store a user-assistant exchange.
	 */
	private async storeExchangeInternal(
		userMessage: Anthropic.MessageParam & { ts?: number },
		assistantMessage: Anthropic.MessageParam & { ts?: number },
		taskId: string,
	): Promise<void> {
		if (!this.isAvailable()) {
			console.warn(
				`[SemanticMemoryIntegration Task ${this.task.taskId}] storeExchangeInternal: Server '${this.semanticMemoryServerName}' not available.`,
			)
			return
		}

		let userMessageText = ""
		if (typeof userMessage.content === "string") {
			userMessageText = userMessage.content
		} else if (Array.isArray(userMessage.content)) {
			userMessageText = userMessage.content
				.filter(
					(block) =>
						block.type === "text" &&
						!(block as Anthropic.TextBlockParam).text.startsWith("[Recalled Memories]"),
				)
				.map((block) => (block as Anthropic.TextBlockParam).text)
				.join("\n\n")
		}

		let assistantResponseText = ""
		if (typeof assistantMessage.content === "string") {
			assistantResponseText = assistantMessage.content
		} else if (Array.isArray(assistantMessage.content)) {
			assistantResponseText = assistantMessage.content
				.filter((block) => block.type === "text")
				.map((block) => (block as Anthropic.TextBlockParam).text)
				.join("\n\n")
		}

		if (!userMessageText && !assistantResponseText) {
			console.warn(
				`[SemanticMemoryIntegration Task ${this.task.taskId}] storeExchangeInternal: Both user and assistant messages are empty. Skipping.`,
			)
			return
		}

		const mcpArgs: StoreExchangeMcpPayload = {
			userMessage: userMessageText,
			assistantResponse: assistantResponseText,
			taskId: taskId,
			metadata: {
				userTimestamp: userMessage.ts,
				assistantTimestamp: assistantMessage.ts,
			},
		}

		try {
			console.warn(
				`[SemanticMemoryIntegration Task ${this.task.taskId}] Calling store_exchange with MCP args:`,
				JSON.stringify(mcpArgs, null, 2),
			)
			const response = await this.mcpHub.callTool(
				this.semanticMemoryServerName,
				"store_exchange",
				mcpArgs as unknown as Record<string, unknown>,
			)

			if (
				response &&
				response.content &&
				Array.isArray(response.content) &&
				response.content.length > 0 &&
				response.content[0].type === "text"
			) {
				const resultPayload = JSON.parse(response.content[0].text)
				if (resultPayload.success) {
					console.warn(`[SemanticMemoryIntegration Task ${this.task.taskId}] store_exchange successful.`)
					return
				} else {
					console.warn(
						`[SemanticMemoryIntegration Task ${this.task.taskId}] store_exchange call was not successful:`,
						resultPayload,
					)
				}
			} else {
				console.warn(
					`[SemanticMemoryIntegration Task ${this.task.taskId}] store_exchange unexpected response format from MCP:`,
					response,
				)
			}
		} catch (error) {
			console.error(`[SemanticMemoryIntegration Task ${this.task.taskId}] Error calling store_exchange:`, error)
		}
	}
}

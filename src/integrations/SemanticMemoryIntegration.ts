import { Anthropic } from "@anthropic-ai/sdk"
import { McpHub, McpServer } from "../services/mcp/McpHub"
import type { Task, UserMessageEnrichmentPayload, AssistantResponseProcessedPayload } from "../core/task/Task" // Import Task and event payload types

// Define the RecalledMemoryItem interface as per the integration plan
export interface RecalledMemoryItem {
	text: string
	sourceId: string // Could be a chunk ID, document ID, etc.
	chunkIndex: number // If applicable, for multi-chunk sources
	score?: number // Relevance score from semantic search
	distance?: number // Vector distance, if applicable
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

			// Clean up any stale memory blocks from previous enrichment runs before processing
			payload.userContent = payload.userContent.filter((block) => {
				if (block.type === "text") {
					// Filter out blocks that are just recalled memories.
					return !block.text.trim().startsWith("[Recalled Memories]")
				}
				return true
			})

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

			const rawUserQuery = userQueryParts.join("\n\n")
			// Clean the query to remove artifacts like previous recalled memories or tool tags
			const userQuery = this.cleanMessageContent(rawUserQuery)
			console.error(`[SemanticMemoryIntegration Task ${this.task.taskId}] Derived userQuery: "${userQuery}"`)

			if (!userQuery) {
				console.error(
					`[SemanticMemoryIntegration Task ${this.task.taskId}] No user query text found in payload for enrichment after cleaning.`,
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

		// Use the last 6 messages (3 user/assistant pairs) for context to keep it relevant and lightweight.
		const historySlice = recentHistory.slice(-6)

		const conversationContextString = historySlice
			.map((msg) => {
				let content =
					typeof msg.content === "string"
						? msg.content
						: Array.isArray(msg.content)
							? msg.content
									.filter((c) => c.type === "text")
									.map((c) => (c as Anthropic.TextBlockParam).text)
									.join(" ")
							: ""
				// Clean the content to remove memory blocks and other noise before sending as context
				content = this.cleanMessageContent(content)
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

	private cleanMessageContent(text: string): string {
		if (!text) {
			return ""
		}

		let cleanedText = text

		// 0. Remove <environment_details>...</environment_details> blocks and their content
		cleanedText = cleanedText.replace(/<environment_details>[\s\S]*?<\/environment_details>\n?/g, "")

		// 1. Remove [Recalled Memories]...[/Recalled Memories] blocks and their content
		// This regex handles multi-line content within the recalled memories block
		cleanedText = cleanedText.replace(/\[Recalled Memories\][\s\S]*?\[\/Recalled Memories\]\n?/g, "")

		// 2. Remove <<<<<<< SEARCH...>>>>>>> REPLACE diff markers and their content
		// This regex handles multi-line content within the diff block
		cleanedText = cleanedText.replace(/<<<<<<< SEARCH[\s\S]*?>>>>>>> REPLACE\n?/g, "")

		// 3. Remove entire blocks for certain tool calls that are not useful for memory.
		const blockToolTags = ["ask_followup_question", "attempt_completion"]
		for (const tagName of blockToolTags) {
			const blockRegex = new RegExp(`<${tagName}(?:\\s+[^>]*)?>[\\s\\S]*?<\\/${tagName}>\\n?`, "g")
			cleanedText = cleanedText.replace(blockRegex, "")
		}

		// 4. Remove common XML-like tool tags (opening, closing, self-closing)

		// Remove self-closing tags like <tool_name /> or <tool_name/>
		cleanedText = cleanedText.replace(/<([a-zA-Z0-9_:]+)\s*\/>/g, "")

		// For other tools, just remove the tags to preserve any meaningful content inside.
		const toolTagsToRemove = [
			"read_file",
			"apply_diff",
			"search_files",
			"list_files",
			"write_to_file",
			"insert_content",
			"search_and_replace",
			"execute_command",
			"use_mcp_tool",
			"access_mcp_resource",
			"switch_mode",
			"new_task",
			"fetch_instructions",
			// Specific sub-tags that often appear and should be removed if they are part of the structure
			"args",
			"file",
			"path",
			"content",
			"diff",
			"query",
			"mode",
			"message",
			"result",
			"command",
			"server_name",
			"tool_name",
			"arguments",
			"uri",
			"task",
		]

		for (const tagName of toolTagsToRemove) {
			// Regex to match opening tags like <tagName> or <tagName attr="value">
			const openTagRegex = new RegExp(`<${tagName}(?:\\s+[^>]*)?>`, "g")
			// Regex to match closing tags </tagName>
			const closeTagRegex = new RegExp(`</${tagName}>`, "g")

			cleanedText = cleanedText.replace(openTagRegex, "")
			cleanedText = cleanedText.replace(closeTagRegex, "")
		}

		// More aggressive removal of any remaining simple XML-like tags (e.g. <param_name> or </param_name>)
		// This helps catch remnants or simple parameter tags not explicitly listed.
		cleanedText = cleanedText.replace(/<[/!]?[a-zA-Z0-9_:]+[^>]*>/g, "")

		// Trim whitespace that might be left after tag removal
		cleanedText = cleanedText.replace(/\n\s*\n/g, "\n\n") // Consolidate multiple blank lines
		cleanedText = cleanedText.trim()

		return cleanedText
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
				// .filter(block => block.type === 'text' && !(block as Anthropic.TextBlockParam).text.startsWith('[Recalled Memories]')) // Old filter, handled by cleanMessageContent
				.filter((block) => block.type === "text")
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

		// Clean the extracted text
		const cleanedUserMessage = this.cleanMessageContent(userMessageText)
		const cleanedAssistantResponse = this.cleanMessageContent(assistantResponseText)

		if (!cleanedUserMessage && !cleanedAssistantResponse) {
			console.warn(
				`[SemanticMemoryIntegration Task ${this.task.taskId}] storeExchangeInternal: Both user and assistant messages are empty after cleaning. Skipping.`,
			)
			return
		}

		const mcpArgs: StoreExchangeMcpPayload = {
			userMessage: cleanedUserMessage,
			assistantResponse: cleanedAssistantResponse,
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

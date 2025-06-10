import { describe, it, expect, jest, beforeEach } from "@jest/globals"
import EventEmitter from "events"
import { SemanticMemoryIntegration, RecalledMemoryItem } from "../SemanticMemoryIntegration"
import { McpHub, McpServer } from "../../mcp/McpHub" // McpServer type for mock
import { Anthropic } from "@anthropic-ai/sdk"
import type {
	Task,
	UserMessageEnrichmentPayload,
	AssistantResponseProcessedPayload,
	ClineEvents,
} from "../../../core/task/Task" // Adjusted path

// Mock McpHub
jest.mock("../../mcp/McpHub")

// Mock Task (simplified EventEmitter)
class MockTask extends EventEmitter<ClineEvents> {
	public taskId: string
	constructor(taskId: string) {
		super()
		this.taskId = taskId
	}
}

describe("SemanticMemoryIntegration", () => {
	let mockMcpHub: jest.Mocked<McpHub>
	let semanticMemory: SemanticMemoryIntegration
	let mockTask: MockTask // Use our MockTask

	const semanticMemoryServerName = "semantic-memory"

	beforeEach(() => {
		jest.clearAllMocks()

		mockMcpHub = {
			getServers: jest.fn().mockReturnValue([]),
			callTool: jest.fn(),
		} as any

		mockTask = new MockTask("test-task-123") // Initialize mockTask
		// Now SemanticMemoryIntegration expects a Task instance
		semanticMemory = new SemanticMemoryIntegration(mockMcpHub, mockTask as unknown as Task)
	})

	describe("isAvailable", () => {
		it("should return true when semantic-memory server is available", () => {
			mockMcpHub.getServers.mockReturnValue([
				{ name: semanticMemoryServerName, status: "connected", config: "" } as McpServer,
			])
			expect(semanticMemory.isAvailable()).toBe(true)
		})

		it("should return false when semantic-memory server is not available", () => {
			mockMcpHub.getServers.mockReturnValue([
				{ name: "other-server", status: "connected", config: "" } as McpServer,
			])
			expect(semanticMemory.isAvailable()).toBe(false)
		})

		it("should return false when semantic-memory server is not connected", () => {
			mockMcpHub.getServers.mockReturnValue([
				{ name: semanticMemoryServerName, status: "disconnected", config: "" } as McpServer,
			])
			expect(semanticMemory.isAvailable()).toBe(false)
		})
	})

	// The existing tests for enrichWithContext and storeExchange now test the *internal* methods
	// if we want to keep them, or they can be removed if event handling tests are sufficient.
	// For now, let's assume they test the internal logic which is still valuable.
	// We might need to make enrichWithContextInternal and storeExchangeInternal public for direct testing
	// or refactor these tests to trigger events. Let's adapt them slightly to call the internal methods.

	describe("enrichWithContextInternal", () => {
		// Renamed to test the internal method
		it("should return recalled memories when memory is available and successful", async () => {
			const mockRecalledMemories: RecalledMemoryItem[] = [
				{ text: "Memory 1", sourceId: "s1", chunkIndex: 0 },
				{ text: "Memory 2", sourceId: "s2", chunkIndex: 1, score: 0.9 },
			]
			mockMcpHub.getServers.mockReturnValue([
				{ name: semanticMemoryServerName, status: "connected", config: "" } as McpServer,
			])
			mockMcpHub.callTool.mockResolvedValue({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							success: true,
							recalled_memories: mockRecalledMemories,
						}),
					},
				],
			})

			const recentHistory: Anthropic.MessageParam[] = [{ role: "user", content: "Previous message" }]
			// Accessing the private method for testing - requires making it public or using a spy if kept private
			const result = await (semanticMemory as any).enrichWithContextInternal("Test query", recentHistory)

			expect(mockMcpHub.callTool).toHaveBeenCalledWith(semanticMemoryServerName, "enrich_context", {
				query: "Test query",
				conversationContext: "user: Previous message",
				topK: 3,
			})
			expect(result).toEqual(mockRecalledMemories)
		})

		// ... other enrichWithContextInternal tests ...
		it("should return an empty array when memory is not available for enrichWithContextInternal", async () => {
			mockMcpHub.getServers.mockReturnValue([])
			const result = await (semanticMemory as any).enrichWithContextInternal("Test query", [])
			expect(mockMcpHub.callTool).not.toHaveBeenCalled()
			expect(result).toEqual([])
		})
	})

	describe("storeExchangeInternal", () => {
		// Renamed to test the internal method
		it("should store exchange when memory is available", async () => {
			const userMessage: Anthropic.MessageParam = {
				role: "user",
				content: "Test user message",
			}
			const assistantMessage: Anthropic.MessageParam = {
				role: "assistant",
				content: "Test assistant response",
			}

			mockMcpHub.getServers.mockReturnValue([
				{ name: semanticMemoryServerName, status: "connected", config: "" } as McpServer,
			])
			mockMcpHub.callTool.mockResolvedValue({
				content: [
					{
						type: "text",
						text: JSON.stringify({
							success: true,
						}),
					},
				],
			})

			await (semanticMemory as any).storeExchangeInternal(userMessage, assistantMessage, "task123")

			expect(mockMcpHub.callTool).toHaveBeenCalledWith(semanticMemoryServerName, "store_exchange", {
				userMessage: "Test user message",
				assistantResponse: "Test assistant response",
				taskId: "task123",
				metadata: {
					userTimestamp: undefined,
					assistantTimestamp: undefined,
				},
			})
		})
		// ... other storeExchangeInternal tests ...
		it("should not store when memory is not available for storeExchangeInternal", async () => {
			mockMcpHub.getServers.mockReturnValue([])
			const userMessage: Anthropic.MessageParam = { role: "user", content: "Test" }
			const assistantMessage: Anthropic.MessageParam = { role: "assistant", content: "Response" }
			await (semanticMemory as any).storeExchangeInternal(userMessage, assistantMessage, "task123")
			expect(mockMcpHub.callTool).not.toHaveBeenCalled()
		})
	})

	describe("Event Handling", () => {
		let enrichSpy: jest.SpiedFunction<any>
		let storeSpy: jest.SpiedFunction<any>

		beforeEach(() => {
			// Spy on the internal methods that should be called by event handlers
			enrichSpy = jest.spyOn(semanticMemory as any, "enrichWithContextInternal")
			storeSpy = jest.spyOn(semanticMemory as any, "storeExchangeInternal")

			// Ensure semantic memory is "available" for these tests
			mockMcpHub.getServers.mockReturnValue([
				{ name: semanticMemoryServerName, status: "connected", config: "" } as McpServer,
			])
		})

		afterEach(() => {
			enrichSpy.mockRestore()
			storeSpy.mockRestore()
		})

		it("should handle beforeUserMessageEnrichment event and call enrichWithContextInternal", async () => {
			const mockRecalledMemories: RecalledMemoryItem[] = [
				{ text: "Recalled context", sourceId: "mem1", chunkIndex: 0, score: 0.8 },
			]
			enrichSpy.mockResolvedValue(mockRecalledMemories) // Mock the internal method's return

			const initialUserContent: Anthropic.TextBlockParam[] = [{ type: "text", text: "Original user query" }]
			const eventPayload: UserMessageEnrichmentPayload = {
				taskId: mockTask.taskId,
				userContent: [...initialUserContent], // Pass a copy
				currentHistorySlice: [{ role: "user", content: "previous message" }],
				promises: [], // Though not used by SMI, it's part of the payload
			}

			mockTask.emit("beforeUserMessageEnrichment", eventPayload)
			await new Promise(process.nextTick) // Allow async operations in handler to complete

			expect(enrichSpy).toHaveBeenCalledWith("Original user query", eventPayload.currentHistorySlice)

			// Check if userContent in payload was modified
			expect(eventPayload.userContent.length).toBe(2)
			expect(eventPayload.userContent[0].type).toBe("text")
			expect((eventPayload.userContent[0] as Anthropic.TextBlockParam).text).toContain("[Recalled Memories]")
			expect((eventPayload.userContent[0] as Anthropic.TextBlockParam).text).toContain("Recalled context")
			expect(eventPayload.userContent[1]).toEqual(initialUserContent[0])
		})

		it("should handle afterAssistantResponseProcessed event and call storeExchangeInternal", async () => {
			storeSpy.mockResolvedValue(undefined) // storeExchangeInternal returns Promise<void>

			const userMessage: Anthropic.MessageParam = { role: "user", content: "User question" }
			const assistantMessage: Anthropic.MessageParam = { role: "assistant", content: "Assistant answer" }
			const eventPayload: AssistantResponseProcessedPayload = {
				taskId: mockTask.taskId,
				userMessage,
				assistantMessage,
			}

			mockTask.emit("afterAssistantResponseProcessed", eventPayload)
			await new Promise(process.nextTick) // Allow async operations in handler to complete

			expect(storeSpy).toHaveBeenCalledWith(userMessage, assistantMessage, mockTask.taskId)
		})

		it("should not process events for a different taskId", async () => {
			const eventPayloadEnrich: UserMessageEnrichmentPayload = {
				taskId: "different-task-id",
				userContent: [{ type: "text", text: "Original user query" }],
				currentHistorySlice: [],
				promises: [],
			}
			const eventPayloadStore: AssistantResponseProcessedPayload = {
				taskId: "different-task-id",
				userMessage: { role: "user", content: "User question" },
				assistantMessage: { role: "assistant", content: "Assistant answer" },
			}

			mockTask.emit("beforeUserMessageEnrichment", eventPayloadEnrich)
			mockTask.emit("afterAssistantResponseProcessed", eventPayloadStore)
			await new Promise(process.nextTick)

			expect(enrichSpy).not.toHaveBeenCalled()
			expect(storeSpy).not.toHaveBeenCalled()
		})

		it("should prepend memory context even if userContent has multiple blocks", async () => {
			const mockRecalledMemories: RecalledMemoryItem[] = [
				{ text: "Recalled context", sourceId: "mem1", chunkIndex: 0, score: 0.8 },
			]
			enrichSpy.mockResolvedValue(mockRecalledMemories)

			const initialUserContent: Anthropic.Messages.ContentBlockParam[] = [
				// Corrected type
				{ type: "text", text: "First part of query" },
				{ type: "image", source: { type: "base64", media_type: "image/png", data: "fakeimgdata" } },
				{ type: "text", text: "Second part of query" },
			]
			const eventPayload: UserMessageEnrichmentPayload = {
				taskId: mockTask.taskId,
				userContent: [...initialUserContent], // No need to cast if initialUserContent is correct
				currentHistorySlice: [],
				promises: [],
			}

			mockTask.emit("beforeUserMessageEnrichment", eventPayload)
			await new Promise(process.nextTick)

			expect(enrichSpy).toHaveBeenCalledWith(
				"First part of query\n\nSecond part of query", // Query extracted from text blocks
				eventPayload.currentHistorySlice,
			)

			expect(eventPayload.userContent.length).toBe(4) // Original 3 + 1 memory block
			expect(eventPayload.userContent[0].type).toBe("text")
			expect((eventPayload.userContent[0] as Anthropic.TextBlockParam).text).toContain("[Recalled Memories]")
			expect(eventPayload.userContent[1]).toEqual(initialUserContent[0])
			expect(eventPayload.userContent[2]).toEqual(initialUserContent[1])
			expect(eventPayload.userContent[3]).toEqual(initialUserContent[2])
		})
	})
})

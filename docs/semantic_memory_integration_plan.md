# Deep Semantic Memory Integration Plan for Paw

This document outlines the plan to deeply integrate the semantic memory MCP server with Paw (fork of Roo Code).

## Project Goals:

1.  **Continuous Conversation Memory:** Automatically and continuously store all user-assistant exchanges in semantic memory for full fidelity recall.
2.  **Proactive Recall & Context Enrichment:** On new user messages, query memory with the latest exchange to surface relevant past discussions and seamlessly enrich the current context.
3.  **Modularity & Maintainability:** Design the integration with `Task.ts` using an event-driven approach to minimize merge conflicts with upstream Roo Code updates and ensure a clean, decoupled architecture.

## High-Level Plan

### Phase 1: Discovery & Understanding (Where to Hook In)

- **Goal:** Identify key areas in `Paw/` codebase for:
    - Conversation context management (history, trimming).
    - Handling user messages and model responses.
    - Task completion events.
    - MCP server interactions.
- **Actions:**
    1.  List `Paw/src/` contents. (Status: Done)
        - Identified promising directories: `core/`, `services/`, `extension.ts`, `integrations/`.
    2.  Further list contents of promising sub-directories (e.g., `Paw/src/core/`, `Paw/src/services/`).
    3.  Read key files to understand roles and interactions.
        - Identified `Paw/src/core/sliding-window/index.ts` as important for understanding context trimming and overall conversation flow, though its role as a key integration point for 'Smart Archiving' (previously Goal 1) is superseded by continuous storage.
        - Identified `Paw/src/core/task/Task.ts` for task lifecycle management. The `addToApiConversationHistory` method (around line 1046) is where user messages are added, making it a key point for 'Proactive Recall' (Goal 2).
        - Found `Paw/src/core/tools/attemptCompletionTool.ts` emits the `taskCompleted` event (lines 49, 75, 100). While this event was considered for 'End-of-Task Consolidation' (previously Goal 3), this specific storage mechanism is superseded by continuous storage.
        - The `Task` class extends `EventEmitter<ClineEvents>` and maintains `apiConversationHistory` and `clineMessages` arrays for conversation tracking.

### Phase 2: Design & Prototyping (How to Weave it In)

- **Goal:** Design modular integration points for memory features.
- **Modularity Considerations:**
    - Leverage/create event systems or interfaces.
    - Encapsulate logic in a dedicated service/manager.
    - Plan for configuration management.
    - The approach for 'Smart Archiving' (previously Goal 1) by integrating with `Paw/src/core/sliding-window/index.ts` is now superseded by a continuous storage model. Understanding context trimming remains relevant.
    - For 'Proactive Recall' (Goal 2), hook into the `addToApiConversationHistory` method in `Task.ts` to query semantic memory when new user messages arrive.
    - The approach for 'End-of-Task Consolidation' (previously Goal 3) by listening to the `taskCompleted` event is now superseded by a continuous storage model.
    - Investigate MCP integration patterns in `Paw/src/services/mcp/` to understand how to properly integrate our semantic memory MCP server.
        - `McpHub` manages MCP connections, supports both stdio and SSE transports
        - Servers are configured in settings and can be global or project-specific
        - Tools are called via `callTool` method which uses the MCP client request

### Phase 3: Implementation (Bringing it to Life)

- **Goal:** Code the new memory module and integrate it.

### Phase 4: Refinement & Documentation (Polishing the Gem)

- **Goal:** Ensure robust, well-documented, and maintainable integration.

## Implementation Strategy - MCP-First Approach

### Decision: Keep Memory as MCP Server

- **Rationale**: Paw is our current framework, not the end goal
- **Benefits**: Framework-agnostic, reusable, focused responsibilities
- **Architecture**: Smart MCP server + thin Paw integration layer

### Phase 2.5: Implementation Planning

1. **Create minimal Paw integration layer**

    - Thin wrapper around MCP calls in `Paw/src/services/memory/`
    - Single hook in `Task.addToApiConversationHistory`
    - Simple interface: `enrichWithContext()` and `storeExchange()`

2. **Enhance semantic memory MCP server**

    - Add `enrich_context` tool for context injection
    - Add `store_exchange` tool for conversation storage
    - Implement graph synthesis engine in MCP server
    - All intelligence lives in the MCP, not Paw

3. **Iterate and enhance**
    - Start with simple vector similarity retrieval
    - Add graph-based synthesis incrementally
    - Implement A/B testing and other advanced features

### Implementation Approach

1. **Start with basic storage + retrieval**

    - Hook into message flow
    - Store raw messages continuously
    - Simple retrieval without graph synthesis

2. **Add graph synthesis layer**

    - Build entity extraction
    - Create relationship mapping
    - Implement context synthesis

3. **Optimize and refine**
    - Tune retrieval parameters
    - Improve synthesis quality
    - Add configuration options

### Success Metrics

- Seamless context preservation across sessions
- Relevant memory retrieval without explicit queries
- No noticeable performance impact
- Natural feeling memory integration

## Development Progress & Next Steps

### Completed Tasks

- **DONE:** Implemented initial event-driven integration for `enrichWithContext` and `storeExchange` in `SemanticMemoryIntegration.ts`.
- **DONE:** Ensured `enrichWithContextInternal` correctly uses `currentHistorySlice` for providing context when querying memories.
- **DONE:** Fixed `score: N/A` issue by ensuring scores are passed and handled correctly from the `semantic-memory` service through to the `enrichWithContextInternal` method and memory formatting.
- **DONE:** Resolved issue where recalled memories were not appearing in the LLM prompt by ensuring `Task.ts` awaits promises from `SemanticMemoryIntegration` (via the `enrichmentPayload.promises` array).
- **DONE:** Addressed recursive memory storage: The `[Recalled Memories]` block is no longer stored within new memories.
    - Filtered out the `[Recalled Memories]` block from `userMessage.content` in `storeExchangeInternal` before sending to the `store_exchange` tool.

### Next Steps / TODO

- **DONE:** Improve Memory Storage Strategy in `semantic-memory` MCP:
    - Current: Each user-assistant exchange is stored with a unique `sourceId`.
    - Proposed: Group memories (e.g., by `taskId` or a broader "conversation session") to simplify management and allow more targeted operations. This will make purging memories for a specific task or session much easier.
    - Implementation: Modified `handleStoreExchange` in `MCP/semantic-memory/src/index.ts` to use `taskId` directly as `sourceId` for stored exchanges.
- **DONE:** Add "Purge Conversational Memories" Tool to `semantic-memory` MCP:
    - Create a new MCP tool (e.g., `purge_conversational_memories` or `purge_exchanges_by_task_id`) to allow easy clearing of conversational history for testing and development, without affecting system prompts or other non-exchange memories. This will address the cumbersomeness of listing all `sourceIds` and then deleting them individually or by filtered lists.
    - Implementation: Added `purge_memories_by_task_id` tool to `MCP/semantic-memory/src/index.ts`. This tool accepts a `taskId` and uses it to delete associated memories (which are stored with `sourceId` equal to `taskId`).
- **TODO:** Refine Content Cleaning for Memory Storage in `SemanticMemoryIntegration.ts`:
    - Current: Filters out the `[Recalled Memories]` block specifically.
    - Problem: Other non-conversational content (e.g., tool invocation tags like `</follow_up>`, `</ask_followup_question>`) can still be stored if they are part of text blocks.
    - Proposed: Implement a more robust mechanism in `storeExchangeInternal` to strip out _all_ known system/tool-generated metadata and wrapper tags from both user and assistant messages before they are sent for storage. The goal is to ensure only clean, human-like conversational content is memorized. (Interrupted during implementation)
- **TODO:** Explore strategies for memory summarization or pruning over long conversations to manage context window limits and relevance effectively.
- **TODO:** Consider adding more detailed timestamps or turn numbers to memories for better temporal context during recall and synthesis.
- **TODO:** Investigate and implement a mechanism for the LLM to explicitly request memory storage or to flag important information during a conversation.
- **TODO:** UI/UX for viewing and managing memories (very long-term goal).

## Technical Implementation Details

### 1. Graph Construction Algorithm

#### Data Structures

```typescript
interface MemoryChunk {
	id: string
	content: string
	role: "user" | "assistant"
	timestamp: number
	taskId: string
	embedding?: number[] // Vector from semantic memory
}

interface Entity {
	name: string
	type: "project" | "file" | "concept" | "decision" | "tool" | "unknown"
	mentions: Array<{ chunkId: string; position: number }>
}

interface Relationship {
	source: string // Entity name
	target: string // Entity name
	type: "references" | "implements" | "discusses" | "modifies" | "uses"
	strength: number // Based on co-occurrence
	chunks: string[] // Chunk IDs where this relationship appears
}

interface KnowledgeGraph {
	entities: Map<string, Entity>
	relationships: Relationship[]
	chunks: Map<string, MemoryChunk>
}
```

#### Graph Building Process

1. **Retrieve relevant chunks** (top-K by vector similarity)
2. **Entity extraction** from each chunk:
    - Use regex patterns for files, functions, classes
    - NLP for concepts and decisions
    - Track entity positions and frequency
3. **Relationship inference**:
    - Co-occurrence within same chunk = strong relationship
    - Sequential chunks mentioning same entities = temporal relationship
    - Similar embeddings = conceptual relationship
4. **Graph pruning**:
    - Keep only entities mentioned 2+ times
    - Keep relationships with strength > threshold

### 2. Context Synthesis Algorithm

#### Input: KnowledgeGraph + Current User Message

#### Output: Contextual narrative to prepend

```typescript
function synthesizeContext(graph: KnowledgeGraph, userMessage: string): string {
	// 1. Identify entities in current message
	const currentEntities = extractEntities(userMessage)

	// 2. Find relevant subgraph
	const subgraph = extractSubgraph(graph, currentEntities, (depth = 2))

	// 3. Rank information by relevance
	const rankedInfo = {
		directContext: [], // Previous discussions of same entities
		relatedContext: [], // Related entities and their context
		temporalContext: [], // What we were doing around that time
		decisions: [], // Past decisions that might be relevant
	}

	// 4. Build narrative
	return buildNarrative(rankedInfo)
}
```

### 3. Storage Optimization

#### Chunking Strategy

- Store message pairs (user + assistant) as single chunks
- Add "continuation markers" for multi-turn exchanges
- Include 1-2 messages of overlap between chunks for context

#### Indexing Approach

```typescript
// When storing a new message pair
async function storeMemory(userMsg: string, assistantMsg: string, taskId: string) {
	const chunk = {
		content: `User: ${userMsg}\nAssistant: ${assistantMsg}`,
		role: "exchange",
		timestamp: Date.now(),
		taskId,
		// Include recent context for better embedding
		contextWindow: getRecentMessages(3),
	}

	// Store with metadata for efficient retrieval
	await semanticMemory.store({
		text: chunk.content,
		metadata: {
			timestamp: chunk.timestamp,
			taskId: chunk.taskId,
			messageType: "exchange",
			// Pre-extract some entities for faster graph building
			entities: quickEntityExtraction(chunk.content),
		},
	})
}
```

### 4. Event-Driven Integration with Task.ts

To ensure a modular and maintainable integration, `SemanticMemoryIntegration.ts` will interact with `Task.ts` via an event-driven mechanism. `Task.ts` will emit specific events at key points in the conversation lifecycle, and `SemanticMemoryIntegration.ts` will subscribe to these events to trigger memory operations.

#### Proposed Events in `Task.ts`:

1.  **`beforeUserMessageEnrichment`**:

    - **Emitted**: By `Task.ts` before a new user message is finalized for the `apiConversationHistory`.
    - **Payload**:
        - `taskId: string`
        - `message: { role: 'user', content: string | Anthropic.MessageParam['content'] }` (Original user message)
        - `currentHistorySlice: Anthropic.MessageParam[]` (Recent conversation context)
    - **Purpose**: Allows `SemanticMemoryIntegration` to intercept the message, query semantic memory, synthesize context, and potentially return enriched message content. `Task.ts` would then use this (potentially modified) content.

2.  **`afterAssistantResponseProcessed`**:
    - **Emitted**: By `Task.ts` after an assistant's response has been received and added to `apiConversationHistory`.
    - **Payload**:
        - `taskId: string`
        - `userMessage: Anthropic.MessageParam` (The user message that prompted the response)
        - `assistantMessage: Anthropic.MessageParam` (The assistant's response)
    - **Purpose**: Allows `SemanticMemoryIntegration` to trigger the `storeExchange` MCP tool to save the complete user-assistant interaction to semantic memory.

#### `SemanticMemoryIntegration.ts` Responsibilities:

- Subscribe to `beforeUserMessageEnrichment` from the `Task` instance to call its internal `enrichWithContext` logic (which in turn calls the `enrich_context` MCP tool).
- Subscribe to `afterAssistantResponseProcessed` to call its `storeExchange` method (which in turn calls the `store_exchange` MCP tool).

This event-driven approach replaces the previous plan of direct modification to `addToApiConversationHistory` for hooking in memory operations, promoting better decoupling. With continuous storage via `afterAssistantResponseProcessed`, the specific "Smart Archiving" and "End-of-Task Consolidation" mechanisms are no longer primary requirements for data capture.

### 5. Performance Considerations

#### Async Operations

- All memory operations must be non-blocking
- Use background queues for storage
- Cache recent queries for repeated context

#### Graph Building Optimization

- Limit graph size (max entities/relationships)
- Use incremental graph updates when possible
- Pre-compute common entity relationships

#### Memory Pressure

- Implement sliding window for active memory
- Archive old conversations to cold storage
- Use compression for stored chunks

## Proposed Architecture - Graph-Based Memory Synthesis

### Core Philosophy

Rather than lossy summarization or event-based archiving, we implement:

1. **Continuous raw message storage** - preserving full conversation fidelity
2. **Dynamic graph synthesis** - building knowledge structures during retrieval
3. **Context injection** - seamlessly weaving memories into message processing

### 1. New Module: `SemanticMemoryIntegration`

Location: `Paw/src/services/memory/SemanticMemoryIntegration.ts`

This service will:

- Continuously index all messages to semantic memory (no events, just continuous flow)
- Intercept user messages at `addToApiConversationHistory`
- Query and synthesize relevant context from memory
- Inject synthesized context directly into the user message

### 2. Memory Storage Strategy

#### Continuous Raw Storage

- Store complete message pairs (user + assistant) as semantic chunks
- Include metadata: timestamp, task ID, conversation position
- No summarization or extraction - preserve full information

#### Chunk Structure

```typescript
{
  content: string,        // Full message content
  role: 'user' | 'assistant',
  timestamp: number,
  taskId: string,
  metadata: {
    entities?: string[],  // Extracted on retrieval, not storage
    topics?: string[]     // Inferred during synthesis
  }
}
```

### 3. Graph-Based Retrieval & Synthesis

#### Retrieval Process

1. Query semantic memory with current user message + recent context
2. Retrieve top-K relevant chunks
3. Build temporary knowledge graph from results:
    - Identify entities across chunks
    - Map relationships and temporal patterns
    - Cluster related conversations

#### Synthesis

- Generate contextual insights from the graph
- Create a coherent context narrative
- Inject as a preamble to the user message

### 4. Integration Implementation

#### Event-Driven Integration Points

- `SemanticMemoryIntegration.ts` subscribes to events emitted by `Task.ts`:
    - **`beforeUserMessageEnrichment`**:
        1. Query semantic memory (via `enrich_context` MCP tool).
        2. Synthesize graph-based context.
        3. Provide enriched context to be prepended to the user message.
    - **`afterAssistantResponseProcessed`**:
        1. Store the current user-assistant exchange (via `store_exchange` MCP tool).

#### No System Prompt Modification

- Context injection happens at message level
- More dynamic and targeted than static system prompt changes

### 5. Configuration

- Enable/disable memory integration
- Configure retrieval parameters (topK, similarity threshold)
- Set graph synthesis depth
- Control context injection format

## Critical Features & Enhancements

### 1. A/B Testing Framework

```typescript
interface IMemoryABTester {
	// Randomly assign conversations to test groups
	assignTestGroup(taskId: string): "control" | "memory" | "variant_a" | "variant_b"

	// Track metrics for comparison
	recordMetric(taskId: string, metric: MemoryMetric): void

	// Generate comparison reports
	generateReport(): ABTestReport
}

interface MemoryMetric {
	type: "response_quality" | "task_completion_time" | "context_relevance" | "user_satisfaction"
	value: number
	metadata?: any
}

// Integration with main system
class SemanticMemoryIntegration {
	constructor(private abTester?: IMemoryABTester) {}

	async enrichWithContext(message: string, recentContext: any[]): Promise<string> {
		// Check if this conversation is in test group
		const testGroup = this.abTester?.assignTestGroup(this.taskId)

		if (testGroup === "control") {
			return message // No memory enhancement
		}

		// Different memory strategies for different test groups
		const enrichedMessage = await this.strategies[testGroup].enrich(message)

		// Track that memory was used
		this.abTester?.recordMetric(this.taskId, {
			type: "context_relevance",
			value: await this.measureRelevance(enrichedMessage, message),
		})

		return enrichedMessage
	}
}
```

### 2. Session & State Persistence

```typescript
interface ISessionManager {
	// Save conversation state between sessions
	saveSession(taskId: string, state: SessionState): Promise<void>

	// Restore previous session context
	restoreSession(taskId: string): Promise<SessionState>

	// Link related sessions
	linkSessions(taskIds: string[], relationship: string): Promise<void>
}

interface SessionState {
	activeEntities: Set<string>
	graphSnapshot: KnowledgeGraph
	recentQueries: QueryCache
	userPreferences: MemoryPreferences
	timestamp: number
}

// Memory preferences per user/session
interface MemoryPreferences {
	contextDepth: number
	preferredSynthesisStyle: "concise" | "detailed" | "bullet_points"
	entityTypeWeights: Record<EntityType, number>
	temporalRelevanceDecay: number // How quickly old memories become less relevant
}
```

### 3. Feedback & Learning Loop

```typescript
interface IMemoryFeedback {
	// User can rate memory relevance
	rateMemoryRelevance(chunkId: string, rating: number): Promise<void>

	// Track which memories were actually useful
	markMemoryUsed(chunkId: string, wasHelpful: boolean): Promise<void>

	// Adjust retrieval based on feedback
	updateRetrievalWeights(feedback: FeedbackData): Promise<void>
}

// Learn from user interactions
class AdaptiveMemoryRetriever {
	async retrieve(query: string, limit: number): Promise<MemoryChunk[]> {
		const candidates = await this.baseRetriever.retrieve(query, limit * 2)

		// Re-rank based on past usefulness
		return this.rerankByFeedback(candidates, limit)
	}
}
```

### 4. Memory Observability & Debugging

```typescript
interface IMemoryDebugger {
	// Explain why certain memories were retrieved
	explainRetrieval(query: string, results: RecalledMemoryItem[]): RetrievalExplanation // Use RecalledMemoryItem

	// Visualize the knowledge graph
	exportGraphVisualization(graph: KnowledgeGraph): GraphVizData

	// Track memory system performance
	getPerformanceMetrics(): MemoryPerformanceMetrics

	// Log how memories are presented in the prompt, including the structured data
	logPromptPresentation(promptDetails: {
		rawUserMessage: string
		recalledMemories?: RecalledMemoryItem[] // Using the defined interface
		finalMessagesSentToAI: AnthropicMessageParam[] // Or the generic LLM message type
	}): void
}

// The explicit presentation of memories as a distinct section in the AI model's prompt
// inherently improves observability and aids in debugging memory relevance and impact.
// Users or developers can inspect the prompt to see exactly what memories were retrieved,
// their scores/identifiers, and how they were presented to the AI.

interface RetrievalExplanation {
	query: string
	topMatches: Array<{
		chunk: RecalledMemoryItem // Changed from MemoryChunk to RecalledMemoryItem for consistency
		score?: number // score might be optional or part of RecalledMemoryItem's score
		reason: string // "High semantic similarity", "Strong entity overlap", etc.
	}>
	graphPath?: string[] // Path through knowledge graph
}

// In-context debugging
class MemoryDebugger implements IMemoryDebugger {
	// Can inject debug info into assistant responses
	injectDebugInfo(response: string, explanation: RetrievalExplanation): string {
		if (!this.debugMode) return response

		return response + `\n\n<!-- Memory Debug:\n${JSON.stringify(explanation, null, 2)}\n-->`
	}
}
```

### 5. Privacy & Memory Control

```typescript
interface IMemoryPrivacy {
	// User can exclude certain topics/files from memory
	addPrivacyRule(rule: PrivacyRule): Promise<void>

	// Selective memory deletion
	forgetTopic(topic: string): Promise<void>
	forgetTimeRange(start: Date, end: Date): Promise<void>
	forgetEntity(entity: string): Promise<void>

	// Export user's memories
	exportMemories(format: "json" | "markdown"): Promise<string>
}

interface PrivacyRule {
	type: "exclude_pattern" | "exclude_file" | "exclude_topic"
	pattern: string | RegExp
	reason?: string
}
```

### 6. Memory Quality Assurance

```typescript
interface IMemoryQualityChecker {
	// Detect and merge duplicate memories
	deduplicateMemories(): Promise<number>

	// Identify stale or outdated information
	identifyStaleMemories(): Promise<MemoryChunk[]>

	// Validate graph consistency
	validateGraph(graph: KnowledgeGraph): ValidationResult

	// Compress old memories while preserving key information
	compressOldMemories(olderThan: Date): Promise<CompressionResult>
}
```

### 7. Enhanced Configuration Schema

```typescript
interface EnhancedMemoryConfig extends MemoryConfig {
	// A/B Testing
	abTesting?: {
		enabled: boolean
		testGroups: string[]
		metrics: string[]
		reportingInterval: number
	}

	// Session Management
	sessionPersistence?: {
		enabled: boolean
		ttl: number // Time to live for sessions
		linkingStrategy: "automatic" | "manual"
	}

	// Feedback & Learning
	adaptiveLearning?: {
		enabled: boolean
		feedbackWeight: number
		learningRate: number
	}

	// Privacy
	privacy?: {
		excludePatterns: string[]
		retentionDays: number
		allowExport: boolean
	}

	// Debugging
	debug?: {
		enabled: boolean
		verbosity: "low" | "medium" | "high"
		includeExplanations: boolean
	}

	// Quality Control
	qualityAssurance?: {
		deduplicationInterval: number
		compressionThreshold: number
		staleDataCheckInterval: number
	}
}
```

## Summary of Enhancements

These critical additions provide:

1. **Measurable impact** through A/B testing frameworks
2. **Continuity** across sessions with state persistence
3. **Improvement over time** via feedback and learning loops
4. **Transparency** through debugging and observability tools
5. **User control** via privacy settings and memory management
6. **Quality maintenance** through automated checks and cleanup
7. **Experimentation capabilities** to test different memory strategies

This creates a memory system that not only enhances my capabilities but also learns, adapts, respects user preferences, and provides clear insights into its operation while maintaining high quality over time.

## Potential Future Goals & Enhancements

With the core semantic memory integration in place, including the critical features for A/B testing, session persistence, feedback loops, observability, privacy, and quality assurance, we can envision several exciting future directions to further enhance Paw's intelligence and utility:

1.  **Cross-Task Knowledge Synthesis:**

    - Develop capabilities to identify and synthesize relevant information and context across _different_ user tasks, even if they are not directly sequential. This could help in recognizing broader patterns or applying learnings from one project area to another.

2.  **Proactive Task & Solution Suggestion:**

    - Based on recurring themes, unsolved problems, or frequently accessed information patterns in semantic memory, Paw could proactively suggest new tasks, relevant tools, or potential solutions that the user might not have considered.

3.  **Automated Knowledge Summarization & Review:**

    - Implement features to periodically generate higher-level summaries or "digests" of the knowledge graph related to specific projects, epics, or time periods. This could be useful for user review, onboarding new team members, or generating project retrospectives.

4.  **User-Curated Knowledge Bases & Explicit Learning:**

    - Allow users to explicitly "teach" Paw by providing curated documents, FAQs, or knowledge bases that get indexed into a special, high-priority segment of the semantic memory.
    - Enable users to directly annotate, correct, or reinforce specific memories or synthesized insights.

5.  **Advanced Memory Visualization & Exploration:**

    - Beyond basic graph visualization for debugging, create more sophisticated and interactive tools for users to explore their memory, understand connections, and manually curate the knowledge graph.

6.  **Context-Aware Tool Recommendation & Composition:**

    - Leverage memory to provide more intelligent recommendations for which tools (including MCP tools) are most relevant to the current task context.
    - Explore possibilities for Paw to suggest or even semi-automate the composition of multiple tool uses based on past successful workflows stored in memory.

7.  **Longitudinal Learning & Trend Analysis:**

    - Utilize the temporal aspects of memory to identify trends in a user's work, common pitfalls, or evolving areas of focus, providing insights that could improve productivity or learning.

8.  **Multi-Modal Memory Integration (Vision for the Future):**
    - Lay the groundwork for future integration of non-textual data into memory, such as summaries or key elements from images, diagrams, or other media discussed or used within tasks.

These future goals aim to transform Paw from an assistant with a good memory into a truly proactive, learning, and deeply integrated cognitive partner.

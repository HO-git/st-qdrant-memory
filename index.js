// Qdrant Memory Extension for SillyTavern
// This extension retrieves relevant memories from Qdrant and injects them into conversations
// Version 3.1.3 - fixed partial memory storage during streaming

const extensionName = "qdrant-memory"

// Default settings
const defaultSettings = {
  enabled: true,
  qdrantUrl: "http://localhost:6333",
  qdrantApiKey: "",
  collectionName: "mem",
  embeddingProvider: "openai",
  openaiApiKey: "",
  openRouterApiKey: "",
  localEmbeddingUrl: "",
  localEmbeddingApiKey: "",
  embeddingModel: "text-embedding-3-large",
  customEmbeddingDimensions: null,
  memoryLimit: 5,
  scoreThreshold: 0.3,
  memoryPosition: 2,
  debugMode: false,
  // New v3.0 settings
  usePerCharacterCollections: true,
  autoSaveMemories: true,
  saveUserMessages: true,
  saveCharacterMessages: true,
  minMessageLength: 5,
  showMemoryNotifications: true,
  retainRecentMessages: 5,
  chunkMinSize: 1200,
  chunkMaxSize: 1500,
  chunkTimeout: 30000, // 30 seconds - save chunk if no new messages
  // NEW v3.1.2 settings
  dedupeThreshold: 0.92, // Similarity threshold for chunk deduplication
  preventDuplicateInjection: true, // Prevent inserting memories multiple times
  streamFinalizePollMs: 250,
  streamFinalizeStableMs: 1200,
  streamFinalizeMaxWaitMs: 300000,
  flushAfterAssistant: true,
}

let settings = { ...defaultSettings }
const saveQueue = []
let processingSaveQueue = false

let messageBuffer = []
let lastMessageTime = 0
let chunkTimer = null
let pendingAssistantFinalize = null

// NEW: Track which chats have had memories injected to prevent duplicates
const memoryInjectionTracker = new Set()

// Helper to create a unique hash for a chat state
function getChatHash(chat) {
  // Create a hash based on the last few messages to identify unique chat states
  const lastMessages = chat.slice(-5).map(msg => {
    return `${msg.is_user ? 'U' : 'A'}_${msg.mes?.substring(0, 50) || ''}_${msg.send_date || ''}`
  }).join('|')
  
  return lastMessages
}

const EMBEDDING_MODEL_OPTIONS = {
  openai: [
    {
      value: "text-embedding-3-large",
      label: "text-embedding-3-large (best quality)",
    },
    {
      value: "text-embedding-3-small",
      label: "text-embedding-3-small (faster)",
    },
    {
      value: "text-embedding-ada-002",
      label: "text-embedding-ada-002 (legacy)",
    },
  ],
  openrouter: [
    {
      value: "openai/text-embedding-3-large",
      label: "OpenAI: Text Embedding 3 Large",
    },
    {
      value: "openai/text-embedding-3-small",
      label: "OpenAI: Text Embedding 3 Small",
    },
    {
      value: "openai/text-embedding-ada-002",
      label: "OpenAI: Text Embedding Ada 002",
    },
    {
      value: "qwen/qwen3-embedding-8b",
      label: "Qwen: Qwen3 Embedding 8B",
    },
    {
      value: "mistralai/mistral-embed-2312",
      label: "Mistral: Mistral Embed 2312",
    },
    {
      value: "google/gemini-embedding-001",
      label: "Google: Gemini Embedding 001",
    },
  ],
}

const DEFAULT_MODEL_BY_PROVIDER = {
  openai: "text-embedding-3-large",
  openrouter: EMBEDDING_MODEL_OPTIONS.openrouter[0].value,
}

const OPENROUTER_MODEL_ALIASES = {
  "text-embedding-3-large": "openai/text-embedding-3-large",
  "text-embedding-3-small": "openai/text-embedding-3-small",
  "text-embedding-ada-002": "openai/text-embedding-ada-002",
}

const OPENAI_MODEL_ALIASES = {
  "openai/text-embedding-3-large": "text-embedding-3-large",
  "openai/text-embedding-3-small": "text-embedding-3-small",
  "openai/text-embedding-ada-002": "text-embedding-ada-002",
}

// ============================================================================
// DATE/TIMESTAMP NORMALIZATION
// ============================================================================

/**
 * Normalizes various date formats to Unix timestamp in milliseconds
 */
function normalizeTimestamp(date) {
  // Already a valid millisecond timestamp
  if (typeof date === 'number' && date > 1000000000000) {
    return date;
  }
  
  // Timestamp in seconds - convert to milliseconds
  if (typeof date === 'number' && date > 1000000000 && date < 1000000000000) {
    return date * 1000;
  }
  
  // Date object
  if (date instanceof Date) {
    const timestamp = date.getTime();
    if (!isNaN(timestamp)) {
      return timestamp;
    }
  }
  
  // String date - try to parse it
  if (typeof date === 'string' && date.trim()) {
    const parsed = new Date(date);
    const timestamp = parsed.getTime();
    if (!isNaN(timestamp)) {
      return timestamp;
    }
  }
  
  // Fallback to current time
  if (settings.debugMode) {
    console.warn('[Qdrant Memory] Could not normalize timestamp, using current time. Input:', date);
  }
  return Date.now();
}

/**
 * Formats a timestamp as YYYY-MM-DD for display in memory chunks
 */
function formatDateForChunk(timestamp) {
  try {
    const dateObj = new Date(timestamp);
    if (isNaN(dateObj.getTime())) {
      throw new Error('Invalid date');
    }
    return dateObj.toISOString().split('T')[0]; // YYYY-MM-DD format
  } catch (e) {
    console.warn('[Qdrant Memory] Error formatting date:', e, 'timestamp:', timestamp);
    return new Date().toISOString().split('T')[0]; // Fallback to today
  }
}

// ============================================================================
// SETTINGS MANAGEMENT
// ============================================================================

// Load settings from localStorage
function loadSettings() {
  const saved = localStorage.getItem(extensionName)
  if (saved) {
    try {
      settings = { ...defaultSettings, ...JSON.parse(saved) }
    } catch (e) {
      console.error("[Qdrant Memory] Failed to load settings:", e)
    }
  }
  console.log("[Qdrant Memory] Settings loaded:", settings)
}

// Save settings to localStorage
function saveSettings() {
  localStorage.setItem(extensionName, JSON.stringify(settings))
  console.log("[Qdrant Memory] Settings saved")
}

// Get collection name for a character
function getCollectionName(characterName) {
  if (!settings.usePerCharacterCollections) {
    return settings.collectionName
  }

  // Sanitize character name for collection name (lowercase, replace spaces/special chars)
  const sanitized = characterName
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")

  return `${settings.collectionName}_${sanitized}`
}

// Get embedding dimensions for the selected model
function getEmbeddingDimensions() {
  const dimensions = {
    "text-embedding-3-large": 3072,
    "text-embedding-3-small": 1536,
    "text-embedding-ada-002": 1536,
    "openai/text-embedding-3-large": 3072,
    "openai/text-embedding-3-small": 1536,
    "openai/text-embedding-ada-002": 1536,
    "qwen/qwen3-embedding-8b": 4096,
    "mistralai/mistral-embed-2312": 1024,
    "google/gemini-embedding-001": 3072,
  }

  const customDimensions = Number.parseInt(settings.customEmbeddingDimensions, 10)
  const isCustomValid = Number.isFinite(customDimensions) && customDimensions > 0

  if (settings.embeddingProvider === "local") {
    if (isCustomValid) {
      return customDimensions
    }
    return null
  }

  if (dimensions[settings.embeddingModel]) {
    return dimensions[settings.embeddingModel]
  }

  if (isCustomValid) {
    return customDimensions
  }

  return 1536
}

function updateLocalEmbeddingDimensions(vector) {
  if (settings.embeddingProvider !== "local") {
    return
  }

  if (!Array.isArray(vector)) {
    return
  }

  const vectorSize = vector.length
  if (!Number.isFinite(vectorSize) || vectorSize <= 0) {
    return
  }

  const currentDimensions = Number.parseInt(settings.customEmbeddingDimensions, 10)
  if (Number.isFinite(currentDimensions) && currentDimensions === vectorSize) {
    return
  }

  settings.customEmbeddingDimensions = vectorSize

  try {
    const $ = window.$
    if ($) {
      const $input = $("#qdrant_local_dimensions")
      if ($input && $input.length) {
        $input.val(vectorSize)
      }
    }
  } catch (error) {
    if (settings.debugMode) {
      console.warn("[Qdrant Memory] Unable to update local dimensions input:", error)
    }
  }

  saveSettings()

  if (settings.debugMode) {
    console.log(`[Qdrant Memory] Auto-detected local embedding dimensions: ${vectorSize}`)
  }
}

function getEmbeddingProviderError() {
  const provider = settings.embeddingProvider || "openai"

  const validProviders = ["openai", "openrouter", "local"]
  if (!validProviders.includes(provider)) {
    return `Unsupported embedding provider: ${provider}`
  }

  if (provider === "openai") {
    if (!settings.openaiApiKey || !settings.openaiApiKey.trim()) {
      return "OpenAI API key not set"
    }
  }

  if (provider === "openrouter") {
    if (!settings.openRouterApiKey || !settings.openRouterApiKey.trim()) {
      return "OpenRouter API key not set"
    }
  }

  if (provider === "local") {
    if (!settings.localEmbeddingUrl || !settings.localEmbeddingUrl.trim()) {
      return "Local embedding URL not set"
    }

    if (settings.customEmbeddingDimensions != null && settings.customEmbeddingDimensions !== "") {
      const customDimensions = Number.parseInt(settings.customEmbeddingDimensions, 10)
      if (!Number.isFinite(customDimensions) || customDimensions <= 0) {
        return "Embedding dimensions must be a positive number"
      }
    }
  }

  if (!provider) {
    return "Embedding provider not configured"
  }

  return null
}

// ============================================================================
// HTTP HEADERS AND CSRF TOKEN HANDLING
// ============================================================================

// Helper to safely call potential CSRF token providers
function tryGetCSRFTokenFromHelpers() {
  const helperCandidates = [
    () => (typeof window.getCSRFToken === "function" ? window.getCSRFToken() : null),
    () => (typeof window.getCsrfToken === "function" ? window.getCsrfToken() : null),
    () =>
      typeof window.SillyTavern?.getCSRFToken === "function"
        ? window.SillyTavern.getCSRFToken()
        : null,
    () =>
      typeof window.SillyTavern?.getCsrfToken === "function"
        ? window.SillyTavern.getCsrfToken()
        : null,
    () =>
      typeof window.SillyTavern?.extensions?.webui?.getCSRFToken === "function"
        ? window.SillyTavern.extensions.webui.getCSRFToken()
        : null,
    () =>
      typeof window.SillyTavern?.extensions?.webui?.getCsrfToken === "function"
        ? window.SillyTavern.extensions.webui.getCsrfToken()
        : null,
  ]

  for (const helper of helperCandidates) {
    try {
      const token = helper()
      if (typeof token === "string" && token.trim().length > 0) {
        return token.trim()
      }
    } catch (error) {
      console.warn("[Qdrant Memory] Failed to read CSRF token from helper:", error)
    }
  }

  return null
}

// Helper to read a cookie value by name
function getCookie(name) {
  const cookies = document.cookie ? document.cookie.split(";") : []

  for (const cookie of cookies) {
    const [cookieName, ...rest] = cookie.trim().split("=")
    if (cookieName === name) {
      return decodeURIComponent(rest.join("="))
    }
  }

  return null
}

function pickFirstCSRFToken() {
  const tokenCandidates = [
    document.querySelector('meta[name="csrf-token"]')?.content,
    document.querySelector('meta[name="csrfToken"]')?.content,
    window.CSRF_TOKEN,
    window.CSRFToken,
    window.csrfToken,
    window.csrf_token,
    tryGetCSRFTokenFromHelpers(),
    getCookie("csrftoken"),
    getCookie("csrf_token"),
    getCookie("XSRF-TOKEN"),
    getCookie("XSRF_TOKEN"),
  ]

  for (const token of tokenCandidates) {
    if (typeof token === "string" && token.trim().length > 0) {
      return token.trim()
    }
  }

  return null
}

function getHeadersFromSillyTavernContext() {
  try {
    const context = window.SillyTavern?.getContext?.()
    const getRequestHeaders = context?.getRequestHeaders

    if (typeof getRequestHeaders === "function") {
      const headers = getRequestHeaders.call(context)

      if (headers && typeof headers === "object") {
        return headers
      }
    }
  } catch (error) {
    console.warn("[Qdrant Memory] Failed to read headers from SillyTavern context:", error)
  }

  return null
}

// Get headers for SillyTavern API requests (with CSRF token if available)
function getSillyTavernHeaders() {
  if (settings.debugMode) {
    console.log("[Qdrant Memory] === Checking available ST methods ===")
    console.log("[Qdrant Memory] window.SillyTavern exists?", typeof SillyTavern !== "undefined")
    if (typeof SillyTavern !== "undefined") {
      console.log("[Qdrant Memory] SillyTavern keys:", Object.keys(SillyTavern))
      console.log("[Qdrant Memory] SillyTavern.getContext exists?", typeof SillyTavern.getContext === "function")
      if (typeof SillyTavern.getContext === "function") {
        const ctx = SillyTavern.getContext()
        console.log("[Qdrant Memory] Context keys:", Object.keys(ctx))
        console.log("[Qdrant Memory] getRequestHeaders exists?", typeof ctx.getRequestHeaders === "function")
      }
    }
  }

  // Try multiple possible locations for the header builder
  const headerBuilders = [
    () => SillyTavern?.getContext?.()?.getRequestHeaders?.(),
    () => SillyTavern?.getRequestHeaders?.(),
    () => window.getRequestHeaders?.(),
    () => getContext()?.getRequestHeaders?.(),
  ]

  for (const builder of headerBuilders) {
    try {
      const headers = builder()
      if (headers && typeof headers === "object") {
        if (settings.debugMode) {
          console.log("[Qdrant Memory] ✓ Found working header builder!")
          console.log("[Qdrant Memory] Headers:", headers)
        }
        return headers
      }
    } catch (error) {
      // Continue to next method
    }
  }
  
  // None of the built-in methods worked
  if (settings.debugMode) {
    console.warn("[Qdrant Memory] No built-in header builder found, using manual fallback")
  }
  
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    Origin: window.location.origin,
    "X-Requested-With": "XMLHttpRequest",
  }

  const csrfToken = pickFirstCSRFToken()

  if (csrfToken) {
    if (settings.debugMode) {
      console.log("[Qdrant Memory] Using manual CSRF token:", csrfToken.substring(0, 10) + "...")
    }
    headers["X-CSRF-Token"] = csrfToken
    headers["X-CSRFToken"] = csrfToken
    headers["csrf-token"] = csrfToken
  } else {
    console.warn("[Qdrant Memory] No CSRF token found - requests may fail")
  }

  return headers
}

// Get headers for Qdrant requests (with optional API key)
function getQdrantHeaders() {
  const headers = {
    "Content-Type": "application/json",
  }
  
  if (settings.qdrantApiKey) {
    headers["api-key"] = settings.qdrantApiKey
  }
  
  return headers
}

// ============================================================================
// QDRANT COLLECTION MANAGEMENT
// ============================================================================

// Check if collection exists
async function collectionExists(collectionName) {
  try {
    const response = await fetch(`${settings.qdrantUrl}/collections/${collectionName}`, {
      headers: getQdrantHeaders(),
    })

    if (response.status === 404) {
      return { exists: false, vectorSize: null }
    }

    if (!response.ok) {
      console.error(
        `[Qdrant Memory] Failed to fetch collection info: ${collectionName} (${response.status} ${response.statusText})`,
      )
      return { exists: false, vectorSize: null }
    }

    const data = await response.json().catch(() => null)
    const vectorSize =
      data?.result?.config?.params?.vectors?.size ??
      data?.result?.config?.params?.vectors?.default?.size ??
      data?.result?.vectors?.size ??
      null

    return { exists: true, vectorSize }
  } catch (error) {
    console.error("[Qdrant Memory] Error checking collection:", error)
    return { exists: false, vectorSize: null }
  }
}

// Create collection for a character
async function createCollection(collectionName, vectorSize) {
  try {
    const dimensions = Number.isFinite(vectorSize) && vectorSize > 0 ? vectorSize : getEmbeddingDimensions()

    if (!Number.isFinite(dimensions) || dimensions <= 0) {
      console.error(`[Qdrant Memory] Cannot create collection ${collectionName} - invalid embedding dimensions`)
      return false
    }

    const response = await fetch(`${settings.qdrantUrl}/collections/${collectionName}`, {
      method: "PUT",
      headers: getQdrantHeaders(),
      body: JSON.stringify({
        vectors: {
          size: dimensions,
          distance: "Cosine",
        },
      }),
    })

    if (response.ok) {
      if (settings.debugMode) {
        console.log(`[Qdrant Memory] Created collection: ${collectionName}`)
      }
      return true
    } else {
      console.error(`[Qdrant Memory] Failed to create collection: ${collectionName}`)
      return false
    }
  } catch (error) {
    console.error("[Qdrant Memory] Error creating collection:", error)
    return false
  }
}

// Ensure collection exists (create if needed)
async function ensureCollection(characterName, vectorSize) {
  const collectionName = getCollectionName(characterName)
  const { exists, vectorSize: existingSize } = await collectionExists(collectionName)

  if (exists) {
    if (
      Number.isFinite(existingSize) &&
      Number.isFinite(vectorSize) &&
      existingSize > 0 &&
      vectorSize > 0 &&
      existingSize !== vectorSize
    ) {
      console.error(
        `[Qdrant Memory] Collection ${collectionName} has dimension ${existingSize}, but embedding returned ${vectorSize}. Please recreate the collection to match the model.`,
      )
      return false
    }

    return true
  }

  if (settings.debugMode) {
    console.log(`[Qdrant Memory] Collection doesn't exist, creating: ${collectionName}`)
  }

  return await createCollection(collectionName, vectorSize)
}

// ============================================================================
// EMBEDDING GENERATION
// ============================================================================

// Generate embedding using the configured provider
async function generateEmbedding(text) {
  const providerError = getEmbeddingProviderError()
  if (providerError) {
    console.error(`[Qdrant Memory] ${providerError}`)
    return null
  }

  try {
    const provider = settings.embeddingProvider || "openai"
    let url = "https://api.openai.com/v1/embeddings"
    const headers = {
      "Content-Type": "application/json",
    }
    const body = {
      model: settings.embeddingModel,
      input: text,
    }

    if (provider === "openai") {
      headers.Authorization = `Bearer ${settings.openaiApiKey}`
    } else if (provider === "openrouter") {
      url = "https://openrouter.ai/api/v1/embeddings"
      headers.Authorization = `Bearer ${settings.openRouterApiKey}`
      if (window?.location?.origin) {
        headers["HTTP-Referer"] = window.location.origin
      }
      if (document?.title) {
        headers["X-Title"] = document.title
      }
    } else if (provider === "local") {
      url = settings.localEmbeddingUrl.trim()
      if (settings.localEmbeddingApiKey && settings.localEmbeddingApiKey.trim()) {
        headers.Authorization = `Bearer ${settings.localEmbeddingApiKey.trim()}`
      }
    } else {
      console.error(`[Qdrant Memory] Unsupported embedding provider: ${provider}`)
      return null
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}))
      console.error(
        `[Qdrant Memory] ${provider} embedding API error:`,
        response.statusText,
        errorData
      )
      return null
    }

    const data = await response.json()
    let embeddingVector = null

    if (Array.isArray(data?.data) && Array.isArray(data.data[0]?.embedding)) {
      embeddingVector = data.data[0].embedding
    } else if (Array.isArray(data?.data) && Array.isArray(data.data[0]?.vector)) {
      embeddingVector = data.data[0].vector
    } else if (Array.isArray(data?.embedding)) {
      embeddingVector = data.embedding
    } else if (Array.isArray(data?.embeddings)) {
      embeddingVector = data.embeddings[0]
    }

    if (!Array.isArray(embeddingVector)) {
      console.error("[Qdrant Memory] Unable to parse embedding response", data)
      return null
    }

    updateLocalEmbeddingDimensions(embeddingVector)

    return embeddingVector
  } catch (error) {
    console.error("[Qdrant Memory] Error generating embedding:", error)
    return null
  }
}

// ============================================================================
// MEMORY SEARCH AND RETRIEVAL
// ============================================================================

// NEW: Check if chunk already exists (deduplication)
async function chunkExistsInCollection(collectionName, embedding, text, dedupeThreshold) {
  try {
    const searchPayload = {
      vector: embedding,
      limit: 1,
      score_threshold: dedupeThreshold,
      with_payload: true,
    }

    const response = await fetch(`${settings.qdrantUrl}/collections/${collectionName}/points/search`, {
      method: "POST",
      headers: getQdrantHeaders(),
      body: JSON.stringify(searchPayload),
    })

    if (!response.ok) {
      return false
    }

    const data = await response.json()
    const results = data.result || []

    if (results.length > 0) {
      if (settings.debugMode) {
        console.log(`[Qdrant Memory] Found similar chunk with score: ${results[0].score.toFixed(4)}`)
        console.log(`[Qdrant Memory] Existing: "${results[0].payload?.text?.substring(0, 80)}..."`)
        console.log(`[Qdrant Memory] New: "${text.substring(0, 80)}..."`)
      }
      return true
    }

    return false
  } catch (error) {
    console.warn('[Qdrant Memory] Deduplication check failed:', error)
    return false
  }
}

// Search Qdrant for relevant memories
async function searchMemories(query, characterName) {
  if (!settings.enabled) return []

  try {
    const collectionName = getCollectionName(characterName)

    const embedding = await generateEmbedding(query)
    if (!embedding) return []

    const collectionReady = await ensureCollection(characterName, embedding.length)
    if (!collectionReady) {
      if (settings.debugMode) {
        console.log(`[Qdrant Memory] Collection not ready: ${collectionName}`)
      }
      return []
    }

    // FIXED: Improved retain logic - get ALL message IDs that should be excluded
    const context = getContext()
    const chat = context.chat || []
    const excludedMessageIds = new Set()

    if (settings.retainRecentMessages > 0 && chat.length > settings.retainRecentMessages) {
      // Get the last N messages
      const recentMessages = chat.slice(-settings.retainRecentMessages)
      
      recentMessages.forEach(msg => {
        // Create all possible message ID formats this message might have been saved as
        const normalizedDate = normalizeTimestamp(msg.send_date || Date.now())
        const msgIndex = chat.indexOf(msg)
        
        // Add multiple ID formats to catch all variations
        excludedMessageIds.add(`${characterName}_${normalizedDate}_${msgIndex}`)
        excludedMessageIds.add(`${characterName}_${msg.send_date}_${msgIndex}`)
        
        if (settings.debugMode && excludedMessageIds.size <= 5) {
          console.log(`[Qdrant Memory] Excluding message ID: ${characterName}_${normalizedDate}_${msgIndex}`)
        }
      })

      if (settings.debugMode) {
        console.log(`[Qdrant Memory] Excluding ${excludedMessageIds.size} recent message IDs from search`)
      }
    }

    const searchPayload = {
      vector: embedding,
      limit: settings.memoryLimit * 2, // Get more results for filtering
      score_threshold: settings.scoreThreshold,
      with_payload: true,
    }

    const filterConditions = []

    // Add character filter if using shared collection
    if (!settings.usePerCharacterCollections) {
      filterConditions.push({
        key: "character",
        match: { value: characterName },
      })
    }

    // Only add filter if we have conditions
    if (filterConditions.length > 0) {
      searchPayload.filter = {
        must: filterConditions,
      }
    }

    const response = await fetch(`${settings.qdrantUrl}/collections/${collectionName}/points/search`, {
      method: "POST",
      headers: getQdrantHeaders(),
      body: JSON.stringify(searchPayload),
    })

    if (!response.ok) {
      console.error("[Qdrant Memory] Search failed:", response.statusText)
      return []
    }

    const data = await response.json()
    let results = data.result || []

    // FIXED: Filter out chunks that contain any excluded message IDs
    if (excludedMessageIds.size > 0) {
      const beforeFilterCount = results.length
      
      results = results.filter(memory => {
        const messageIds = memory.payload.messageIds || ""
        const chunkMessageIds = messageIds.split(",")
        
        // Check if any of the chunk's message IDs are in the excluded set
        const hasExcludedMessage = chunkMessageIds.some(id => excludedMessageIds.has(id.trim()))
        
        if (hasExcludedMessage && settings.debugMode) {
          console.log(`[Qdrant Memory] Filtered out chunk containing recent message: ${messageIds}`)
        }
        
        return !hasExcludedMessage
      })

      if (settings.debugMode) {
        console.log(`[Qdrant Memory] Filtered ${beforeFilterCount - results.length} chunks with recent messages`)
      }
    }

    // Deduplicate results based on text similarity
const uniqueResults = []
const seenTexts = new Set()

for (const result of results) {
  const text = result.payload?.text || ""
  
  // Create a normalized version for comparison (remove dates, extra whitespace)
  const normalizedText = text
    .replace(/\[[\d-]+\]/g, '') // Remove date markers
    .replace(/\s+/g, ' ')        // Normalize whitespace
    .trim()
    .substring(0, 200)           // Compare first 200 chars
  
  // Only add if we haven't seen very similar text
  if (!seenTexts.has(normalizedText)) {
    seenTexts.add(normalizedText)
    uniqueResults.push(result)
  } else if (settings.debugMode) {
    console.log(`[Qdrant Memory] Filtered duplicate search result: "${normalizedText.substring(0, 50)}..."`)  // ← FIXED: use () not backticks
  }
  
  // Stop if we have enough unique results
  if (uniqueResults.length >= settings.memoryLimit) {
    break
  }
}

results = uniqueResults

if (settings.debugMode) {
  console.log(`[Qdrant Memory] Found ${results.length} unique memories (after deduplication)`)  // ← FIXED: use () not backticks
}

    return results
  } catch (error) {
    console.error("[Qdrant Memory] Error searching memories:", error)
    return []
  }
}

// Format memories for display
function formatMemories(memories) {
  if (!memories || memories.length === 0) return ""

  let formatted = "\n[Past chat memories]\n\n"
  
  // Get persona name for display
  const personaName = getPersonaName()

  memories.forEach((memory) => {
    const payload = memory.payload

    let speakerLabel
    if (payload.isChunk) {
      // For conversation chunks, show all speakers
      speakerLabel = `Conversation (${payload.speakers})`
    } else {
      // For individual messages (legacy format), use persona name
      speakerLabel = payload.speaker === "user" 
        ? `${personaName} said`   // ← CHANGED: Use personaName instead of "User"
        : "Character said"
    }

    let text = payload.text.replace(/\n/g, " ") // flatten newlines

    const score = (memory.score * 100).toFixed(0)

    formatted += `• ${speakerLabel}: "${text}" (score: ${score}%)\n\n`
  })

  return formatted
}

// ============================================================================
// MESSAGE CHUNKING AND BUFFERING
// ============================================================================

function getChatParticipants() {
  const context = getContext()
  const characterName = context.name2

  // Check if this is a group chat
  const characters = context.characters || []
  const chat = context.chat || []

  // For group chats, get all unique character names from recent messages
  if (characters.length > 1) {
    const participants = new Set()

    // Add the main character
    if (characterName) {
      participants.add(characterName)
    }

    // Look through recent messages to find all participants
    chat.slice(-50).forEach((msg) => {
      if (!msg.is_user && msg.name && msg.name !== "System") {
        participants.add(msg.name)
      }
    })

    return Array.from(participants)
  }

  // Single character chat
  return characterName ? [characterName] : []
}

function createChunkFromBuffer() {
  if (messageBuffer.length === 0) return null

  let chunkText = ""
  const speakers = new Set()
  const messageIds = []
  let totalLength = 0
  const currentTimestamp = Date.now()
  
  // NEW: Get the persona name once for this chunk
  const personaName = getPersonaName()

  // Build chunk text with speaker labels
  messageBuffer.forEach((msg) => {
    const speaker = msg.isUser ? personaName : msg.characterName  // ← CHANGED: Use personaName
    speakers.add(speaker)
    messageIds.push(msg.messageId)

    const line = `${speaker}: ${msg.text}\n`
    chunkText += line
    totalLength += line.length
  })

  // Format date prefix
  let finalText = chunkText.trim()
  const dateStr = formatDateForChunk(currentTimestamp)
  finalText = `[${dateStr}]\n${finalText}`

  return {
    text: finalText,
    speakers: Array.from(speakers),
    messageIds: messageIds,
    messageCount: messageBuffer.length,
    timestamp: currentTimestamp,
  }
}

async function saveChunkToQdrant(chunk, participants) {
  if (!settings.enabled) return false
  if (!chunk || !participants || participants.length === 0) return false

  try {
    // Generate embedding for the chunk text
    const embedding = await generateEmbedding(chunk.text)
    if (!embedding) {
      console.error("[Qdrant Memory] Cannot save chunk - embedding generation failed")
      return false
    }

    // NEW: Check for duplicates before saving
    let alreadyExists = false
    
    for (const characterName of participants) {
      const collectionName = getCollectionName(characterName)
      const collectionReady = await ensureCollection(characterName, embedding.length)
      
      if (!collectionReady) {
        console.error(`[Qdrant Memory] Cannot check duplicates - collection creation failed for ${characterName}`)
        continue
      }

      const exists = await chunkExistsInCollection(
        collectionName, 
        embedding, 
        chunk.text, 
        settings.dedupeThreshold
      )
      
      if (exists) {
        alreadyExists = true
        if (settings.debugMode) {
          console.log(`[Qdrant Memory] Duplicate chunk detected in ${characterName}'s collection, skipping save`)
        }
        break
      }
    }

    if (alreadyExists) {
      if (settings.showMemoryNotifications) {
        const toastr = window.toastr
        toastr.info("Similar conversation already saved", "Qdrant Memory", { timeOut: 1500 })
      }
      return false
    }

    const pointId = generateUUID()

    // Prepare payload
    const payload = {
      text: chunk.text,
      speakers: chunk.speakers.join(", "),
      messageCount: chunk.messageCount,
      timestamp: chunk.timestamp,
      messageIds: chunk.messageIds.join(","),
      isChunk: true,
    }

    // Save to all participant collections
    const savePromises = participants.map(async (characterName) => {
      const collectionName = getCollectionName(characterName)

      // Ensure collection exists
      const collectionReady = await ensureCollection(characterName, embedding.length)
      if (!collectionReady) {
        console.error(`[Qdrant Memory] Cannot save chunk - collection creation failed for ${characterName}`)
        return false
      }

      // Add character name to payload only if using shared collection
      const characterPayload = settings.usePerCharacterCollections 
        ? payload 
        : { ...payload, character: characterName }

      // Save to Qdrant
      const response = await fetch(`${settings.qdrantUrl}/collections/${collectionName}/points`, {
        method: "PUT",
        headers: getQdrantHeaders(),
        body: JSON.stringify({
          points: [
            {
              id: pointId,
              vector: embedding,
              payload: characterPayload,
            },
          ],
        }),
      })

      if (!response.ok) {
        console.error(
          `[Qdrant Memory] Failed to save chunk to ${characterName}: ${response.status} ${response.statusText}`,
        )
        return false
      }

      if (settings.debugMode) {
        console.log(
          `[Qdrant Memory] Saved chunk to ${characterName}'s collection (${chunk.messageCount} messages, ${chunk.text.length} chars)`,
        )
      }

      return true
    })

    const results = await Promise.all(savePromises)
    const successCount = results.filter((r) => r).length

    if (settings.debugMode) {
      console.log(`[Qdrant Memory] Chunk saved to ${successCount}/${participants.length} collections`)
    }

    return successCount > 0
  } catch (err) {
    console.error("[Qdrant Memory] Error saving chunk:", err)
    return false
  }
}

async function processMessageBuffer() {
  if (!settings.enabled) return
  if (messageBuffer.length === 0) return

  const chunk = createChunkFromBuffer()
  if (!chunk) return

  // Get all participants (for group chats)
  const participants = getChatParticipants()

  if (participants.length === 0) {
    console.error("[Qdrant Memory] No participants found for chunk")
    messageBuffer = []
    return
  }

  // Save chunk to all participant collections
  await saveChunkToQdrant(chunk, participants)

  // Clear buffer after saving
  messageBuffer = []
}

function bufferMessage(text, characterName, isUser, messageId) {
  if (!settings.enabled) return
  if (!settings.autoSaveMemories) return
  if (getEmbeddingProviderError()) return
  if (text.length < settings.minMessageLength) return

  // Check if we should save this type of message
  if (isUser && !settings.saveUserMessages) return
  if (!isUser && !settings.saveCharacterMessages) return

  // Add to buffer
  messageBuffer.push({ text, characterName, isUser, messageId })
  lastMessageTime = Date.now()

  // Calculate current buffer size
  let bufferSize = 0
  messageBuffer.forEach((msg) => {
    bufferSize += msg.text.length + msg.characterName.length + 4 // +4 for ": " and "\n"
  })

  if (settings.debugMode) {
    console.log(`[Qdrant Memory] Buffer: ${messageBuffer.length} messages, ${bufferSize} chars`)
  }

  // Clear existing timer
  if (chunkTimer) {
    clearTimeout(chunkTimer)
  }

  // If buffer exceeds max size, process it now
  if (bufferSize >= settings.chunkMaxSize) {
    if (settings.debugMode) {
      console.log(`[Qdrant Memory] Buffer reached max size (${bufferSize}), processing chunk`)
    }
    processMessageBuffer()
  }
  // If buffer is at least min size, set a short timer
  else if (bufferSize >= settings.chunkMinSize) {
    chunkTimer = setTimeout(() => {
      if (settings.debugMode) {
        console.log(`[Qdrant Memory] Buffer reached min size and timeout, processing chunk`)
      }
      processMessageBuffer()
    }, 5000) // 5 seconds after reaching min size
  }
  // Otherwise, set a longer timer
  else {
    chunkTimer = setTimeout(() => {
      if (settings.debugMode) {
        console.log(`[Qdrant Memory] Buffer timeout reached, processing chunk`)
      }
      processMessageBuffer()
    }, settings.chunkTimeout)
  }
}

// ============================================================================
// CHAT INDEXING FUNCTIONS
// ============================================================================

async function getCharacterChats(characterName) {
  try {
    const context = getContext()

    if (settings.debugMode) {
      console.log("[Qdrant Memory] Getting chats for character:", characterName)
    }

    // Try to get the character's avatar URL
    let avatar_url = `${characterName}.png`
    if (context.characters && Array.isArray(context.characters)) {
      const char = context.characters.find((c) => c.name === characterName)
      if (char && char.avatar) {
        avatar_url = char.avatar
      }
    }

    const response = await fetch("/api/characters/chats", {
      method: "POST",
      headers: getSillyTavernHeaders(),
      credentials: "include",
      body: JSON.stringify({
        avatar_url: avatar_url,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error("[Qdrant Memory] Failed to get chat list:", response.status, response.statusText)
      console.error("[Qdrant Memory] Error response:", errorText)
      return []
    }

    const data = await response.json()

    // Handle different response formats - extract just the filenames
    let chatFiles = []
    
    if (Array.isArray(data)) {
      if (typeof data[0] === 'string') {
        chatFiles = data
      } else if (data[0] && data[0].file_name) {
        chatFiles = data.map(item => item.file_name)
      } else {
        chatFiles = data.map(item => {
          if (typeof item === 'string') return item
          if (item.file_name) return item.file_name
          if (item.filename) return item.filename
          return null
        }).filter(f => f !== null)
      }
    } else if (data && Array.isArray(data.files)) {
      chatFiles = data.files.map(item => {
        if (typeof item === 'string') return item
        if (item.file_name) return item.file_name
        if (item.filename) return item.filename
        return null
      }).filter(f => f !== null)
    } else if (data && Array.isArray(data.chats)) {
      chatFiles = data.chats.map(item => {
        if (typeof item === 'string') return item
        if (item.file_name) return item.file_name
        if (item.filename) return item.filename
        return null
      }).filter(f => f !== null)
    }

    if (settings.debugMode) {
      console.log("[Qdrant Memory] Extracted filenames:", chatFiles)
    }

    return chatFiles
  } catch (error) {
    console.error("[Qdrant Memory] Error getting character chats:", error)
    return []
  }
}

async function loadChatFile(characterName, chatFile) {
  try {
    if (settings.debugMode) {
      console.log("[Qdrant Memory] Loading chat file:", chatFile, "for character:", characterName)
    }

    // Ensure chatFile is a string
    if (typeof chatFile !== 'string') {
      console.error("[Qdrant Memory] chatFile is not a string:", chatFile)
      if (chatFile && chatFile.file_name) {
        chatFile = chatFile.file_name
      } else {
        return null
      }
    }

    // Remove .jsonl extension as the API adds it back
    const fileNameWithoutExt = chatFile.replace(/\.jsonl$/, '')

    const context = getContext()

    

    // Try to get the character's avatar URL
    let avatar_url = `${characterName}.png`
    if (context.characters && Array.isArray(context.characters)) {
      const char = context.characters.find((c) => c.name === characterName)
      if (char && char.avatar) {
        avatar_url = char.avatar
      }
    }

    const response = await fetch("/api/chats/get", {
      method: "POST",
      headers: getSillyTavernHeaders(),
      credentials: "include",
      body: JSON.stringify({
        ch_name: characterName,
        file_name: fileNameWithoutExt,
        avatar_url: avatar_url,
      }),
    })

    if (!response.ok) {
      const errorText = await response.text()
      console.error("[Qdrant Memory] Failed to load chat file:", response.status, response.statusText)
      console.error("[Qdrant Memory] Error response:", errorText)
      return null
    }

    const chatData = await response.json()
    
    // Handle different response formats
    let messages = null
    if (Array.isArray(chatData)) {
      messages = chatData
    } else if (chatData && Array.isArray(chatData.chat)) {
      messages = chatData.chat
    } else if (chatData && Array.isArray(chatData.messages)) {
      messages = chatData.messages
    } else if (chatData && typeof chatData === 'object') {
      messages = [chatData]
    }
    
    if (settings.debugMode) {
      console.log("[Qdrant Memory] Loaded chat with", messages?.length || 0, "messages")
    }
    
    return messages
  } catch (error) {
    console.error("[Qdrant Memory] Error loading chat file:", error)
    return null
  }
}

async function chunkExists(collectionName, messageIds) {
  try {
    // Search for any of the message IDs in the chunk
    const response = await fetch(`${settings.qdrantUrl}/collections/${collectionName}/points/scroll`, {
      method: "POST",
      headers: getQdrantHeaders(),
      body: JSON.stringify({
        filter: {
          should: messageIds.map((id) => ({
            key: "messageIds",
            match: { text: id },
          })),
        },
        limit: 1,
        with_payload: false,
      }),
    })

    if (!response.ok) return false

    const data = await response.json()
    return data.result?.points?.length > 0
  } catch (error) {
    console.error("[Qdrant Memory] Error checking chunk existence:", error)
    return false
  }
}

function createChunksFromChat(messages, characterName) {
  const chunks = []
  let currentChunk = []
  let currentSize = 0

  for (const msg of messages) {
    // Skip system messages
    if (msg.is_system) continue

    const text = msg.mes?.trim()
    if (!text || text.length < settings.minMessageLength) continue

    // Check if we should save this type of message
    const isUser = msg.is_user || false
    if (isUser && !settings.saveUserMessages) continue
    if (!isUser && !settings.saveCharacterMessages) continue

    // Normalize send_date before using it
    const normalizedDate = normalizeTimestamp(msg.send_date || Date.now())
    
    if (settings.debugMode) {
      console.log("[Qdrant Memory] Message date - raw:", msg.send_date, "normalized:", normalizedDate, "formatted:", formatDateForChunk(normalizedDate))
    }

    // Create message object
    const messageObj = {
      text: text,
      characterName: characterName,
      isUser: isUser,
      messageId: `${characterName}_${normalizedDate}_${messages.indexOf(msg)}`,
      timestamp: normalizedDate,
    }

    const messageSize = text.length + characterName.length + 4

    // If adding this message would exceed max size, save current chunk
    if (currentSize + messageSize > settings.chunkMaxSize && currentChunk.length > 0) {
      chunks.push(createChunkFromMessages(currentChunk))
      currentChunk = []
      currentSize = 0
    }

    currentChunk.push(messageObj)
    currentSize += messageSize

    // If we've reached min size and have a good number of messages, consider chunking
    if (currentSize >= settings.chunkMinSize && currentChunk.length >= 3) {
      chunks.push(createChunkFromMessages(currentChunk))
      currentChunk = []
      currentSize = 0
    }
  }

  // Save any remaining messages
  if (currentChunk.length > 0) {
    chunks.push(createChunkFromMessages(currentChunk))
  }

  return chunks
}

function createChunkFromMessages(messages) {
  let chunkText = ""
  const speakers = new Set()
  const messageIds = []
  let oldestTimestamp = Number.POSITIVE_INFINITY
  
  // NEW: Get the persona name once for all messages
  const personaName = getPersonaName()

  messages.forEach((msg) => {
    const speaker = msg.isUser ? personaName : msg.characterName  // ← CHANGED: Use personaName
    speakers.add(speaker)
    messageIds.push(msg.messageId)

    const line = `${speaker}: ${msg.text}\n`
    chunkText += line

    if (msg.timestamp < oldestTimestamp) {
      oldestTimestamp = msg.timestamp
    }
  })

  // Format date prefix for the chunk
  let finalText = chunkText.trim()
  if (oldestTimestamp !== Number.POSITIVE_INFINITY) {
    const dateStr = formatDateForChunk(oldestTimestamp)
    finalText = `[${dateStr}]\n${finalText}`
  }

  return {
    text: finalText,
    speakers: Array.from(speakers),
    messageIds: messageIds,
    messageCount: messages.length,
    timestamp: oldestTimestamp !== Number.POSITIVE_INFINITY ? oldestTimestamp : Date.now(),
  }
}

async function indexCharacterChats() {
  const context = getContext()
  const characterName = context.name2
  const toastr = window.toastr
  const $ = window.$

  if (!characterName) {
    toastr.warning("No character selected", "Qdrant Memory")
    return
  }

  const providerError = getEmbeddingProviderError()
  if (providerError) {
    toastr.error(providerError, "Qdrant Memory")
    return
  }

  // Create progress modal
  const modalHtml = `
    <div id="qdrant_index_modal" style="
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: white;
      padding: 30px;
      border-radius: 10px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      z-index: 10000;
      max-width: 500px;
      width: 90%;
    ">
      <div style="color: #333;">
        <h3 style="margin-top: 0;">Indexing Chats - ${characterName}</h3>
        <p id="qdrant_index_status">Scanning for chat files...</p>
        <div style="background: #f0f0f0; border-radius: 5px; height: 20px; margin: 15px 0; overflow: hidden;">
          <div id="qdrant_index_progress" style="background: #4CAF50; height: 100%; width: 0%; transition: width 0.3s;"></div>
        </div>
        <p id="qdrant_index_details" style="font-size: 0.9em; color: #666;"></p>
        <button id="qdrant_index_cancel" class="menu_button" style="margin-top: 15px;">Cancel</button>
      </div>
    </div>
    <div id="qdrant_index_overlay" style="
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.5);
      z-index: 9999;
    "></div>
  `

  $("body").append(modalHtml)

  const closeModal = () => {
    $("#qdrant_index_modal").remove()
    $("#qdrant_index_overlay").remove()
  }

  const setCancelButtonToClose = () => {
    $("#qdrant_index_cancel")
      .prop("disabled", false)
      .text("Close")
      .off("click")
      .on("click", closeModal)
  }

  let cancelled = false
  $("#qdrant_index_cancel").on("click", () => {
    cancelled = true
    $("#qdrant_index_cancel").text("Cancelling...").prop("disabled", true)
  })

  try {
    // Get all chat files for this character
    const chatFiles = await getCharacterChats(characterName)

    if (chatFiles.length === 0) {
      $("#qdrant_index_status").text("No chat files found")
      setCancelButtonToClose()
      setTimeout(() => {
        closeModal()
      }, 2000)
      return
    }

    $("#qdrant_index_status").text(`Found ${chatFiles.length} chat files`)

    const collectionName = getCollectionName(characterName)

    let totalChunks = 0
    let savedChunks = 0
    let skippedChunks = 0

    // Process each chat file
    for (let i = 0; i < chatFiles.length; i++) {
      if (cancelled) break

      const chatFile = chatFiles[i]
      const progress = ((i / chatFiles.length) * 100).toFixed(0)

      $("#qdrant_index_progress").css("width", `${progress}%`)
      $("#qdrant_index_status").text(`Processing chat ${i + 1}/${chatFiles.length}`)
      $("#qdrant_index_details").text(`File: ${chatFile}`)

      // Load chat file
      const chatData = await loadChatFile(characterName, chatFile)
      if (!chatData || !Array.isArray(chatData)) continue

      // Create chunks from messages
      const chunks = createChunksFromChat(chatData, characterName)
      totalChunks += chunks.length

      // Save each chunk
      for (const chunk of chunks) {
        if (cancelled) break

        // Check if chunk already exists
        const exists = await chunkExists(collectionName, chunk.messageIds)
        if (exists) {
          skippedChunks++
          continue
        }

        // Get participants (for group chats)
        const participants = [characterName]

        // Save chunk
        const success = await saveChunkToQdrant(chunk, participants)
        if (success) {
          savedChunks++
        }

        $("#qdrant_index_details").text(`Saved: ${savedChunks} | Skipped: ${skippedChunks} | Total: ${totalChunks}`)
      }
    }

    // Complete
    $("#qdrant_index_progress").css("width", "100%")

    if (cancelled) {
      $("#qdrant_index_status").text("Indexing cancelled")
      toastr.info(`Indexed ${savedChunks} chunks before cancelling`, "Qdrant Memory")
    } else {
      $("#qdrant_index_status").text("Indexing complete!")
      toastr.success(`Indexed ${savedChunks} new chunks, skipped ${skippedChunks} existing`, "Qdrant Memory")
    }

    setCancelButtonToClose()
  } catch (error) {
    console.error("[Qdrant Memory] Error indexing chats:", error)
    $("#qdrant_index_status").text("Error during indexing")
    $("#qdrant_index_details").text(error.message)
    toastr.error("Failed to index chats", "Qdrant Memory")
    setCancelButtonToClose()
  }
}

// ============================================================================
// GENERATION INTERCEPTOR
// ============================================================================

// FIXED: Prevent duplicate memory injection
globalThis.qdrantMemoryInterceptor = async (chat, contextSize, abort, type) => {
  if (!settings.enabled) {
    if (settings.debugMode) {
      console.log("[Qdrant Memory] Extension disabled, skipping")
    }
    return
  }

  // NEW: Use chat hash instead of WeakMap
  if (settings.preventDuplicateInjection) {
    const chatHash = getChatHash(chat)
    
    if (memoryInjectionTracker.has(chatHash)) {
      if (settings.debugMode) {
        console.log("[Qdrant Memory] Memories already injected for this chat state, skipping")
      }
      return
    }
    
    // Mark this chat state as having memories injected
    memoryInjectionTracker.add(chatHash)
    
    // Clean up old hashes to prevent memory leaks (keep last 50)
    if (memoryInjectionTracker.size > 50) {
      const oldestHash = memoryInjectionTracker.values().next().value
      memoryInjectionTracker.delete(oldestHash)
    }
  }

  try {
    const context = getContext()
    const characterName = context.name2

    // Skip if no character is selected
    if (!characterName) {
      if (settings.debugMode) {
        console.log("[Qdrant Memory] No character selected, skipping")
      }
      return
    }

    // Find the last user message to use as the query
    const lastUserMsg = chat
      .slice()
      .reverse()
      .find((msg) => msg.is_user)
    if (!lastUserMsg || !lastUserMsg.mes) {
      if (settings.debugMode) {
        console.log("[Qdrant Memory] No user message found, skipping")
      }
      return
    }

    const query = lastUserMsg.mes

    if (settings.debugMode) {
      console.log("[Qdrant Memory] Generation interceptor triggered")
      console.log("[Qdrant Memory] Type:", type)
      console.log("[Qdrant Memory] Context size:", contextSize)
      console.log("[Qdrant Memory] Searching for:", query)
      console.log("[Qdrant Memory] Character:", characterName)
    }

    // Search for relevant memories
    const memories = await searchMemories(query, characterName)

    if (memories.length > 0) {
      const memoryText = formatMemories(memories)

      if (settings.debugMode) {
        console.log("[Qdrant Memory] Retrieved memories:", memoryText)
      }

      // Create memory entry
      const memoryEntry = {
        name: "System",
        is_user: false,
        is_system: true,
        mes: memoryText,
        send_date: Date.now(),
      }

      // Insert memories at the specified position from the end
      const insertIndex = Math.max(0, chat.length - settings.memoryPosition)
      chat.splice(insertIndex, 0, memoryEntry)

      if (settings.debugMode) {
        console.log(`[Qdrant Memory] Injected ${memories.length} memories at position ${insertIndex}`)
      }

      const toastr = window.toastr
      if (settings.showMemoryNotifications) {
        toastr.info(`Retrieved ${memories.length} relevant memories`, "Qdrant Memory", { timeOut: 2000 })
      }
    } else {
      if (settings.debugMode) {
        console.log("[Qdrant Memory] No relevant memories found")
      }
    }
  } catch (error) {
    console.error("[Qdrant Memory] Error in generation interceptor:", error)
  }
}

// ============================================================================
// AUTOMATIC MEMORY CREATION
// ============================================================================

function clearPendingAssistantFinalize() {
  if (pendingAssistantFinalize?.pollTimerId) {
    clearInterval(pendingAssistantFinalize.pollTimerId)
  }
  pendingAssistantFinalize = null
}

function scheduleFinalizeLastAssistantMessage(messageId, characterName) {
  const context = getContext()
  const chat = context.chat || []

  if (chat.length === 0) {
    if (settings.debugMode) {
      console.log("[Qdrant Memory] No chat messages to finalize")
    }
    return
  }

  const lastMessage = chat[chat.length - 1]
  
  // Safety check: make sure this is actually a character message
  if (lastMessage.is_user) {
    if (settings.debugMode) {
      console.log("[Qdrant Memory] Last message is user message, skipping finalize")
    }
    return
  }
  
  const initialText = lastMessage?.mes || ""

  clearPendingAssistantFinalize()

  const pollInterval = settings.streamFinalizePollMs || 250
  const stableMs = settings.streamFinalizeStableMs || 1200
  const maxWaitMs = settings.streamFinalizeMaxWaitMs || 300000

  if (settings.debugMode) {
    console.log("[Qdrant Memory] Starting stream finalize poll for character message")
    console.log("[Qdrant Memory] Initial text length:", initialText.length)
  }

  pendingAssistantFinalize = {
    messageId,
    characterName,
    startedAt: Date.now(),
    lastText: initialText,
    lastChangeAt: Date.now(),
    pollTimerId: null,
  }

  const finalizeAssistant = (text, reason) => {
    if (!text || text.trim().length === 0) {
      if (settings.debugMode) {
        console.warn("[Qdrant Memory] Attempted to finalize empty message, skipping")
      }
      clearPendingAssistantFinalize()
      return
    }

    if (settings.debugMode) {
      console.log(`[Qdrant Memory] Finalizing character message (${reason})`)
      console.log(`[Qdrant Memory] Final text length: ${text.length}`)
      console.log(`[Qdrant Memory] Text preview: "${text.substring(0, 100)}..."`)
    }

    // Buffer the complete message
    bufferMessage(text, characterName, false, messageId)

    // Optionally flush the buffer if we have enough messages
    if (settings.flushAfterAssistant && messageBuffer.length >= 2) {
      if (settings.debugMode) {
        console.log("[Qdrant Memory] Flushing buffer after assistant message")
      }
      processMessageBuffer()
    }

    clearPendingAssistantFinalize()
  }

  let pollCount = 0
  
  pendingAssistantFinalize.pollTimerId = setInterval(() => {
    pollCount++
    
    const currentContext = getContext()
    const currentChat = currentContext.chat || []
    
    if (currentChat.length === 0) {
      if (settings.debugMode) {
        console.log("[Qdrant Memory] Chat is empty, cancelling finalize")
      }
      clearPendingAssistantFinalize()
      return
    }
    
    const currentLastMessage = currentChat[currentChat.length - 1] || {}
    const currentText = currentLastMessage.mes || ""
    const now = Date.now()

    // Log every 4 seconds (16 polls at 250ms) in debug mode
    if (settings.debugMode && pollCount % 16 === 0) {
      console.log(`[Qdrant Memory] Stream poll check #${pollCount}: length=${currentText.length}`)
    }

    // Detect if the text has changed
    if (currentText !== pendingAssistantFinalize.lastText) {
      if (settings.debugMode && pollCount % 4 === 0) {
        console.log(`[Qdrant Memory] Text changed: ${pendingAssistantFinalize.lastText.length} → ${currentText.length}`)
      }
      pendingAssistantFinalize.lastText = currentText
      pendingAssistantFinalize.lastChangeAt = now
    }

    const stableDuration = now - pendingAssistantFinalize.lastChangeAt
    const totalDuration = now - pendingAssistantFinalize.startedAt

    // Check if message switched to user (conversation continued)
    if (currentLastMessage.is_user) {
      if (settings.debugMode) {
        console.log("[Qdrant Memory] Detected new user message, finalizing previous assistant message")
      }
      finalizeAssistant(pendingAssistantFinalize.lastText, "new user message detected")
      return
    }

    // Check if text has been stable for the required duration
    if (stableDuration >= stableMs) {
      finalizeAssistant(pendingAssistantFinalize.lastText, `stable for ${stableDuration}ms`)
      return
    }

    // Safety: max wait time exceeded
    if (totalDuration >= maxWaitMs) {
      if (settings.debugMode) {
        console.warn(`[Qdrant Memory] Max wait (${maxWaitMs}ms) reached while finalizing assistant message`)
      }
      finalizeAssistant(pendingAssistantFinalize.lastText, "max wait reached")
    }
  }, pollInterval)
}

function onMessageSent() {
  if (!settings.enabled) return
  if (!settings.autoSaveMemories) return

  try {
    const context = getContext()
    const chat = context.chat || []
    const characterName = context.name2

    if (!characterName || chat.length === 0) {
      if (settings.debugMode) {
        console.log("[Qdrant Memory] No character or empty chat, skipping save")
      }
      return
    }

    // Get the last message
    const lastMessage = chat[chat.length - 1]

    // Normalize send_date for messageId
    const normalizedDate = normalizeTimestamp(lastMessage.send_date || Date.now())
    
    // Create a unique ID for this message
    const messageId = `${characterName}_${normalizedDate}_${chat.length - 1}`

    if (!lastMessage.mes || lastMessage.mes.trim().length === 0) {
      if (settings.debugMode) {
        console.log("[Qdrant Memory] Empty message, skipping")
      }
      return
    }

    const isUser = lastMessage.is_user || false
    
    if (settings.debugMode) {
      console.log(`[Qdrant Memory] onMessageSent - isUser: ${isUser}, length: ${lastMessage.mes.length}`)
    }
    
    if (isUser) {
      // User messages are saved immediately
      if (settings.debugMode) {
        console.log("[Qdrant Memory] Buffering user message immediately")
      }
      bufferMessage(lastMessage.mes, characterName, true, messageId)
    } else {
      // Character messages need to wait for streaming to complete
      if (settings.debugMode) {
        console.log("[Qdrant Memory] Character message detected, scheduling finalize poll")
      }
      scheduleFinalizeLastAssistantMessage(messageId, characterName)
    }
  } catch (error) {
    console.error("[Qdrant Memory] Error in onMessageSent:", error)
  }
}

// ============================================================================
// MEMORY VIEWER FUNCTIONS
// ============================================================================

async function getCollectionInfo(collectionName) {
  try {
    const response = await fetch(`${settings.qdrantUrl}/collections/${collectionName}`, {
      headers: getQdrantHeaders(),
    })
    if (response.ok) {
      const data = await response.json()
      return data.result
    }
    return null
  } catch (error) {
    console.error("[Qdrant Memory] Error getting collection info:", error)
    return null
  }
}

async function deleteCollection(collectionName) {
  try {
    const response = await fetch(`${settings.qdrantUrl}/collections/${collectionName}`, {
      method: "DELETE",
      headers: getQdrantHeaders(),
    })
    return response.ok
  } catch (error) {
    console.error("[Qdrant Memory] Error deleting collection:", error)
    return false
  }
}

async function showMemoryViewer() {
  const context = getContext()
  const characterName = context.name2

  if (!characterName) {
    const toastr = window.toastr
    toastr.warning("No character selected", "Qdrant Memory")
    return
  }

  const collectionName = getCollectionName(characterName)
  const info = await getCollectionInfo(collectionName)

  if (!info) {
    const toastr = window.toastr
    toastr.warning(`No memories found for ${characterName}`, "Qdrant Memory")
    return
  }

  const count = info.points_count || 0

  const modalHtml = `
        <div id="qdrant_modal" style="
            position: fixed;
            top: 50%;
            left: 50%;
            transform: translate(-50%, -50%);
            background: white;
            padding: 30px;
            border-radius: 10px;
            box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            z-index: 10000;
            max-width: 500px;
            width: 90%;
        ">
            <div style="color: #333;">
                <h3 style="margin-top: 0;">Memory Viewer - ${characterName}</h3>
                <p><strong>Collection:</strong> ${collectionName}</p>
                <p><strong>Total Memories:</strong> ${count}</p>
                <div style="margin-top: 20px; display: flex; gap: 10px;">
                    <button id="qdrant_delete_collection_btn" class="menu_button" style="background-color: #dc3545; color: white;">
                        Delete All Memories
                    </button>
                    <button id="qdrant_close_modal" class="menu_button">
                        Close
                    </button>
                </div>
            </div>
        </div>
        <div id="qdrant_overlay" style="
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(0,0,0,0.5);
            z-index: 9999;
        "></div>
    `

  const $ = window.$
  $("body").append(modalHtml)

  $("#qdrant_close_modal, #qdrant_overlay").on("click", () => {
    $("#qdrant_modal").remove()
    $("#qdrant_overlay").remove()
  })

  $("#qdrant_delete_collection_btn").on("click", async function () {
    const confirmed = confirm(
      `Are you sure you want to delete ALL memories for ${characterName}? This cannot be undone!`,
    )
    if (confirmed) {
      $(this).prop("disabled", true).text("Deleting...")
      const success = await deleteCollection(collectionName)
      if (success) {
        const toastr = window.toastr
        toastr.success(`All memories deleted for ${characterName}`, "Qdrant Memory")
        $("#qdrant_modal").remove()
        $("#qdrant_overlay").remove()
      } else {
        const toastr = window.toastr
        toastr.error("Failed to delete memories", "Qdrant Memory")
        $(this).prop("disabled", false).text("Delete All Memories")
      }
    }
  })
}

// ============================================================================
// UTILITY FUNCTIONS
// ============================================================================

function getContext() {
  const SillyTavern = window.SillyTavern
  
  if (typeof SillyTavern !== "undefined" && SillyTavern.getContext) {
    return SillyTavern.getContext()
  }
  return {
    chat: window.chat || [],
    name2: window.name2 || "",
    characters: window.characters || [],
  }
}

function getPersonaName() {
  const context = getContext()
  
  // Try multiple possible locations for persona name in order of preference
  const personaName = 
    context.name1 ||                              // Standard SillyTavern location
    context.persona?.name ||                      // Alternative location
    window.name1 ||                               // Direct window access
    window.SillyTavern?.getContext?.()?.name1 ||  // Through ST API
    "User"                                        // Fallback to generic "User"
  
  if (settings.debugMode && personaName !== "User") {
    console.log(`[Qdrant Memory] Using persona name: ${personaName}`)
  }
  
  return personaName
}

function generateUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    var r = (Math.random() * 16) | 0,
      v = c == "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

async function processSaveQueue() {
  if (processingSaveQueue || saveQueue.length === 0) return
  processingSaveQueue = true
  while (saveQueue.length > 0) {
    saveQueue.shift()
  }
  processingSaveQueue = false
}

// ============================================================================
// SETTINGS UI
// ============================================================================

function createSettingsUI() {
  const settingsHtml = `
        <div class="qdrant-memory-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Qdrant Memory</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <p style="margin: 10px 0; color: #666; font-size: 0.9em;">
                        Automatic memory creation with temporal context
                    </p>
                    
                    <div style="margin: 15px 0;">
                        <label style="display: flex; align-items: center; gap: 10px;">
                            <input type="checkbox" id="qdrant_enabled" ${settings.enabled ? "checked" : ""} />
                            <strong>Enable Qdrant Memory</strong>
                        </label>
                    </div>
            
            <hr style="margin: 15px 0;" />
            
            <h4>Connection Settings</h4>
            
            <div style="margin: 10px 0;">
                <label><strong>Qdrant URL:</strong></label>
                <input type="text" id="qdrant_url" class="text_pole" value="${settings.qdrantUrl}" 
                       style="width: 100%; margin-top: 5px;" 
                       placeholder="http://localhost:6333" />
                <small style="color: #666;">URL of your Qdrant instance</small>
            </div>

             <div style="margin: 10px 0;">
                <label><strong>Qdrant API Key:</strong></label>
                <input type="password" id="qdrant_api_key" class="text_pole" value="${settings.qdrantApiKey || ""}"
                       style="width: 100%; margin-top: 5px;"
                       placeholder="Optional - leave empty if not required" />
                <small style="color: #666;">API key for Qdrant authentication (optional)</small>
            </div>
            
            <div style="margin: 10px 0;">
                <label><strong>Base Collection Name:</strong></label>
                <input type="text" id="qdrant_collection" class="text_pole" value="${settings.collectionName}"
                       style="width: 100%; margin-top: 5px;"
                       placeholder="sillytavern_memories" />
                <small style="color: #666;">Base name for collections (character name will be appended)</small>
            </div>

            <div style="margin: 10px 0;">
                <label><strong>Embedding Provider:</strong></label>
                <select id="qdrant_embedding_provider" class="text_pole" style="width: 100%; margin-top: 5px;">
                    <option value="openai" ${settings.embeddingProvider === "openai" ? "selected" : ""}>OpenAI</option>
                    <option value="openrouter" ${settings.embeddingProvider === "openrouter" ? "selected" : ""}>OpenRouter</option>
                    <option value="local" ${settings.embeddingProvider === "local" ? "selected" : ""}>Local/custom endpoint</option>
                </select>
                <small style="color: #666;">Choose the API used for generating embeddings</small>
            </div>

            <div id="qdrant_openai_key_group" style="margin: 10px 0;">
                <label><strong>OpenAI API Key:</strong></label>
                <input type="password" id="qdrant_openai_key" class="text_pole" value="${settings.openaiApiKey}"
                       placeholder="sk-..." style="width: 100%; margin-top: 5px;" />
                <small style="color: #666;">Required when using OpenAI</small>
            </div>

            <div id="qdrant_openrouter_key_group" style="margin: 10px 0; display: none;">
                <label><strong>OpenRouter API Key:</strong></label>
                <input type="password" id="qdrant_openrouter_key" class="text_pole" value="${settings.openRouterApiKey}"
                       placeholder="or-..." style="width: 100%; margin-top: 5px;" />
                <small style="color: #666;">Required when using OpenRouter</small>
            </div>

            <div id="qdrant_local_url_group" style="margin: 10px 0; display: none;">
                <label><strong>Embedding URL:</strong></label>
                <input type="text" id="qdrant_local_url" class="text_pole" value="${settings.localEmbeddingUrl}"
                       placeholder="http://localhost:11434/api/embeddings"
                       style="width: 100%; margin-top: 5px;" />
                <small style="color: #666;">Endpoint that accepts OpenAI-compatible embedding requests</small>
            </div>

            <div id="qdrant_local_api_key_group" style="margin: 10px 0; display: none;">
                <label><strong>Embedding API Key (optional):</strong></label>
                <input type="password" id="qdrant_local_api_key" class="text_pole" value="${settings.localEmbeddingApiKey}"
                       placeholder="Bearer token for local endpoint"
                       style="width: 100%; margin-top: 5px;" />
                <small style="color: #666;">Used if your local/custom endpoint requires authentication</small>
            </div>

            <div id="qdrant_local_dimensions_group" style="margin: 10px 0; display: none;">
                <label><strong>Embedding dimensions:</strong></label>
                <input type="number" id="qdrant_local_dimensions" class="text_pole"
                       value="${settings.customEmbeddingDimensions ?? ""}"
                       min="1" step="1" style="width: 100%; margin-top: 5px;" placeholder="Auto-detect after first call" />
                <small style="color: #666;">Vector size returned by your custom embedding model (leave blank to auto-detect)</small>
            </div>

            <div id="qdrant_embedding_model_group" style="margin: 10px 0;">
                <label><strong>Embedding Model:</strong></label>
                <select id="qdrant_embedding_model" class="text_pole" style="width: 100%; margin-top: 5px;">
                    <option value="text-embedding-3-large" ${settings.embeddingModel === "text-embedding-3-large" ? "selected" : ""}>text-embedding-3-large (best quality)</option>
                    <option value="text-embedding-3-small" ${settings.embeddingModel === "text-embedding-3-small" ? "selected" : ""}>text-embedding-3-small (faster)</option>
                    <option value="text-embedding-ada-002" ${settings.embeddingModel === "text-embedding-ada-002" ? "selected" : ""}>text-embedding-ada-002 (legacy)</option>
                </select>
            </div>
            
            <hr style="margin: 15px 0;" />
            
            <h4>Memory Retrieval Settings</h4>
            
            <div style="margin: 10px 0;">
                <label><strong>Number of Memories:</strong> <span id="memory_limit_display">${settings.memoryLimit}</span></label>
                <input type="range" id="qdrant_memory_limit" min="1" max="50" value="${settings.memoryLimit}" 
                       style="width: 100%; margin-top: 5px;" />
                <small style="color: #666;">Maximum memories to retrieve per generation</small>
            </div>
            
            <div style="margin: 10px 0;">
                <label><strong>Relevance Threshold:</strong> <span id="score_threshold_display">${settings.scoreThreshold}</span></label>
                <input type="range" id="qdrant_score_threshold" min="0" max="1" step="0.05" value="${settings.scoreThreshold}" 
                       style="width: 100%; margin-top: 5px;" />
                <small style="color: #666;">Minimum similarity score (0.0 - 1.0)</small>
            </div>
            
            <div style="margin: 10px 0;">
                <label><strong>Memory Position:</strong> <span id="memory_position_display">${settings.memoryPosition}</span></label>
                <input type="range" id="qdrant_memory_position" min="1" max="30" value="${settings.memoryPosition}" 
                       style="width: 100%; margin-top: 5px;" />
                <small style="color: #666;">How many messages from the end to insert memories</small>
            </div>
            
            <div style="margin: 10px 0;">
                <label><strong>Retain Recent Messages:</strong> <span id="retain_recent_display">${settings.retainRecentMessages}</span></label>
                <input type="range" id="qdrant_retain_recent" min="0" max="50" value="${settings.retainRecentMessages}" 
                       style="width: 100%; margin-top: 5px;" />
                <small style="color: #666;">Exclude the last N messages from retrieval (0 = no exclusion)</small>
            </div>
            
            <hr style="margin: 15px 0;" />
            
            <h4>Automatic Memory Creation</h4>
            
            <div style="margin: 10px 0;">
                <label style="display: flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="qdrant_per_character" ${settings.usePerCharacterCollections ? "checked" : ""} />
                    <strong>Use Per-Character Collections</strong>
                </label>
                <small style="color: #666; display: block; margin-left: 30px;">Each character gets their own dedicated collection (recommended)</small>
            </div>
            
            <div style="margin: 10px 0;">
                <label style="display: flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="qdrant_auto_save" ${settings.autoSaveMemories ? "checked" : ""} />
                    <strong>Automatically Save Memories</strong>
                </label>
                <small style="color: #666; display: block; margin-left: 30px;">Save messages to Qdrant as conversations happen</small>
            </div>
            
            <div style="margin: 10px 0;">
                <label style="display: flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="qdrant_save_user" ${settings.saveUserMessages ? "checked" : ""} />
                    Save user messages
                </label>
            </div>
            
            <div style="margin: 10px 0;">
                <label style="display: flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="qdrant_save_character" ${settings.saveCharacterMessages ? "checked" : ""} />
                    Save character messages
                </label>
            </div>
            
            <div style="margin: 10px 0;">
                <label><strong>Minimum Message Length:</strong> <span id="min_message_length_display">${settings.minMessageLength}</span></label>
                <input type="range" id="qdrant_min_length" min="5" max="50" value="${settings.minMessageLength}" 
                       style="width: 100%; margin-top: 5px;" />
                <small style="color: #666;">Minimum characters to save a message</small>
            </div>

            <div style="margin: 10px 0;">
                <label><strong>Deduplication Threshold:</strong> <span id="dedupe_threshold_display">${settings.dedupeThreshold}</span></label>
                <input type="range" id="qdrant_dedupe_threshold" min="0.80" max="1.00" step="0.01" value="${settings.dedupeThreshold}" 
                       style="width: 100%; margin-top: 5px;" />
                <small style="color: #666;">Prevent saving duplicate chunks (higher = stricter)</small>
            </div>
            
            <hr style="margin: 15px 0;" />
            
            <h4>Other Settings</h4>
            
            <div style="margin: 15px 0;">
                <label style="display: flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="qdrant_prevent_duplicate" ${settings.preventDuplicateInjection ? "checked" : ""} />
                    Prevent duplicate memory injection
                </label>
                <small style="color: #666; display: block; margin-left: 30px;">Prevent memories from being added to context multiple times</small>
            </div>
            
            <div style="margin: 15px 0;">
                <label style="display: flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="qdrant_notifications" ${settings.showMemoryNotifications ? "checked" : ""} />
                    Show memory notifications
                </label>
            </div>
            
            <div style="margin: 15px 0;">
                <label style="display: flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="qdrant_debug" ${settings.debugMode ? "checked" : ""} />
                    Debug Mode (check console)
                </label>
            </div>
            
            <hr style="margin: 15px 0;" />
            
            <div style="margin: 15px 0; display: flex; gap: 10px; flex-wrap: wrap;">
                <button id="qdrant_test" class="menu_button">Test Connection</button>
                <button id="qdrant_save" class="menu_button">Save Settings</button>
                <button id="qdrant_view_memories" class="menu_button">View Memories</button>
                <button id="qdrant_index_chats" class="menu_button" style="background-color: #28a745; color: white;">Index Character Chats</button>
            </div>
            
            <div id="qdrant_status" style="margin-top: 10px; padding: 10px; border-radius: 5px;"></div>
                </div>
            </div>
        </div>
    `

  const $ = window.$
  $("#extensions_settings2").append(settingsHtml)

  if (typeof window.applyInlineDrawerListeners === "function") {
    window.applyInlineDrawerListeners()
  }

  function updateEmbeddingModelOptions(provider) {
    const models = EMBEDDING_MODEL_OPTIONS[provider] || EMBEDDING_MODEL_OPTIONS.openai
    const $modelSelect = $("#qdrant_embedding_model")
    let previousValue = settings.embeddingModel
    if (provider === "openrouter" && OPENROUTER_MODEL_ALIASES[previousValue]) {
      previousValue = OPENROUTER_MODEL_ALIASES[previousValue]
      settings.embeddingModel = previousValue
    } else if (provider === "openai" && OPENAI_MODEL_ALIASES[previousValue]) {
      previousValue = OPENAI_MODEL_ALIASES[previousValue]
      settings.embeddingModel = previousValue
    }
    let matched = false

    $modelSelect.empty()

    models.forEach((model) => {
      const isSelected = model.value === previousValue
      if (isSelected) {
        matched = true
      }

      const optionHtml = `<option value="${model.value}"${
        isSelected ? " selected" : ""
      }>${model.label}</option>`
      $modelSelect.append(optionHtml)
    })

    if (!matched && models.length > 0) {
      const fallback = DEFAULT_MODEL_BY_PROVIDER[provider] || models[0].value
      settings.embeddingModel = fallback
      $modelSelect.val(settings.embeddingModel)
    }
  }

  function updateEmbeddingProviderUI() {
    const provider = settings.embeddingProvider || "openai"
    const $openAIGroup = $("#qdrant_openai_key_group")
    const $openRouterGroup = $("#qdrant_openrouter_key_group")
    const $localGroup = $("#qdrant_local_url_group")
    const $localApiKeyGroup = $("#qdrant_local_api_key_group")
    const $localDimensionsGroup = $("#qdrant_local_dimensions_group")
    const $localDimensionsInput = $("#qdrant_local_dimensions")
    const $modelGroup = $("#qdrant_embedding_model_group")

    $openAIGroup.toggle(provider === "openai")
    $openRouterGroup.toggle(provider === "openrouter")
    $localGroup.toggle(provider === "local")
    $localApiKeyGroup.toggle(provider === "local")
    $localDimensionsGroup.toggle(provider === "local")

    if (provider === "local") {
      $localDimensionsInput.val(settings.customEmbeddingDimensions ?? "")
    }

    const showModelSelect = provider !== "local"
    $modelGroup.toggle(showModelSelect)

    if (showModelSelect) {
      updateEmbeddingModelOptions(provider)
    }
  }

  // Event handlers
  $("#qdrant_enabled").on("change", function () {
    settings.enabled = $(this).is(":checked")
  })

  $("#qdrant_url").on("input", function () {
    settings.qdrantUrl = $(this).val()
  })

  $("#qdrant_api_key").on("input", function () {
    settings.qdrantApiKey = $(this).val()
  })

  $("#qdrant_collection").on("input", function () {
    settings.collectionName = $(this).val()
  })

  $("#qdrant_embedding_provider").on("change", function () {
    settings.embeddingProvider = $(this).val()
    updateEmbeddingProviderUI()
  })

  $("#qdrant_openai_key").on("input", function () {
    settings.openaiApiKey = $(this).val()
  })

  $("#qdrant_openrouter_key").on("input", function () {
    settings.openRouterApiKey = $(this).val()
  })

  $("#qdrant_local_url").on("input", function () {
    settings.localEmbeddingUrl = $(this).val()
  })

  $("#qdrant_local_api_key").on("input", function () {
    settings.localEmbeddingApiKey = $(this).val()
  })

  $("#qdrant_local_dimensions").on("input", function () {
    const value = Number.parseInt($(this).val(), 10)
    settings.customEmbeddingDimensions = Number.isFinite(value) && value > 0 ? value : null
  })

  $("#qdrant_embedding_model").on("change", function () {
    settings.embeddingModel = $(this).val()
  })

  $("#qdrant_memory_limit").on("input", function () {
    settings.memoryLimit = Number.parseInt($(this).val())
    $("#memory_limit_display").text(settings.memoryLimit)
  })

  $("#qdrant_score_threshold").on("input", function () {
    settings.scoreThreshold = Number.parseFloat($(this).val())
    $("#score_threshold_display").text(settings.scoreThreshold)
  })

  $("#qdrant_memory_position").on("input", function () {
    settings.memoryPosition = Number.parseInt($(this).val())
    $("#memory_position_display").text(settings.memoryPosition)
  })

  $("#qdrant_retain_recent").on("input", function () {
    settings.retainRecentMessages = Number.parseInt($(this).val())
    $("#retain_recent_display").text(settings.retainRecentMessages)
  })

  $("#qdrant_per_character").on("change", function () {
    settings.usePerCharacterCollections = $(this).is(":checked")
  })

  $("#qdrant_auto_save").on("change", function () {
    settings.autoSaveMemories = $(this).is(":checked")
  })

  $("#qdrant_save_user").on("change", function () {
    settings.saveUserMessages = $(this).is(":checked")
  })

  $("#qdrant_save_character").on("change", function () {
    settings.saveCharacterMessages = $(this).is(":checked")
  })

  $("#qdrant_min_length").on("input", function () {
    settings.minMessageLength = Number.parseInt($(this).val())
    $("#min_message_length_display").text(settings.minMessageLength)
  })

  $("#qdrant_dedupe_threshold").on("input", function () {
    settings.dedupeThreshold = Number.parseFloat($(this).val())
    $("#dedupe_threshold_display").text(settings.dedupeThreshold.toFixed(2))
  })

  $("#qdrant_prevent_duplicate").on("change", function () {
    settings.preventDuplicateInjection = $(this).is(":checked")
  })

  $("#qdrant_notifications").on("change", function () {
    settings.showMemoryNotifications = $(this).is(":checked")
  })

  $("#qdrant_debug").on("change", function () {
    settings.debugMode = $(this).is(":checked")
  })

  updateEmbeddingProviderUI()

  $("#qdrant_save").on("click", () => {
    saveSettings()
    $("#qdrant_status")
      .text("✓ Settings saved!")
      .css({ color: "green", background: "#d4edda", border: "1px solid green" })
    setTimeout(() => $("#qdrant_status").text("").css({ background: "", border: "" }), 3000)
  })

  $("#qdrant_test").on("click", async () => {
    $("#qdrant_status")
      .text("Testing connection...")
      .css({ color: "#004085", background: "#cce5ff", border: "1px solid #004085" })

    try {
      const response = await fetch(`${settings.qdrantUrl}/collections`, {
        headers: getQdrantHeaders(),
      })

      if (response.ok) {
        const data = await response.json()
        const collections = data.result?.collections || []
        $("#qdrant_status")
          .text(`✓ Connected! Found ${collections.length} collections.`)
          .css({ color: "green", background: "#d4edda", border: "1px solid green" })
      } else {
        $("#qdrant_status")
          .text("✗ Connection failed. Check URL.")
          .css({ color: "#721c24", background: "#f8d7da", border: "1px solid #721c24" })
      }
    } catch (error) {
      $("#qdrant_status")
        .text(`✗ Error: ${error.message}`)
        .css({ color: "#721c24", background: "#f8d7da", border: "1px solid #721c24" })
    }
  })

  $("#qdrant_view_memories").on("click", () => {
    showMemoryViewer()
  })

  $("#qdrant_index_chats").on("click", () => {
    indexCharacterChats()
  })
}

// ============================================================================
// EXTENSION INITIALIZATION
// ============================================================================

window.jQuery(async () => {
  loadSettings()
  createSettingsUI()

  // Hook into message events for automatic saving
  const eventSource = window.eventSource
  if (typeof eventSource !== "undefined" && eventSource.on) {
    const handleMessageEvent = () => {
      if (!settings.enabled || !settings.autoSaveMemories) return
      onMessageSent()
    }

    eventSource.on("MESSAGE_RECEIVED", handleMessageEvent)
    eventSource.on("USER_MESSAGE_RENDERED", handleMessageEvent)
    console.log("[Qdrant Memory] Using eventSource hooks")
  } else {
    // Fallback: poll for new messages
    console.log("[Qdrant Memory] Using polling fallback for auto-save")
    let lastChatLength = 0
    setInterval(() => {
      const context = getContext()
      const chat = context.chat || []

      if (!settings.enabled || !settings.autoSaveMemories) {
        lastChatLength = chat.length
        return
      }

      if (chat.length > lastChatLength) {
        onMessageSent()
      }
      lastChatLength = chat.length
    }, 2000)
  }

  console.log("[Qdrant Memory] Extension loaded successfully (v3.1.3 - fixed partial memory storage during streaming)")
})

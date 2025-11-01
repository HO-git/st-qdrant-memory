// Qdrant Memory Extension for SillyTavern
// This extension retrieves relevant memories from Qdrant and injects them into conversations
// Version 3.1.0 - Added temporal context with visible dates in memory chunks

const extensionName = "qdrant-memory"
const QDRANT_MEMORY_FLAG = "__qdrantMemory"

// Default settings
const defaultSettings = {
  enabled: true,
  qdrantUrl: "http://localhost:6333",
  collectionName: "mem",
  openaiApiKey: "",
  embeddingModel: "text-embedding-3-large",
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
}

let settings = { ...defaultSettings }
const saveQueue = []
let processingSaveQueue = false

let messageBuffer = []
let lastMessageTime = 0
let chunkTimer = null

function isQdrantMemoryMessage(message) {
  return Boolean(message && message[QDRANT_MEMORY_FLAG])
}

function normalizeSendDate(sendDate) {
  if (sendDate instanceof Date) {
    return sendDate.getTime()
  }

  if (typeof sendDate === "number") {
    return sendDate
  }

  if (typeof sendDate === "string") {
    const numeric = Number(sendDate)
    if (!Number.isNaN(numeric)) {
      return numeric
    }

    const parsed = Date.parse(sendDate)
    if (!Number.isNaN(parsed)) {
      return parsed
    }
  }

  return null
}

function getConversationMessages(chat) {
  if (!Array.isArray(chat)) {
    return []
  }

  return chat.filter((msg) => {
    if (!msg) return false
    if (isQdrantMemoryMessage(msg)) return false

    return normalizeSendDate(msg.send_date) !== null
  })
}

function removeExistingMemoryEntries(chat) {
  if (!Array.isArray(chat)) return

  for (let i = chat.length - 1; i >= 0; i--) {
    if (isQdrantMemoryMessage(chat[i])) {
      chat.splice(i, 1)
    }
  }
}

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
  }
  return dimensions[settings.embeddingModel] || 1536
}

// Check if collection exists
async function collectionExists(collectionName) {
  try {
    const response = await fetch(`${settings.qdrantUrl}/collections/${collectionName}`)
    return response.ok
  } catch (error) {
    console.error("[Qdrant Memory] Error checking collection:", error)
    return false
  }
}

// Create collection for a character
async function createCollection(collectionName) {
  try {
    const dimensions = getEmbeddingDimensions()

    const response = await fetch(`${settings.qdrantUrl}/collections/${collectionName}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
      },
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
async function ensureCollection(characterName) {
  const collectionName = getCollectionName(characterName)
  const exists = await collectionExists(collectionName)

  if (!exists) {
    if (settings.debugMode) {
      console.log(`[Qdrant Memory] Collection doesn't exist, creating: ${collectionName}`)
    }
    return await createCollection(collectionName)
  }

  return true
}

// Universal Embedding Generator (OpenAI / OpenRouter / HuggingFace / Custom)
async function generateEmbedding(text) {
  const settings = extension_settings.qdrantMemory || {};
  const provider = settings.provider || "openai";
  const apiKey = settings.apiKey || settings.openaiApiKey; // fallback
  const model = settings.embeddingModel || "text-embedding-3-large";
  const customUrl = settings.baseUrl || "https://api.openai.com/v1/embeddings";

  try {
    let apiUrl = customUrl;
    let headers = {};
    let payload = {};

    switch (provider.toLowerCase()) {
      case "openrouter":
        apiUrl = "https://openrouter.ai/api/v1/embeddings";
        headers = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        };
        payload = { input: text, model };
        break;

      case "huggingface":
        apiUrl = `https://api-inference.huggingface.co/pipeline/feature-extraction/${model}`;
        headers = { "Authorization": `Bearer ${apiKey}` };
        payload = { inputs: text };
        break;

      case "custom":
        apiUrl = customUrl;
        headers = {
          "Content-Type": "application/json",
          ...(apiKey ? { "Authorization": `Bearer ${apiKey}` } : {}),
        };
        payload = { input: text, model };
        break;

      default: // OpenAI
        apiUrl = "https://api.openai.com/v1/embeddings";
        headers = {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        };
        payload = { input: text, model };
    }

    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error(`[Qdrant Memory] ${provider} API error:`, response.status, err);
      return null;
    }

    const json = await response.json();
    let embedding;

    if (provider === "huggingface") {
      embedding = Array.isArray(json[0]) ? json[0] : json;
    } else if (json.data?.[0]?.embedding) {
      embedding = json.data[0].embedding;
    } else {
      console.error("[Qdrant Memory] Unexpected embedding response format:", json);
      return null;
    }

    return embedding;
  } catch (error) {
    console.error(`[Qdrant Memory] Error generating embedding (${provider}):`, error);
    return null;
  }
}

// Search Qdrant for relevant memories
async function searchMemories(query, characterName) {
  if (!settings.enabled) return []

  try {
    const collectionName = getCollectionName(characterName)

    // Ensure collection exists (create if needed)
    const collectionReady = await ensureCollection(characterName)
    if (!collectionReady) {
      if (settings.debugMode) {
        console.log(`[Qdrant Memory] Collection not ready: ${collectionName}`)
      }
      return []
    }

    const embedding = await generateEmbedding(query)
    if (!embedding) return []

    // Get the timestamp from N messages ago to exclude recent context
    const context = getContext()
    const chat = context.chat || []
    removeExistingMemoryEntries(chat)
    const conversationMessages = getConversationMessages(chat)
    let timestampThreshold = 0

    if (
      settings.retainRecentMessages > 0 &&
      conversationMessages.length > settings.retainRecentMessages
    ) {
      // Get the timestamp of the message at the retain boundary
      const retainIndex = conversationMessages.length - settings.retainRecentMessages
      const retainMessage = conversationMessages[retainIndex]
      const normalizedTimestamp = normalizeSendDate(retainMessage?.send_date)

      if (normalizedTimestamp !== null) {
        timestampThreshold = normalizedTimestamp
        if (settings.debugMode) {
          console.log(`[Qdrant Memory] Excluding messages newer than timestamp: ${timestampThreshold}`)
        }
      }
    }

    const searchPayload = {
      vector: embedding,
      limit: settings.memoryLimit,
      score_threshold: settings.scoreThreshold,
      with_payload: true,
    }

    const filterConditions = []

    // Add timestamp filter to exclude recent messages
    if (timestampThreshold > 0) {
      filterConditions.push({
        key: "timestamp",
        range: {
          lt: timestampThreshold,
        },
      })
    }

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
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(searchPayload),
    })

    if (!response.ok) {
      console.error("[Qdrant Memory] Search failed:", response.statusText)
      return []
    }

    const data = await response.json()

    if (settings.debugMode) {
      console.log("[Qdrant Memory] Found memories:", data.result)
    }

    return data.result || []
  } catch (error) {
    console.error("[Qdrant Memory] Error searching memories:", error)
    return []
  }
}

// Process save queue
async function processSaveQueue() {
  if (processingSaveQueue || saveQueue.length === 0) return

  processingSaveQueue = true

  while (saveQueue.length > 0) {
    const item = saveQueue.shift()
    await saveMessageToQdrant(item.text, item.characterName, item.isUser, item.messageId)
  }

  processingSaveQueue = false
}

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

  // Build chunk text with speaker labels
  messageBuffer.forEach((msg) => {
    const speaker = msg.isUser ? "You" : msg.characterName
    speakers.add(speaker)
    messageIds.push(msg.messageId)

    const line = `${speaker}: ${msg.text}\n`
    chunkText += line
    totalLength += line.length
  })

  // Format date prefix
  let finalText = chunkText.trim()
  try {
    const dateObj = new Date(currentTimestamp)
    const dateStr = dateObj.toISOString().split("T")[0] // YYYY-MM-DD format
    finalText = `[${dateStr}]\n${finalText}`
  } catch (e) {
    console.warn("[Qdrant Memory] Error formatting date:", e)
  }

  return {
    text: finalText,
    speakers: Array.from(speakers),
    messageIds: messageIds,
    messageCount: messageBuffer.length,
    timestamp: currentTimestamp,
  }
}

async function saveChunkToQdrant(chunk, participants) {
  if (!chunk || !participants || participants.length === 0) return false

  try {
    // Generate embedding for the chunk text (already has date prefix from creation)
    const embedding = await generateEmbedding(chunk.text)
    if (!embedding) {
      console.error("[Qdrant Memory] Cannot save chunk - embedding generation failed")
      return false
    }

    const pointId = generateUUID()

    // Prepare payload - chunk.text already includes date prefix
    const payload = {
      text: chunk.text, // Already has date prefix from createChunkFrom* functions
      speakers: chunk.speakers.join(", "),
      messageCount: chunk.messageCount,
      timestamp: chunk.timestamp, // Keep original timestamp for filtering
      messageIds: chunk.messageIds.join(","),
      isChunk: true,
    }

    // Save to all participant collections
    const savePromises = participants.map(async (characterName) => {
      const collectionName = getCollectionName(characterName)

      // Ensure collection exists
      const collectionReady = await ensureCollection(characterName)
      if (!collectionReady) {
        console.error(`[Qdrant Memory] Cannot save chunk - collection creation failed for ${characterName}`)
        return false
      }

      // Add character name to payload for this specific save
      const characterPayload = {
        ...payload,
        character: characterName,
      }

      // Save to Qdrant
      const response = await fetch(`${settings.qdrantUrl}/collections/${collectionName}/points`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
        },
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
        const errorText = await response.text().catch(() => "Unable to read error response")
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
  if (!settings.autoSaveMemories) return
  if (!settings.openaiApiKey) return
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

// Format memories for display
const MAX_MEMORY_LENGTH = 1500 // adjust per your preference

function formatMemories(memories) {
  if (!memories || memories.length === 0) return ""

  let formatted = "\n[Past chat memories]\n\n"

  memories.forEach((memory) => {
    const payload = memory.payload

    let speakerLabel
    if (payload.isChunk) {
      speakerLabel = `Conversation (${payload.speakers})`
    } else {
      speakerLabel = payload.speaker === "user" ? "You said" : "Character said"
    }

    let text = payload.text.replace(/\n/g, " ") // flatten newlines

    const score = (memory.score * 100).toFixed(0)

    formatted += `• ${speakerLabel}: "${text}" (score: ${score}%)\n\n`
  })

  return formatted
}

// Get current context
function getContext() {
  const SillyTavern = window.SillyTavern
  const $ = window.$
  const toastr = window.toastr

  if (typeof SillyTavern !== "undefined" && SillyTavern.getContext) {
    return SillyTavern.getContext()
  }
  return {
    chat: window.chat || [],
    name2: window.name2 || "",
    characters: window.characters || [],
  }
}

// Save message to Qdrant
async function saveMessageToQdrant(text, characterName, isUser, messageId) {
  // Implementation for saving message to Qdrant
}

// Generate a unique UUID
function generateUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    var r = (Math.random() * 16) | 0,
      v = c == "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

// ============================================================================
// CHAT INDEXING FUNCTIONS - FIXED ENDPOINTS
// ============================================================================

async function getCharacterChats(characterName) {
  try {
    const context = getContext()

    console.log("[Qdrant Memory] Getting chats for character:", characterName)
    console.log("[Qdrant Memory] Context characters:", context.characters)

    // Try to get the character's avatar URL
    let avatar_url = `${characterName}.png`
    if (context.characters && Array.isArray(context.characters)) {
      const char = context.characters.find((c) => c.name === characterName)
      console.log("[Qdrant Memory] Found character object:", char)
      if (char && char.avatar) {
        avatar_url = char.avatar
        console.log("[Qdrant Memory] Using avatar from character:", avatar_url)
      } else {
        console.log("[Qdrant Memory] No avatar in character object, trying default")
      }
    }

    console.log("[Qdrant Memory] Final avatar_url:", avatar_url)

    // ✅ FIXED: Use correct SillyTavern endpoint with credentials for authenticated instances
    const response = await fetch("/api/characters/chats", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include", // Include cookies for authentication
      body: JSON.stringify({
        avatar_url: avatar_url,
      }),
    })

    if (settings.debugMode) {
      console.log("[Qdrant Memory] Response status:", response.status)
      console.log("[Qdrant Memory] Response ok:", response.ok)
    }

    if (!response.ok) {
      const errorText = await response.text()
      console.error("[Qdrant Memory] Failed to get chat list:", response.status, response.statusText)
      console.error("[Qdrant Memory] Error response:", errorText)
      return []
    }

    const data = await response.json()
    
    if (settings.debugMode) {
      console.log("[Qdrant Memory] Received data:", data)
    }

    // Handle different response formats - extract just the filenames
    let chatFiles = []
    
    if (Array.isArray(data)) {
      // If it's an array of strings, use directly
      if (typeof data[0] === 'string') {
        chatFiles = data
      }
      // If it's an array of objects with file_name
      else if (data[0] && data[0].file_name) {
        chatFiles = data.map(item => item.file_name)
      }
      // If it's an array of other objects, try to extract filename
      else {
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
    if (settings.debugMode) {
      console.error("[Qdrant Memory] Full error:", error.stack)
    }
    return []
  }
}

async function loadChatFile(characterName, chatFile) {
  try {
    const context = getContext()

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

    // CRITICAL: Remove .jsonl extension as the API adds it back
    // The endpoint does: `${file_name}.jsonl`, so we must send without extension
    const fileNameWithoutExt = chatFile.replace(/\.jsonl$/, '')

    if (settings.debugMode) {
      console.log("[Qdrant Memory] Original filename:", chatFile)
      console.log("[Qdrant Memory] Sending without extension:", fileNameWithoutExt)
    }

    // Try to get the character's avatar URL
    let avatar_url = `${characterName}.png`
    if (context.characters && Array.isArray(context.characters)) {
      const char = context.characters.find((c) => c.name === characterName)
      if (char && char.avatar) {
        avatar_url = char.avatar
      }
    }

    if (settings.debugMode) {
      console.log("[Qdrant Memory] Loading with params:", {
        ch_name: characterName,
        file_name: fileNameWithoutExt,  // Use the variable without extension!
        avatar_url: avatar_url
      })
    }

    // ✅ FIXED: Use correct SillyTavern endpoint with credentials
    const response = await fetch("/api/chats/get", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include", // Include cookies for authentication
      body: JSON.stringify({
        ch_name: characterName,
        file_name: fileNameWithoutExt, // Send WITHOUT .jsonl as API adds it
        avatar_url: avatar_url,
      }),
    })

    if (settings.debugMode) {
      console.log("[Qdrant Memory] Load chat response status:", response.status)
    }

    if (!response.ok) {
      const errorText = await response.text()
      console.error("[Qdrant Memory] Failed to load chat file:", response.status, response.statusText)
      console.error("[Qdrant Memory] Error response:", errorText)
      return null
    }

    const chatData = await response.json()
    
    if (settings.debugMode) {
      console.log("[Qdrant Memory] Raw chat data received:", chatData)
      console.log("[Qdrant Memory] Chat data type:", typeof chatData)
      console.log("[Qdrant Memory] Is array?", Array.isArray(chatData))
      if (chatData) {
        console.log("[Qdrant Memory] Chat data keys:", Object.keys(chatData))
      }
    }
    
    // Handle different response formats
    let messages = null
    if (Array.isArray(chatData)) {
      messages = chatData
    } else if (chatData && Array.isArray(chatData.chat)) {
      messages = chatData.chat
    } else if (chatData && Array.isArray(chatData.messages)) {
      messages = chatData.messages
    } else if (chatData && typeof chatData === 'object') {
      // Maybe the entire response is the chat data
      messages = [chatData]
    }
    
    if (settings.debugMode) {
      console.log("[Qdrant Memory] Extracted messages:", messages)
      console.log("[Qdrant Memory] Loaded chat with", messages?.length || 0, "messages")
    }
    
    return messages
  } catch (error) {
    console.error("[Qdrant Memory] Error loading chat file:", error)
    if (settings.debugMode) {
      console.error("[Qdrant Memory] Full error:", error.stack)
    }
    return null
  }
}

async function chunkExists(collectionName, messageIds) {
  try {
    // Search for any of the message IDs in the chunk
    const response = await fetch(`${settings.qdrantUrl}/collections/${collectionName}/points/scroll`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
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

    // Create message object
    const messageObj = {
      text: text,
      characterName: characterName,
      isUser: isUser,
      messageId: `${characterName}_${msg.send_date}_${messages.indexOf(msg)}`,
      timestamp: msg.send_date || Date.now(),
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

  messages.forEach((msg) => {
    const speaker = msg.isUser ? "You" : msg.characterName
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
    try {
      const dateObj = new Date(oldestTimestamp)
      const dateStr = dateObj.toISOString().split("T")[0] // YYYY-MM-DD format
      finalText = `[${dateStr}]\n${finalText}`
    } catch (e) {
      console.warn("[Qdrant Memory] Invalid timestamp for chunk:", oldestTimestamp, e)
    }
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

  if (!settings.openaiApiKey) {
    toastr.error("OpenAI API key not set", "Qdrant Memory")
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
      setTimeout(() => {
        $("#qdrant_index_modal").remove()
        $("#qdrant_index_overlay").remove()
      }, 2000)
      return
    }

    $("#qdrant_index_status").text(`Found ${chatFiles.length} chat files`)

    const collectionName = getCollectionName(characterName)
    await ensureCollection(characterName)

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
        const participants = [characterName] // For now, just save to current character

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

    $("#qdrant_index_cancel").text("Close")
    $("#qdrant_index_cancel")
      .off("click")
      .on("click", () => {
        $("#qdrant_index_modal").remove()
        $("#qdrant_index_overlay").remove()
      })
  } catch (error) {
    console.error("[Qdrant Memory] Error indexing chats:", error)
    $("#qdrant_index_status").text("Error during indexing")
    $("#qdrant_index_details").text(error.message)
    toastr.error("Failed to index chats", "Qdrant Memory")
  }
}

// ============================================================================
// GENERATION INTERCEPTOR - This runs BEFORE messages are sent to the LLM
// ============================================================================

globalThis.qdrantMemoryInterceptor = async (chat, contextSize, abort, type) => {
  if (!settings.enabled) {
    if (settings.debugMode) {
      console.log("[Qdrant Memory] Extension disabled, skipping")
    }
    return
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

    // Remove previously injected memory messages to prevent duplication
    removeExistingMemoryEntries(chat)

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
        [QDRANT_MEMORY_FLAG]: true,
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

function onMessageSent() {
  if (!settings.autoSaveMemories) return

  try {
    const context = getContext()
    const chat = context.chat || []
    const characterName = context.name2

    if (!characterName || chat.length === 0) return

    // Get the last message
    const lastMessage = chat[chat.length - 1]

    // Create a unique ID for this message
    const messageId = `${characterName}_${lastMessage.send_date}_${chat.length}`

    if (lastMessage.mes && lastMessage.mes.trim().length > 0) {
      const isUser = lastMessage.is_user || false
      bufferMessage(lastMessage.mes, characterName, isUser, messageId)
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
    const response = await fetch(`${settings.qdrantUrl}/collections/${collectionName}`)
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
  const vectors = info.vectors_count || 0

  // Create a simple modal using jQuery
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
                <p><strong>Total Vectors:</strong> ${vectors}</p>
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

  // Close modal
  $("#qdrant_close_modal, #qdrant_overlay").on("click", () => {
    $("#qdrant_modal").remove()
    $("#qdrant_overlay").remove()
  })

  // Delete collection
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

// Create settings UI
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
                <label><strong>Base Collection Name:</strong></label>
                <input type="text" id="qdrant_collection" class="text_pole" value="${settings.collectionName}" 
                       style="width: 100%; margin-top: 5px;" 
                       placeholder="sillytavern_memories" />
                <small style="color: #666;">Base name for collections (character name will be appended)</small>
            </div>
            
            <div style="margin: 10px 0;">
                <label><strong>OpenAI API Key:</strong></label>
                <input type="password" id="qdrant_openai_key" class="text_pole" value="${settings.openaiApiKey}" 
                       placeholder="sk-..." style="width: 100%; margin-top: 5px;" />
                <small style="color: #666;">Required for generating embeddings</small>
            </div>
            
            <div style="margin: 10px 0;">
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
            
            <hr style="margin: 15px 0;" />
            
            <h4>Other Settings</h4>
            
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

  // Ensure the inline drawer uses SillyTavern's default behaviour
  if (typeof window.applyInlineDrawerListeners === "function") {
    window.applyInlineDrawerListeners()
  }

  // Event handlers
  $("#qdrant_enabled").on("change", function () {
    settings.enabled = $(this).is(":checked")
  })

  $("#qdrant_url").on("input", function () {
    settings.qdrantUrl = $(this).val()
  })

  $("#qdrant_collection").on("input", function () {
    settings.collectionName = $(this).val()
  })

  $("#qdrant_openai_key").on("input", function () {
    settings.openaiApiKey = $(this).val()
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

  $("#qdrant_notifications").on("change", function () {
    settings.showMemoryNotifications = $(this).is(":checked")
  })

  $("#qdrant_debug").on("change", function () {
    settings.debugMode = $(this).is(":checked")
  })

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
      const response = await fetch(`${settings.qdrantUrl}/collections`)

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

// Extension initialization
window.jQuery(async () => {
  loadSettings()
  createSettingsUI()

  // Hook into message events for automatic saving
  const eventSource = window.eventSource
  if (typeof eventSource !== "undefined" && eventSource.on) {
    eventSource.on("MESSAGE_RECEIVED", onMessageSent)
    eventSource.on("USER_MESSAGE_RENDERED", onMessageSent)
    console.log("[Qdrant Memory] Using eventSource hooks")
  } else {
    // Fallback: poll for new messages
    console.log("[Qdrant Memory] Using polling fallback for auto-save")
    let lastChatLength = 0
    setInterval(() => {
      if (!settings.autoSaveMemories) return
      const context = getContext()
      const chat = context.chat || []
      if (chat.length > lastChatLength) {
        lastChatLength = chat.length
        onMessageSent()
      }
    }, 2000)
  }

  console.log("[Qdrant Memory] Extension loaded successfully (v3.1.0 - temporal context with dates)")
})

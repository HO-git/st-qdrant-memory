// Qdrant Memory Extension for SillyTavern
// This extension retrieves relevant memories from Qdrant and injects them into conversations
// Version 3.0.0 - Added per-character collections and automatic memory creation

const extensionName = 'qdrant-memory';

// Default settings
const defaultSettings = {
    enabled: true,
    qdrantUrl: 'http://localhost:6333',
    collectionName: 'sillytavern_memories',
    openaiApiKey: '',
    embeddingModel: 'text-embedding-3-large',
    memoryLimit: 5,
    scoreThreshold: 0.3,
    memoryPosition: 2,
    debugMode: false,
    // New v3.0 settings
    usePerCharacterCollections: true,
    autoSaveMemories: true,
    saveUserMessages: true,
    saveCharacterMessages: true,
    minMessageLength: 10,
    showMemoryNotifications: true
};

let settings = { ...defaultSettings };
let saveQueue = [];
let processingSaveQueue = false;

// Load settings from localStorage
function loadSettings() {
    const saved = localStorage.getItem(extensionName);
    if (saved) {
        try {
            settings = { ...defaultSettings, ...JSON.parse(saved) };
        } catch (e) {
            console.error('[Qdrant Memory] Failed to load settings:', e);
        }
    }
    console.log('[Qdrant Memory] Settings loaded:', settings);
}

// Save settings to localStorage
function saveSettings() {
    localStorage.setItem(extensionName, JSON.stringify(settings));
    console.log('[Qdrant Memory] Settings saved');
}

// Get collection name for a character
function getCollectionName(characterName) {
    if (!settings.usePerCharacterCollections) {
        return settings.collectionName;
    }
    
    // Sanitize character name for collection name (lowercase, replace spaces/special chars)
    const sanitized = characterName
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');
    
    return `${settings.collectionName}_${sanitized}`;
}

// Get embedding dimensions for the selected model
function getEmbeddingDimensions() {
    const dimensions = {
        'text-embedding-3-large': 3072,
        'text-embedding-3-small': 1536,
        'text-embedding-ada-002': 1536
    };
    return dimensions[settings.embeddingModel] || 1536;
}

// Check if collection exists
async function collectionExists(collectionName) {
    try {
        const response = await fetch(`${settings.qdrantUrl}/collections/${collectionName}`);
        return response.ok;
    } catch (error) {
        console.error('[Qdrant Memory] Error checking collection:', error);
        return false;
    }
}

// Create collection for a character
async function createCollection(collectionName) {
    try {
        const dimensions = getEmbeddingDimensions();
        
        const response = await fetch(`${settings.qdrantUrl}/collections/${collectionName}`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                vectors: {
                    size: dimensions,
                    distance: 'Cosine'
                }
            })
        });

        if (response.ok) {
            if (settings.debugMode) {
                console.log(`[Qdrant Memory] Created collection: ${collectionName}`);
            }
            return true;
        } else {
            console.error(`[Qdrant Memory] Failed to create collection: ${collectionName}`);
            return false;
        }
    } catch (error) {
        console.error('[Qdrant Memory] Error creating collection:', error);
        return false;
    }
}

// Ensure collection exists (create if needed)
async function ensureCollection(characterName) {
    const collectionName = getCollectionName(characterName);
    const exists = await collectionExists(collectionName);
    
    if (!exists) {
        if (settings.debugMode) {
            console.log(`[Qdrant Memory] Collection doesn't exist, creating: ${collectionName}`);
        }
        return await createCollection(collectionName);
    }
    
    return true;
}

// Generate embedding using OpenAI API
async function generateEmbedding(text) {
    if (!settings.openaiApiKey) {
        console.error('[Qdrant Memory] OpenAI API key not set');
        return null;
    }

    try {
        const response = await fetch('https://api.openai.com/v1/embeddings', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${settings.openaiApiKey}`
            },
            body: JSON.stringify({
                model: settings.embeddingModel,
                input: text
            })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            console.error('[Qdrant Memory] OpenAI API error:', response.statusText, errorData);
            return null;
        }

        const data = await response.json();
        return data.data[0].embedding;
    } catch (error) {
        console.error('[Qdrant Memory] Error generating embedding:', error);
        return null;
    }
}

// Search Qdrant for relevant memories
async function searchMemories(query, characterName) {
    if (!settings.enabled) return [];

    try {
        const collectionName = getCollectionName(characterName);
        
        // Ensure collection exists (create if needed)
        const collectionReady = await ensureCollection(characterName);
        if (!collectionReady) {
            if (settings.debugMode) {
                console.log(`[Qdrant Memory] Collection not ready: ${collectionName}`);
            }
            return [];
        }

        const embedding = await generateEmbedding(query);
        if (!embedding) return [];

        const searchPayload = {
            vector: embedding,
            limit: settings.memoryLimit,
            score_threshold: settings.scoreThreshold,
            with_payload: true
        };

        // Only add character filter if using shared collection
        if (!settings.usePerCharacterCollections) {
            searchPayload.filter = {
                must: [
                    {
                        key: 'character',
                        match: { value: characterName }
                    }
                ]
            };
        }

        const response = await fetch(`${settings.qdrantUrl}/collections/${collectionName}/points/search`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(searchPayload)
        });

        if (!response.ok) {
            console.error('[Qdrant Memory] Search failed:', response.statusText);
            return [];
        }

        const data = await response.json();
        
        if (settings.debugMode) {
            console.log('[Qdrant Memory] Found memories:', data.result);
        }

        return data.result || [];
    } catch (error) {
        console.error('[Qdrant Memory] Error searching memories:', error);
        return [];
    }
}

// Process save queue
async function processSaveQueue() {
    if (processingSaveQueue || saveQueue.length === 0) return;
    
    processingSaveQueue = true;
    
    while (saveQueue.length > 0) {
        const item = saveQueue.shift();
        await saveMessageToQdrant(item.text, item.characterName, item.isUser, item.messageId);
    }
    
    processingSaveQueue = false;
}

// Queue a message for saving
function queueMessage(text, characterName, isUser, messageId) {
    if (!settings.autoSaveMemories) return;
    if (!settings.openaiApiKey) return;
    if (text.length < settings.minMessageLength) return;
    
    // Check if we should save this type of message
    if (isUser && !settings.saveUserMessages) return;
    if (!isUser && !settings.saveCharacterMessages) return;
    
    // Avoid duplicates - check if already in queue
    const isDuplicate = saveQueue.some(item => 
        item.messageId === messageId && item.characterName === characterName
    );
    
    if (isDuplicate) return;
    
    saveQueue.push({ text, characterName, isUser, messageId });
    
    // Start processing queue
    processSaveQueue();
}

const { v4: uuidv4 } = require('uuid');

// Actually save a message to Qdrant
async function saveMessageToQdrant(text, characterName, isUser, messageId) {
    try {
        const collectionName = getCollectionName(characterName);
        
        // Ensure collection exists - abort if creation fails
        const collectionReady = await ensureCollection(characterName);
        if (!collectionReady) {
            console.error(`[Qdrant Memory] Cannot save message - collection creation failed for ${characterName}`);
            return false;
        }
        
        // Generate embedding
        const embedding = await generateEmbedding(text);
        if (!embedding) {
            console.error('[Qdrant Memory] Cannot save message - embedding generation failed');
            return false;
        }

        // Generate point ID using UUID if messageId is not provided
        const pointId = messageId || uuidv4();
        
        // Prepare payload
        const payload = {
            text: text,
            speaker: isUser ? 'user' : 'character',
            character: characterName,
            timestamp: Date.now(),
            messageId: messageId
        };

        // Save to Qdrant
        const response = await fetch(`${settings.qdrantUrl}/collections/${collectionName}/points`, {
            method: 'PUT',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                points: [
                    {
                        id: pointId,
                        vector: embedding,
                        payload: payload
                    }
                ]
            })
        });

        if (!response.ok) {
            console.error(`[Qdrant Memory] Failed to save message: ${response.status} ${response.statusText}`);
            return false;
        }

        return true;
    } catch (err) {
        console.error('[Qdrant Memory] Error saving message:', err);
        return false;
    }
}

// Format memories for display
function formatMemories(memories) {
    if (!memories || memories.length === 0) return '';

    let formatted = '\n[Retrieved from past conversations]\n';
    
    memories.forEach((memory, index) => {
        const payload = memory.payload;
        const score = (memory.score * 100).toFixed(0);
        formatted += `• ${payload.speaker === 'user' ? 'You said' : 'Character said'}: "${payload.text.substring(0, 150)}${payload.text.length > 150 ? '...' : ''}"\n`;
    });
    
    return formatted;
}

// Get current context
function getContext() {
    if (typeof SillyTavern !== 'undefined' && SillyTavern.getContext) {
        return SillyTavern.getContext();
    }
    return {
        chat: window.chat || [],
        name2: window.name2 || '',
        characters: window.characters || []
    };
}

// ============================================================================
// GENERATION INTERCEPTOR - This runs BEFORE messages are sent to the LLM
// ============================================================================

globalThis.qdrantMemoryInterceptor = async function(chat, contextSize, abort, type) {
    if (!settings.enabled) {
        if (settings.debugMode) {
            console.log('[Qdrant Memory] Extension disabled, skipping');
        }
        return;
    }

    try {
        const context = getContext();
        const characterName = context.name2;

        // Skip if no character is selected
        if (!characterName) {
            if (settings.debugMode) {
                console.log('[Qdrant Memory] No character selected, skipping');
            }
            return;
        }

        // Find the last user message to use as the query
        const lastUserMsg = chat.slice().reverse().find(msg => msg.is_user);
        if (!lastUserMsg || !lastUserMsg.mes) {
            if (settings.debugMode) {
                console.log('[Qdrant Memory] No user message found, skipping');
            }
            return;
        }

        const query = lastUserMsg.mes;

        if (settings.debugMode) {
            console.log('[Qdrant Memory] Generation interceptor triggered');
            console.log('[Qdrant Memory] Type:', type);
            console.log('[Qdrant Memory] Context size:', contextSize);
            console.log('[Qdrant Memory] Searching for:', query);
            console.log('[Qdrant Memory] Character:', characterName);
        }

        // Search for relevant memories
        const memories = await searchMemories(query, characterName);

        if (memories.length > 0) {
            const memoryText = formatMemories(memories);
            
            if (settings.debugMode) {
                console.log('[Qdrant Memory] Retrieved memories:', memoryText);
            }

            // Create memory entry
            const memoryEntry = {
                name: 'System',
                is_user: false,
                is_system: true,
                mes: memoryText,
                send_date: Date.now()
            };

            // Insert memories at the specified position from the end
            const insertIndex = Math.max(0, chat.length - settings.memoryPosition);
            chat.splice(insertIndex, 0, memoryEntry);

            if (settings.debugMode) {
                console.log(`[Qdrant Memory] Injected ${memories.length} memories at position ${insertIndex}`);
            }

            if (settings.showMemoryNotifications) {
                toastr.info(`Retrieved ${memories.length} relevant memories`, 'Qdrant Memory', { timeOut: 2000 });
            }
        } else {
            if (settings.debugMode) {
                console.log('[Qdrant Memory] No relevant memories found');
            }
        }
    } catch (error) {
        console.error('[Qdrant Memory] Error in generation interceptor:', error);
    }
};

// ============================================================================
// AUTOMATIC MEMORY CREATION
// ============================================================================

function onMessageSent() {
    if (!settings.autoSaveMemories) return;
    
    try {
        const context = getContext();
        const chat = context.chat || [];
        const characterName = context.name2;

        if (!characterName || chat.length === 0) return;

        // Get the last message
        const lastMessage = chat[chat.length - 1];
        
        // Create a unique ID for this message
        const messageId = `${characterName}_${lastMessage.send_date}_${chat.length}`;

        // Queue the message for saving (queue handles deduplication)
        if (lastMessage.mes && lastMessage.mes.trim().length > 0) {
            const isUser = lastMessage.is_user || false;
            queueMessage(lastMessage.mes, characterName, isUser, messageId);
        }
    } catch (error) {
        console.error('[Qdrant Memory] Error in onMessageSent:', error);
    }
}

// ============================================================================
// MEMORY VIEWER FUNCTIONS
// ============================================================================

async function getCollectionInfo(collectionName) {
    try {
        const response = await fetch(`${settings.qdrantUrl}/collections/${collectionName}`);
        if (response.ok) {
            const data = await response.json();
            return data.result;
        }
        return null;
    } catch (error) {
        console.error('[Qdrant Memory] Error getting collection info:', error);
        return null;
    }
}

async function deleteCollection(collectionName) {
    try {
        const response = await fetch(`${settings.qdrantUrl}/collections/${collectionName}`, {
            method: 'DELETE'
        });
        return response.ok;
    } catch (error) {
        console.error('[Qdrant Memory] Error deleting collection:', error);
        return false;
    }
}

async function showMemoryViewer() {
    const context = getContext();
    const characterName = context.name2;
    
    if (!characterName) {
        toastr.warning('No character selected', 'Qdrant Memory');
        return;
    }
    
    const collectionName = getCollectionName(characterName);
    const info = await getCollectionInfo(collectionName);
    
    if (!info) {
        toastr.warning(`No memories found for ${characterName}`, 'Qdrant Memory');
        return;
    }
    
    const count = info.points_count || 0;
    const vectors = info.vectors_count || 0;
    
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
    `;
    
    $('body').append(modalHtml);
    
    // Close modal
    $('#qdrant_close_modal, #qdrant_overlay').on('click', function() {
        $('#qdrant_modal').remove();
        $('#qdrant_overlay').remove();
    });
    
    // Delete collection
    $('#qdrant_delete_collection_btn').on('click', async function() {
        const confirmed = confirm(`Are you sure you want to delete ALL memories for ${characterName}? This cannot be undone!`);
        if (confirmed) {
            $(this).prop('disabled', true).text('Deleting...');
            const success = await deleteCollection(collectionName);
            if (success) {
                toastr.success(`All memories deleted for ${characterName}`, 'Qdrant Memory');
                $('#qdrant_modal').remove();
                $('#qdrant_overlay').remove();
            } else {
                toastr.error('Failed to delete memories', 'Qdrant Memory');
                $(this).prop('disabled', false).text('Delete All Memories');
            }
        }
    });
}

// Create settings UI
function createSettingsUI() {
    const settingsHtml = `
        <div class="qdrant-memory-settings">
            <h3>Qdrant Memory Extension v3.0</h3>
            <p style="margin: 10px 0; color: #666; font-size: 0.9em;">
                Automatic memory creation with per-character collections
            </p>
            
            <div style="margin: 15px 0;">
                <label style="display: flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="qdrant_enabled" ${settings.enabled ? 'checked' : ''} />
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
                    <option value="text-embedding-3-large" ${settings.embeddingModel === 'text-embedding-3-large' ? 'selected' : ''}>text-embedding-3-large (best quality)</option>
                    <option value="text-embedding-3-small" ${settings.embeddingModel === 'text-embedding-3-small' ? 'selected' : ''}>text-embedding-3-small (faster)</option>
                    <option value="text-embedding-ada-002" ${settings.embeddingModel === 'text-embedding-ada-002' ? 'selected' : ''}>text-embedding-ada-002 (legacy)</option>
                </select>
            </div>
            
            <hr style="margin: 15px 0;" />
            
            <h4>Memory Retrieval Settings</h4>
            
            <div style="margin: 10px 0;">
                <label><strong>Number of Memories:</strong> <span id="memory_limit_display">${settings.memoryLimit}</span></label>
                <input type="range" id="qdrant_memory_limit" min="1" max="10" value="${settings.memoryLimit}" 
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
                <input type="range" id="qdrant_memory_position" min="1" max="10" value="${settings.memoryPosition}" 
                       style="width: 100%; margin-top: 5px;" />
                <small style="color: #666;">How many messages from the end to insert memories</small>
            </div>
            
            <hr style="margin: 15px 0;" />
            
            <h4>Automatic Memory Creation</h4>
            
            <div style="margin: 10px 0;">
                <label style="display: flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="qdrant_per_character" ${settings.usePerCharacterCollections ? 'checked' : ''} />
                    <strong>Use Per-Character Collections</strong>
                </label>
                <small style="color: #666; display: block; margin-left: 30px;">Each character gets their own dedicated collection (recommended)</small>
            </div>
            
            <div style="margin: 10px 0;">
                <label style="display: flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="qdrant_auto_save" ${settings.autoSaveMemories ? 'checked' : ''} />
                    <strong>Automatically Save Memories</strong>
                </label>
                <small style="color: #666; display: block; margin-left: 30px;">Save messages to Qdrant as conversations happen</small>
            </div>
            
            <div style="margin: 10px 0;">
                <label style="display: flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="qdrant_save_user" ${settings.saveUserMessages ? 'checked' : ''} />
                    Save user messages
                </label>
            </div>
            
            <div style="margin: 10px 0;">
                <label style="display: flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="qdrant_save_character" ${settings.saveCharacterMessages ? 'checked' : ''} />
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
            
            <div style="margin: 10px 0;">
                <label style="display: flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="qdrant_notifications" ${settings.showMemoryNotifications ? 'checked' : ''} />
                    Show memory notifications
                </label>
            </div>
            
            <div style="margin: 10px 0;">
                <label style="display: flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="qdrant_debug" ${settings.debugMode ? 'checked' : ''} />
                    Debug Mode (check console)
                </label>
            </div>
            
            <hr style="margin: 15px 0;" />
            
            <div style="margin: 15px 0; display: flex; gap: 10px; flex-wrap: wrap;">
                <button id="qdrant_test" class="menu_button">Test Connection</button>
                <button id="qdrant_save" class="menu_button">Save Settings</button>
                <button id="qdrant_view_memories" class="menu_button">View Memories</button>
            </div>
            
            <div id="qdrant_status" style="margin-top: 10px; padding: 10px; border-radius: 5px;"></div>
        </div>
    `;

    $('#extensions_settings2').append(settingsHtml);

    // Event handlers
    $('#qdrant_enabled').on('change', function() {
        settings.enabled = $(this).is(':checked');
    });

    $('#qdrant_url').on('input', function() {
        settings.qdrantUrl = $(this).val();
    });

    $('#qdrant_collection').on('input', function() {
        settings.collectionName = $(this).val();
    });

    $('#qdrant_openai_key').on('input', function() {
        settings.openaiApiKey = $(this).val();
    });

    $('#qdrant_embedding_model').on('change', function() {
        settings.embeddingModel = $(this).val();
    });

    $('#qdrant_memory_limit').on('input', function() {
        settings.memoryLimit = parseInt($(this).val());
        $('#memory_limit_display').text(settings.memoryLimit);
    });

    $('#qdrant_score_threshold').on('input', function() {
        settings.scoreThreshold = parseFloat($(this).val());
        $('#score_threshold_display').text(settings.scoreThreshold);
    });

    $('#qdrant_memory_position').on('input', function() {
        settings.memoryPosition = parseInt($(this).val());
        $('#memory_position_display').text(settings.memoryPosition);
    });

    $('#qdrant_per_character').on('change', function() {
        settings.usePerCharacterCollections = $(this).is(':checked');
    });

    $('#qdrant_auto_save').on('change', function() {
        settings.autoSaveMemories = $(this).is(':checked');
    });

    $('#qdrant_save_user').on('change', function() {
        settings.saveUserMessages = $(this).is(':checked');
    });

    $('#qdrant_save_character').on('change', function() {
        settings.saveCharacterMessages = $(this).is(':checked');
    });

    $('#qdrant_min_length').on('input', function() {
        settings.minMessageLength = parseInt($(this).val());
        $('#min_message_length_display').text(settings.minMessageLength);
    });

    $('#qdrant_notifications').on('change', function() {
        settings.showMemoryNotifications = $(this).is(':checked');
    });

    $('#qdrant_debug').on('change', function() {
        settings.debugMode = $(this).is(':checked');
    });

    $('#qdrant_save').on('click', function() {
        saveSettings();
        $('#qdrant_status').text('✓ Settings saved!').css({'color': 'green', 'background': '#d4edda', 'border': '1px solid green'});
        setTimeout(() => $('#qdrant_status').text('').css({'background': '', 'border': ''}), 3000);
    });

    $('#qdrant_test').on('click', async function() {
        $('#qdrant_status').text('Testing connection...').css({'color': '#004085', 'background': '#cce5ff', 'border': '1px solid #004085'});
        
        try {
            const response = await fetch(`${settings.qdrantUrl}/collections`);
            
            if (response.ok) {
                const data = await response.json();
                const collections = data.result?.collections || [];
                $('#qdrant_status').text(`✓ Connected! Found ${collections.length} collections.`).css({'color': 'green', 'background': '#d4edda', 'border': '1px solid green'});
            } else {
                $('#qdrant_status').text('✗ Connection failed. Check URL.').css({'color': '#721c24', 'background': '#f8d7da', 'border': '1px solid #721c24'});
            }
        } catch (error) {
            $('#qdrant_status').text(`✗ Error: ${error.message}`).css({'color': '#721c24', 'background': '#f8d7da', 'border': '1px solid #721c24'});
        }
    });

    $('#qdrant_view_memories').on('click', function() {
        showMemoryViewer();
    });
}

// Extension initialization
jQuery(async () => {
    loadSettings();
    createSettingsUI();
    
    // Hook into message events for automatic saving
    if (typeof eventSource !== 'undefined' && eventSource.on) {
        eventSource.on('MESSAGE_RECEIVED', onMessageSent);
        eventSource.on('USER_MESSAGE_RENDERED', onMessageSent);
        console.log('[Qdrant Memory] Using eventSource hooks');
    } else {
        // Fallback: poll for new messages
        console.log('[Qdrant Memory] Using polling fallback for auto-save');
        let lastChatLength = 0;
        setInterval(() => {
            if (!settings.autoSaveMemories) return;
            const context = getContext();
            const chat = context.chat || [];
            if (chat.length > lastChatLength) {
                lastChatLength = chat.length;
                onMessageSent();
            }
        }, 2000);
    }
    
    console.log('[Qdrant Memory] Extension loaded successfully (v3.0.0 - per-character collections + auto-save)');
});

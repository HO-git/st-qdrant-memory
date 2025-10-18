// Qdrant Memory Extension for SillyTavern
// This extension retrieves relevant memories from Qdrant and injects them into conversations

const extensionName = 'qdrant-memory';
const extensionFolderPath = `scripts/extensions/third-party/${extensionName}`;

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
    debugMode: false
};

let settings = { ...defaultSettings };

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
            console.error('[Qdrant Memory] OpenAI API error:', response.statusText);
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
        const embedding = await generateEmbedding(query);
        if (!embedding) return [];

        const searchPayload = {
            vector: embedding,
            limit: settings.memoryLimit,
            score_threshold: settings.scoreThreshold,
            filter: {
                must: [
                    {
                        key: 'character',
                        match: { value: characterName }
                    }
                ]
            },
            with_payload: true
        };

        const response = await fetch(`${settings.qdrantUrl}/collections/${settings.collectionName}/points/search`, {
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

// Hook into chat to add memories
let lastProcessedLength = 0;  // ADD THIS LINE BEFORE THE FUNCTION

async function onMessageSent() {
    if (!settings.enabled) return;
    
    const context = getContext();
    const chat = context.chat || [];
    
    // Only process if chat actually grew (new message added)
    if (chat.length <= lastProcessedLength) return;
    lastProcessedLength = chat.length;
    
    // Skip if last message is from us
    const lastMsg = chat[chat.length - 1];
    if (lastMsg?.extra?.isQdrantMemory) return;

    try {
        const characterName = context.name2;

        if (!chat || chat.length === 0 || !characterName) {
            if (settings.debugMode) {
                console.log('[Qdrant Memory] No chat or character found');
            }
            return;
        }

        const lastUserMsg = chat.slice().reverse().find(msg => msg.is_user);
        if (!lastUserMsg || !lastUserMsg.mes) return;

        const query = lastUserMsg.mes;

        if (settings.debugMode) {
            console.log('[Qdrant Memory] Searching for:', query);
            console.log('[Qdrant Memory] Character:', characterName);
        }

        const memories = await searchMemories(query, characterName);

        if (memories.length > 0) {
            const memoryText = formatMemories(memories);
            
            if (settings.debugMode) {
                console.log('[Qdrant Memory] Retrieved memories:', memoryText);
            }

            const memoryEntry = {
                name: 'System',
                is_user: false,
                is_system: true,
                mes: memoryText,
                send_date: new Date().toISOString(),
                extra: { isQdrantMemory: true }
            };

            const insertIndex = Math.max(0, chat.length - settings.memoryPosition);
            chat.splice(insertIndex, 0, memoryEntry);

            toastr.info(`Retrieved ${memories.length} relevant memories`, 'Qdrant Memory');
        }
    } catch (error) {
        console.error('[Qdrant Memory] Error in onMessageSent:', error);
    }
}

// Create settings UI
function createSettingsUI() {
    const settingsHtml = `
        <div class="qdrant-memory-settings">
            <h3>Qdrant Memory Extension</h3>
            <div style="margin: 15px 0;">
                <label style="display: flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="qdrant_enabled" ${settings.enabled ? 'checked' : ''} />
                    <strong>Enable Qdrant Memory</strong>
                </label>
            </div>
            
            <div style="margin: 10px 0;">
                <label><strong>Qdrant URL:</strong></label>
                <input type="text" id="qdrant_url" class="text_pole" value="${settings.qdrantUrl}" 
                       style="width: 100%; margin-top: 5px;" />
            </div>
            
            <div style="margin: 10px 0;">
                <label><strong>Collection Name:</strong></label>
                <input type="text" id="qdrant_collection" class="text_pole" value="${settings.collectionName}" 
                       style="width: 100%; margin-top: 5px;" />
            </div>
            
            <div style="margin: 10px 0;">
                <label><strong>OpenAI API Key:</strong></label>
                <input type="password" id="qdrant_openai_key" class="text_pole" value="${settings.openaiApiKey}" 
                       placeholder="sk-..." style="width: 100%; margin-top: 5px;" />
            </div>
            
            <div style="margin: 10px 0;">
                <label><strong>Embedding Model:</strong></label>
                <select id="qdrant_embedding_model" class="text_pole" style="width: 100%; margin-top: 5px;">
                    <option value="text-embedding-3-large" ${settings.embeddingModel === 'text-embedding-3-large' ? 'selected' : ''}>text-embedding-3-large</option>
                    <option value="text-embedding-3-small" ${settings.embeddingModel === 'text-embedding-3-small' ? 'selected' : ''}>text-embedding-3-small</option>
                    <option value="text-embedding-ada-002" ${settings.embeddingModel === 'text-embedding-ada-002' ? 'selected' : ''}>text-embedding-ada-002</option>
                </select>
            </div>
            
            <div style="margin: 10px 0;">
                <label><strong>Number of Memories:</strong> <span id="memory_limit_display">${settings.memoryLimit}</span></label>
                <input type="range" id="qdrant_memory_limit" min="1" max="10" value="${settings.memoryLimit}" 
                       style="width: 100%; margin-top: 5px;" />
            </div>
            
            <div style="margin: 10px 0;">
                <label><strong>Relevance Threshold:</strong> <span id="score_threshold_display">${settings.scoreThreshold}</span></label>
                <input type="range" id="qdrant_score_threshold" min="0" max="1" step="0.05" value="${settings.scoreThreshold}" 
                       style="width: 100%; margin-top: 5px;" />
            </div>
            
            <div style="margin: 10px 0;">
                <label style="display: flex; align-items: center; gap: 10px;">
                    <input type="checkbox" id="qdrant_debug" ${settings.debugMode ? 'checked' : ''} />
                    Debug Mode (check console)
                </label>
            </div>
            
            <div style="margin: 15px 0; display: flex; gap: 10px;">
                <button id="qdrant_test" class="menu_button">Test Connection</button>
                <button id="qdrant_save" class="menu_button">Save Settings</button>
            </div>
            
            <div id="qdrant_status" style="margin-top: 10px; padding: 10px; border-radius: 5px;"></div>
        </div>
    `;

    $('#extensions_settings2').append(settingsHtml);

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
            const response = await fetch(`${settings.qdrantUrl}/collections/${settings.collectionName}`);
            
            if (response.ok) {
                const data = await response.json();
                const count = data.result?.points_count || 0;
                $('#qdrant_status').text(`✓ Connected! Collection has ${count} memories.`).css({'color': 'green', 'background': '#d4edda', 'border': '1px solid green'});
            } else {
                $('#qdrant_status').text('✗ Connection failed. Check URL and collection name.').css({'color': '#721c24', 'background': '#f8d7da', 'border': '1px solid #721c24'});
            }
        } catch (error) {
            $('#qdrant_status').text(`✗ Error: ${error.message}`).css({'color': '#721c24', 'background': '#f8d7da', 'border': '1px solid #721c24'});
        }
    });
}

jQuery(async () => {
    loadSettings();
    createSettingsUI();

    
if (typeof eventSource !== 'undefined') {
    eventSource.on('MESSAGE_SENT', onMessageSent);
    eventSource.on('CHAT_CHANGED', onMessageSent);
} else {
    // fallback only if eventSource doesn't exist
    let lastChatLength = 0;
    setInterval(() => {
        if (!settings.enabled) return;
        const context = getContext();
        const chat = context.chat || [];
        if (chat.length > lastChatLength) {
            lastChatLength = chat.length;
            onMessageSent();
        }
    }, 2000);
}


    console.log('[Qdrant Memory] Extension loaded successfully');
});

// Qdrant Memory Extension for SillyTavern
// This extension retrieves relevant memories from Qdrant and injects them into conversations

import { eventSource, event_types } from '../../../script.js';
import { getContext, saveSettingsDebounced } from '../../../extensions.js';
import { OpenAI } from 'openai';

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
    includeInPrompt: true,
    memoryPosition: 'after_character', // 'after_character', 'before_user', 'system'
    debugMode: false
};

let settings = { ...defaultSettings };
let openaiClient = null;

// Initialize OpenAI client
function initOpenAI() {
    if (settings.openaiApiKey) {
        openaiClient = new OpenAI({
            apiKey: settings.openaiApiKey,
            dangerouslyAllowBrowser: true
        });
    }
}

// Generate embedding for a query
async function generateEmbedding(text) {
    if (!openaiClient) {
        console.error('[Qdrant Memory] OpenAI client not initialized');
        return null;
    }

    try {
        const response = await openaiClient.embeddings.create({
            model: settings.embeddingModel,
            input: text
        });
        return response.data[0].embedding;
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

// Format memories for injection into prompt
function formatMemories(memories) {
    if (!memories || memories.length === 0) return '';

    let formatted = '\n\n--- Relevant Past Memories ---\n';
    
    memories.forEach((memory, index) => {
        const payload = memory.payload;
        const score = (memory.score * 100).toFixed(1);
        
        formatted += `\nMemory ${index + 1} (relevance: ${score}%):\n`;
        formatted += `[${payload.speaker}]: ${payload.text}\n`;
    });
    
    formatted += '--- End of Memories ---\n\n';
    
    return formatted;
}

// Hook into message generation
async function onChatChanged() {
    if (!settings.enabled || !settings.includeInPrompt) return;

    const context = getContext();
    const chat = context.chat;
    const characterName = context.name2;

    if (!chat || chat.length === 0) return;

    // Get the last user message
    const lastUserMessage = chat.slice().reverse().find(msg => msg.is_user);
    if (!lastUserMessage) return;

    const query = lastUserMessage.mes;

    if (settings.debugMode) {
        console.log('[Qdrant Memory] Searching memories for:', query);
        console.log('[Qdrant Memory] Character:', characterName);
    }

    // Search for relevant memories
    const memories = await searchMemories(query, characterName);

    if (memories.length > 0) {
        const memoryText = formatMemories(memories);
        
        if (settings.debugMode) {
            console.log('[Qdrant Memory] Injecting memories:', memoryText);
        }

        // Inject memories based on position setting
        // This will be added to the prompt through SillyTavern's context
        context.setExtensionPrompt(extensionName, memoryText, settings.memoryPosition);
    }
}

// Load settings
function loadSettings() {
    if (localStorage.getItem(extensionName) !== null) {
        settings = JSON.parse(localStorage.getItem(extensionName));
    }
    
    // Ensure all default settings exist
    settings = { ...defaultSettings, ...settings };
    
    initOpenAI();
}

// Save settings
function saveSettings() {
    localStorage.setItem(extensionName, JSON.stringify(settings));
    saveSettingsDebounced();
}

// Create settings UI
function createSettingsUI() {
    const settingsHtml = `
        <div class="qdrant-memory-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Qdrant Memory Settings</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label for="qdrant_enabled">
                        <input type="checkbox" id="qdrant_enabled" ${settings.enabled ? 'checked' : ''} />
                        Enable Qdrant Memory
                    </label>
                    
                    <label for="qdrant_url">Qdrant URL:</label>
                    <input type="text" id="qdrant_url" class="text_pole" value="${settings.qdrantUrl}" />
                    
                    <label for="qdrant_collection">Collection Name:</label>
                    <input type="text" id="qdrant_collection" class="text_pole" value="${settings.collectionName}" />
                    
                    <label for="qdrant_openai_key">OpenAI API Key:</label>
                    <input type="password" id="qdrant_openai_key" class="text_pole" value="${settings.openaiApiKey}" />
                    
                    <label for="qdrant_embedding_model">Embedding Model:</label>
                    <select id="qdrant_embedding_model" class="text_pole">
                        <option value="text-embedding-3-large" ${settings.embeddingModel === 'text-embedding-3-large' ? 'selected' : ''}>text-embedding-3-large</option>
                        <option value="text-embedding-3-small" ${settings.embeddingModel === 'text-embedding-3-small' ? 'selected' : ''}>text-embedding-3-small</option>
                        <option value="text-embedding-ada-002" ${settings.embeddingModel === 'text-embedding-ada-002' ? 'selected' : ''}>text-embedding-ada-002</option>
                    </select>
                    
                    <label for="qdrant_memory_limit">Number of Memories to Retrieve:</label>
                    <input type="number" id="qdrant_memory_limit" class="text_pole" value="${settings.memoryLimit}" min="1" max="20" />
                    
                    <label for="qdrant_score_threshold">Relevance Threshold (0-1):</label>
                    <input type="number" id="qdrant_score_threshold" class="text_pole" value="${settings.scoreThreshold}" min="0" max="1" step="0.05" />
                    
                    <label for="qdrant_memory_position">Memory Injection Position:</label>
                    <select id="qdrant_memory_position" class="text_pole">
                        <option value="after_character" ${settings.memoryPosition === 'after_character' ? 'selected' : ''}>After Character Card</option>
                        <option value="before_user" ${settings.memoryPosition === 'before_user' ? 'selected' : ''}>Before User Message</option>
                        <option value="system" ${settings.memoryPosition === 'system' ? 'selected' : ''}>System Prompt</option>
                    </select>
                    
                    <label for="qdrant_debug">
                        <input type="checkbox" id="qdrant_debug" ${settings.debugMode ? 'checked' : ''} />
                        Debug Mode (console logging)
                    </label>
                    
                    <div class="qdrant-memory-buttons">
                        <button id="qdrant_test" class="menu_button">Test Connection</button>
                        <button id="qdrant_save" class="menu_button">Save Settings</button>
                    </div>
                    
                    <div id="qdrant_status" class="qdrant-status"></div>
                </div>
            </div>
        </div>
    `;

    $('#extensions_settings2').append(settingsHtml);

    // Bind event handlers
    $('#qdrant_enabled').on('change', function() {
        settings.enabled = $(this).is(':checked');
        saveSettings();
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
    });

    $('#qdrant_score_threshold').on('input', function() {
        settings.scoreThreshold = parseFloat($(this).val());
    });

    $('#qdrant_memory_position').on('change', function() {
        settings.memoryPosition = $(this).val();
    });

    $('#qdrant_debug').on('change', function() {
        settings.debugMode = $(this).is(':checked');
        saveSettings();
    });

    $('#qdrant_save').on('click', function() {
        saveSettings();
        initOpenAI();
        $('#qdrant_status').text('Settings saved!').css('color', 'green');
        setTimeout(() => $('#qdrant_status').text(''), 3000);
    });

    $('#qdrant_test').on('click', async function() {
        $('#qdrant_status').text('Testing connection...').css('color', 'blue');
        
        try {
            const response = await fetch(`${settings.qdrantUrl}/collections/${settings.collectionName}`);
            
            if (response.ok) {
                const data = await response.json();
                const count = data.result?.points_count || 0;
                $('#qdrant_status').text(`✓ Connected! Collection has ${count} memories.`).css('color', 'green');
            } else {
                $('#qdrant_status').text('✗ Connection failed. Check URL and collection name.').css('color', 'red');
            }
        } catch (error) {
            $('#qdrant_status').text(`✗ Error: ${error.message}`).css('color', 'red');
        }
    });
}

// Initialize extension
jQuery(async () => {
    loadSettings();
    createSettingsUI();

    // Hook into chat events
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.MESSAGE_SENT, onChatChanged);

    console.log('[Qdrant Memory] Extension loaded');
});

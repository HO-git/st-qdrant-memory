# Qdrant Memory Extension for SillyTavern

A SillyTavern extension that provides long-term memory capabilities by integrating with Qdrant vector database. The extension automatically saves conversations and retrieves semantically relevant memories during chat generation.

>#### Exporting ChatGPT chats to SillyTavern companion guide: https://rentry.org/STGPTimport

<img width="438" height="873" alt="Screenshot 2025-10-31 at 3 18 19 PM" src="https://github.com/user-attachments/assets/946a7d89-c0ad-41e6-b9ff-35f99b411aa8" />




## Version 3.0.0 - Major Update

### New Features

🎯 **Per-Character Collections**: Each character gets their own dedicated Qdrant collection for complete memory isolation  
💾 **Automatic Memory Creation**: Conversations are automatically saved to Qdrant as they happen  
👁️ **Memory Viewer**: View and manage stored memories for each character  
⚙️ **Granular Control**: Choose what to save (user messages, character messages, minimum length)

## Features

- **Per-Character Memory Isolation**: Each character has their own collection - no cross-contamination
- **Automatic Conversation Saving**: Messages are saved to Qdrant in real-time with embeddings
- **Semantic Memory Search**: Uses vector embeddings to find contextually relevant past conversations
- **Configurable Auto-Save**: Control which messages get saved (user/character, minimum length)
- **Memory Viewer**: Browse collection stats and delete memories per character
- **Non-Invasive Retrieval**: Memories inject during generation without modifying chat history
- **OpenAI Embeddings**: Supports text-embedding-3-large, text-embedding-3-small, and ada-002
- **Debug Mode**: Detailed console logging for troubleshooting

## Requirements

- **SillyTavern** version 1.11.0 or higher
- **Qdrant** vector database (self-hosted or cloud)
- **OpenAI API key** for generating embeddings

## Installation

### Option 1: Install via UI 

1. Go to Extensions > Install extension, then paste the following Git URL: https://github.com/HO-git/st-qdrant-memory
2. Reload SillyTavern
3. Enable "Qdrant Memory" in the extensions panel

### Option 2: Install for All Users (Recommended for Development)

1. Navigate to your SillyTavern installation directory
2. Copy the `qdrant-memory` folder to `public/scripts/extensions/third-party/`
3. Restart SillyTavern
4. Go to Extensions > Extension Settings
5. Enable "Qdrant Memory"

### Option 3: Install for Current User

1. In SillyTavern, go to Extensions > Install Extension
2. Upload or point to the `qdrant-memory` folder
3. The extension will be installed to `data/<user-handle>/extensions/`
4. Enable "Qdrant Memory" in the extensions panel

## Setup

### 1. Set Up Qdrant Database

You need a running Qdrant instance. Options:

**VPS/Local Docker:**
```bash
docker run -p 6333:6333 qdrant/qdrant
```

Qdrant Cloud not supported at the moment due to CORS block

### 2. Configure Extension

In SillyTavern:

1. Go to **Extensions** → **Qdrant Memory**
2. Enter your **Qdrant URL** (e.g., `http://localhost:6333`)
3. Enter your **Base Collection Name** (e.g., `sillytavern_memories`)
4. Enter your **OpenAI API Key**
5. Select your **Embedding Model** (recommended: text-embedding-3-large)
6. Enable **Use Per-Character Collections** (recommended)
7. Enable **Automatically Save Memories**
8. Click **Test Connection** to verify setup
9. Click **Save Settings**

### 3. Start Chatting!

Once configured:
- **Automatic Saving**: Every message is automatically saved to the character's collection
- **Automatic Retrieval**: Relevant memories are retrieved before each generation
- **No Manual Work**: Collections are created automatically as needed

## How It Works

### Per-Character Collections

When **Use Per-Character Collections** is enabled:

- Each character gets a dedicated collection: `sillytavern_memories_charactername`
- Memories are completely isolated - characters can't access each other's data
- Collections are automatically created when first needed
- Better performance (smaller, focused collections)

**Example:**
- Character "Alice" → Collection: `sillytavern_memories_alice`
- Character "Bob" → Collection: `sillytavern_memories_bob`

### Automatic Memory Creation

When **Automatically Save Memories** is enabled:

1. **User sends message** → Saved to Qdrant with embedding
2. **Character responds** → Also saved to Qdrant with embedding
3. **Next conversation** → Previous messages are searchable

Each saved memory includes:
- **Text**: The message content
- **Speaker**: "user" or "character"  
- **Character**: Character name
- **Timestamp**: When the message was sent
- **Embedding**: Vector representation for semantic search

### Memory Retrieval

During generation:

1. **User sends new message**
2. **Extension generates embedding** for the message
3. **Searches character's collection** for similar past messages
4. **Top N relevant memories** are retrieved (based on similarity score)
5. **Memories injected** into the prompt before generation
6. **LLM generates response** with historical context

## Configuration Options

### Connection Settings

| Setting | Description | Default |
|---------|-------------|---------|
| **Qdrant URL** | URL of your Qdrant instance | `http://localhost:6333` |
| **Base Collection Name** | Base name for collections | `sillytavern_memories` |
| **OpenAI API Key** | Your OpenAI API key | (empty) |
| **Embedding Model** | Model for embeddings | `text-embedding-3-large` |

### Memory Retrieval Settings

| Setting | Description | Default |
|---------|-------------|---------|
| **Number of Memories** | Max memories to retrieve (1-10) | `5` |
| **Relevance Threshold** | Minimum similarity score (0.0-1.0) | `0.3` |
| **Memory Position** | Messages from end to insert at | `2` |

### Automatic Memory Creation

| Setting | Description | Default |
|---------|-------------|---------|
| **Use Per-Character Collections** | Separate collection per character | `true` |
| **Automatically Save Memories** | Auto-save messages to Qdrant | `true` |
| **Save User Messages** | Include user messages | `true` |
| **Save Character Messages** | Include character responses | `true` |
| **Minimum Message Length** | Min characters to save (5-50) | `10` |

### Other Settings

| Setting | Description | Default |
|---------|-------------|---------|
| **Show Memory Notifications** | Display toastr notifications | `true` |
| **Debug Mode** | Enable console logging | `false` |

## Memory Viewer

Access the memory viewer to see what's stored:

1. Click **View Memories** in extension settings
2. Shows collection info for current character
3. Displays total memory count
4. Option to **Delete All Memories** for the character

## Troubleshooting

### No memories are being saved

- Check **Debug Mode** and inspect browser console
- Verify **Auto-Save Memories** is enabled
- Check message length meets **Minimum Message Length** setting
- Ensure **OpenAI API Key** is valid and has credits
- Verify Qdrant is accessible at the configured URL

### No memories are retrieved

- Lower the **Relevance Threshold** to allow less similar matches
- Ensure the character has saved memories (check Memory Viewer)
- Verify **Use Per-Character Collections** matches your setup
- Check that collections exist in Qdrant

### Collections not being created

- Check browser console for errors
- Verify Qdrant URL is correct and accessible
- Ensure embedding model is configured correctly
- Check Qdrant has write permissions

### OpenAI API errors

- Verify API key is correct
- Check you have credits available
- Ensure embedding model is available in your account
- Check rate limits haven't been exceeded

### Extension not loading

- Check browser console for errors
- Verify SillyTavern version is 1.11.0+
- Ensure `manifest.json` is valid JSON
- Restart SillyTavern after installation

## Migration from v2.0

### If You Used Shared Collections

v2.0 used a single shared collection with character filtering. v3.0 uses per-character collections by default.

**Option A: Start Fresh**
- Enable **Use Per-Character Collections**
- New conversations will auto-populate character collections
- Old shared collection remains unchanged

**Option B: Keep Shared Collection**
- Disable **Use Per-Character Collections**
- Extension will continue using the shared collection with character filters
- Less isolation but maintains existing data

**Option C: Manual Migration**
- Export memories from shared collection
- Import into per-character collections
- Requires custom scripting (see Qdrant docs)

## Performance Considerations

### API Costs

With auto-save enabled, each message generates:
- **1 embedding API call** (OpenAI)
- **1 vector insert** (Qdrant)
- **1 vector search during generation** (Qdrant)

**Typical costs per 1000 messages (text-embedding-3-large):**
- Embedding generation: ~$0.13
- Qdrant: Free for self-hosted, varies for cloud

### Speed

- **Embedding generation**: ~100-500ms per message
- **Vector insert**: ~10-50ms
- **Vector search**: ~10-50ms
- **Total overhead**: ~200-600ms per message

### Collection Size

- Each message: ~3KB (embedding) + payload
- 1000 messages: ~3MB
- 10,000 messages: ~30MB
- 100,000 messages: ~300MB

Per-character collections keep sizes manageable and searches fast.

## Technical Details

### Generation Interceptor Pattern

The extension uses SillyTavern's `generate_interceptor` hook to inject memories before API calls:

1. User sends message
2. ST prepares generation request
3. **Extension's interceptor runs**
4. Memories retrieved and inserted into chat array
5. Modified chat sent to LLM
6. Response generated with memory context

This prevents looping issues and keeps memories out of permanent history.

### Collection Naming

Character names are sanitized for collection names:
- Converted to lowercase
- Special characters replaced with underscores
- Multiple underscores collapsed
- Leading/trailing underscores removed

**Examples:**
- "Alice" → `sillytavern_memories_alice`
- "Dr. Smith" → `sillytavern_memories_dr_smith`
- "Neko-chan!" → `sillytavern_memories_neko_chan`

### Automatic Collection Creation

Collections are created on-demand with:
- **Vector size**: Based on embedding model (3072 or 1536 dimensions)
- **Distance metric**: Cosine similarity
- **No explicit schema**: Qdrant handles dynamic payloads

## Future Enhancements

Potential improvements:

- **Embedding caching** to reduce API calls
- **Memory importance scoring** based on recency
- **Advanced memory browser** with search and filtering
- **Batch import/export** tools
- **Multiple embedding providers** (Cohere, local models)
- **Memory summarization** for long conversations
- **Automatic cleanup** of old/irrelevant memories

## License

This extension is open-source. Check the repository for license details.

## Support

For issues, feature requests, or contributions:
- Check the browser console with Debug Mode enabled
- Review this README for troubleshooting steps
- Visit the SillyTavern community for support

## Credits

- Original concept: Community
- v2.0.0: Fixed looping with generation interceptor
- v3.0.0: Per-character collections and auto-save
- Built for SillyTavern by the community

---

**Version**: 3.0.0  
**Last Updated**: October 2025  
**Minimum SillyTavern**: 1.11.0

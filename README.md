# Qdrant Memory Extension for SillyTavern

A SillyTavern extension that retrieves relevant memories from a Qdrant vector database and injects them into conversations before generation. This provides long-term memory capabilities by using semantic search to find and recall past conversation snippets.

## Version 2.0.0 - Fixed Looping Issue

This version uses SillyTavern's **generation interceptor** pattern, which injects memories **before** messages are sent to the LLM, rather than modifying the chat history afterward. This eliminates the looping problem present in earlier versions.

## Features

- **Semantic Memory Search**: Uses vector embeddings to find contextually relevant past conversations
- **Character-Specific Memories**: Memories are filtered by character for accurate recall
- **Configurable Relevance**: Adjust similarity threshold and number of memories retrieved
- **Non-Invasive**: Memories are injected during generation without modifying persistent chat history
- **OpenAI Embeddings**: Supports text-embedding-3-large, text-embedding-3-small, and ada-002
- **Debug Mode**: Detailed console logging for troubleshooting

## Requirements

- **SillyTavern** version 1.11.0 or higher
- **Qdrant** vector database (self-hosted or cloud)
- **OpenAI API key** for generating embeddings

## Installation

### Option 1: Install for All Users (Recommended for Development)

1. Navigate to your SillyTavern installation directory
2. Copy the `qdrant-memory` folder to `public/scripts/extensions/third-party/`
3. Restart SillyTavern
4. Go to Extensions > Extension Settings
5. Enable "Qdrant Memory"

### Option 2: Install for Current User

1. In SillyTavern, go to Extensions > Install Extension
2. Upload or point to the `qdrant-memory` folder
3. The extension will be installed to `data/<user-handle>/extensions/`
4. Enable "Qdrant Memory" in the extensions panel

## Setup

### 1. Set Up Qdrant Database

You need a running Qdrant instance. Options:

**Local Docker:**
```bash
docker run -p 6333:6333 qdrant/qdrant
```

**Qdrant Cloud:**
Sign up at [cloud.qdrant.io](https://cloud.qdrant.io)

### 2. Create Collection

Create a collection with the appropriate vector dimensions for your embedding model:

- `text-embedding-3-large`: 3072 dimensions
- `text-embedding-3-small`: 1536 dimensions  
- `text-embedding-ada-002`: 1536 dimensions

**Example using Qdrant API:**
```bash
curl -X PUT 'http://localhost:6333/collections/sillytavern_memories' \
  -H 'Content-Type: application/json' \
  -d '{
    "vectors": {
      "size": 3072,
      "distance": "Cosine"
    }
  }'
```

### 3. Populate Memories

You'll need to populate the Qdrant collection with conversation memories. Each point should have:

**Vector**: Embedding of the conversation text

**Payload**:
```json
{
  "character": "Character Name",
  "speaker": "user" or "character",
  "text": "The conversation snippet",
  "timestamp": 1234567890
}
```

**Example insertion:**
```python
from qdrant_client import QdrantClient
from openai import OpenAI

client = QdrantClient(url="http://localhost:6333")
openai_client = OpenAI(api_key="your-key")

# Generate embedding
response = openai_client.embeddings.create(
    model="text-embedding-3-large",
    input="The conversation text"
)
embedding = response.data[0].embedding

# Insert into Qdrant
client.upsert(
    collection_name="sillytavern_memories",
    points=[{
        "id": 1,
        "vector": embedding,
        "payload": {
            "character": "Alice",
            "speaker": "user",
            "text": "The conversation text",
            "timestamp": 1234567890
        }
    }]
)
```

### 4. Configure Extension

In SillyTavern:

1. Go to **Extensions** → **Qdrant Memory**
2. Enter your **Qdrant URL** (e.g., `http://localhost:6333`)
3. Enter your **Collection Name** (e.g., `sillytavern_memories`)
4. Enter your **OpenAI API Key**
5. Select your **Embedding Model** (must match what you used to create embeddings)
6. Adjust **Number of Memories** (1-10)
7. Adjust **Relevance Threshold** (0.0-1.0, higher = more strict)
8. Adjust **Memory Position** (how many messages from the end to insert)
9. Click **Test Connection** to verify setup
10. Click **Save Settings**

## How It Works

### Generation Interceptor Pattern

When you send a message to the LLM:

1. **User sends message** → SillyTavern prepares to generate a response
2. **Before API call** → Extension's `generate_interceptor` function runs
3. **Memory search** → Last user message is embedded and searched in Qdrant
4. **Memory injection** → Relevant memories are inserted into the chat array
5. **Generation proceeds** → LLM receives chat with injected memories
6. **No persistence** → Memories are NOT saved to chat history

This approach prevents looping because:
- Memories are only added during generation, not to persistent chat
- No events are triggered that could cause re-execution
- Each generation gets fresh memory retrieval based on current context

## Configuration Options

| Setting | Description | Default |
|---------|-------------|---------|
| **Enabled** | Enable/disable the extension | `true` |
| **Qdrant URL** | URL of your Qdrant instance | `http://localhost:6333` |
| **Collection Name** | Name of the Qdrant collection | `sillytavern_memories` |
| **OpenAI API Key** | Your OpenAI API key | (empty) |
| **Embedding Model** | Model for generating embeddings | `text-embedding-3-large` |
| **Number of Memories** | Max memories to retrieve (1-10) | `5` |
| **Relevance Threshold** | Minimum similarity score (0.0-1.0) | `0.3` |
| **Memory Position** | Messages from end to insert at | `2` |
| **Debug Mode** | Enable console logging | `false` |

## Troubleshooting

### No memories are retrieved

- Check **Debug Mode** and inspect the browser console
- Verify your Qdrant collection has data: `GET http://localhost:6333/collections/sillytavern_memories`
- Lower the **Relevance Threshold** to allow less similar matches
- Ensure the **character name** in Qdrant matches exactly (case-sensitive)

### OpenAI API errors

- Verify your API key is correct
- Check you have credits available
- Ensure you selected the correct embedding model

### Connection failed

- Verify Qdrant is running: `curl http://localhost:6333/collections`
- Check the URL is correct (include `http://` or `https://`)
- Ensure no firewall is blocking the connection

### Extension not loading

- Check browser console for errors
- Verify SillyTavern version is 1.11.0+
- Ensure `manifest.json` is valid JSON
- Restart SillyTavern after installation

## Technical Details

### Why Generation Interceptor?

The original approach used event hooks (`MESSAGE_SENT`) which modified the chat array after messages were sent. This caused:

1. Chat modification triggered the same event again
2. Loop detection code was complex and fragile
3. Memories were persisted to chat history

The **generation interceptor** approach:

1. Runs **before** the API call, not after
2. Modifies only the **temporary** chat array sent to the LLM
3. No event loops because nothing triggers new events
4. Cleaner, simpler code

### Memory Format

Memories are displayed as:
```
[Retrieved from past conversations]
• You said: "I love pizza with extra cheese"
• Character said: "I'll remember your pizza preference..."
```

### Performance

- **Embedding generation**: ~100-500ms per query (OpenAI API)
- **Vector search**: ~10-50ms (Qdrant)
- **Total overhead**: ~200-600ms per generation

## Future Enhancements

Potential improvements for future versions:

- **Embedding caching** to reduce API calls
- **Multiple embedding providers** (Cohere, local models, etc.)
- **Memory importance scoring** based on recency
- **Batch memory insertion** for multiple contexts
- **Memory management UI** to view/edit stored memories
- **Automatic memory creation** from conversations
- **Memory summarization** for long snippets

## License

This extension is open-source. Check the repository for license details.

## Support

For issues, feature requests, or contributions, please visit the repository or contact the SillyTavern community.

## Credits

- Original concept: Community
- v2.0.0 refactor: Fixed looping issue using generation interceptor pattern
- Built for SillyTavern by the community

---

**Version**: 2.0.0  
**Last Updated**: 2025  
**Minimum SillyTavern**: 1.11.0

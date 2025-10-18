# Qdrant Memory for SillyTavern

Automatically retrieves relevant memories from Qdrant vector database and injects them into your SillyTavern conversations.

## Features
- Searches past conversations for relevant context
- Filters by character
- Configurable relevance threshold
- Automatic memory injection into prompts

## Requirements
- Qdrant running (locally or remote)
- OpenAI API key for embeddings
- Indexed chat history in Qdrant

## Installation

In SillyTavern:
1. Go to Extensions > Install Extension
2. Enter: `https://github.com/YOUR_USERNAME/st-qdrant-memory`
3. Configure settings in Extensions panel
4. Enable the extension

## Configuration

- **Qdrant URL**: Your Qdrant instance URL
- **Collection Name**: Name of your Qdrant collection
- **OpenAI API Key**: For generating embeddings
- **Memory Limit**: How many memories to retrieve (default: 5)
- **Score Threshold**: Minimum relevance score (0-1, default: 0.3)

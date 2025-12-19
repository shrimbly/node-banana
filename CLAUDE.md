# Node Banana - Development Guide

## Supported Models

### Image Generation Models

The application supports multiple AI image generation providers:

| Model ID | Display Name | Provider | API Model Name |
|----------|--------------|----------|----------------|
| `nano-banana` | Nano Banana | Google Gemini | gemini-2.5-flash-preview-image-generation |
| `nano-banana-pro` | Nano Banana Pro | Google Gemini | gemini-3-pro-image-preview |
| `azure-flux-pro` | Azure FLUX.2 Pro | Microsoft Foundry | FLUX.2-pro (Black Forest Labs) |
| `azure-gpt-image` | Azure GPT Image | Microsoft Foundry | gpt-image-1.5 |

### Environment Variables

- `GEMINI_API_KEY` - Required for Nano Banana models
- `OPENAI_API_KEY` - Optional, for OpenAI LLM provider
- `AZURE_API_KEY` - Required for Azure FLUX.2 Pro
- `AZURE_GPT_IMAGE_API_KEY` - Required for Azure GPT Image

### API Endpoints (in `src/app/api/generate/route.ts`)

- **Gemini**: Uses `@google/genai` SDK
- **Azure FLUX**: `https://<resource>.openai.azure.com/providers/blackforestlabs/v1/flux-2-pro?api-version=preview`
  - Auth: `api-key` header
- **Azure GPT Image**: `https://<resource>.openai.azure.com/openai/v1/images/generations`
  - Auth: `Authorization: Bearer` header



## Node Connection System

### Handle Types

Nodes communicate through typed handles. Each handle has a **data type** that determines what connections are valid.

| Handle Type | Data Format | Description |
|-------------|-------------|-------------|
| `image` | Base64 data URL | Visual content (photos, generated images, annotated images) |
| `text` | String | Text content (user prompts, LLM outputs, transformed text) |

### Connection Rules

1. **Type Matching**: Handles can only connect to handles of the same type
   - `image` → `image` (valid)
   - `text` → `text` (valid)
   - `image` → `text` (invalid)

2. **Direction**: Connections flow from `source` (output) to `target` (input)

3. **Multiplicity**:
   - Image inputs on generation nodes accept multiple connections (for multi-image context)
   - Text inputs accept single connections (last connected wins)

### Data Flow in `getConnectedInputs`

When a node executes, it retrieves connected inputs via `getConnectedInputs(nodeId)` in `workflowStore.ts`. This function returns `{ images: string[], text: string | null }`.

**For `image` handles, extract from:**
- `imageInput` → `data.image`
- `annotation` → `data.outputImage`
- `nanoBanana` → `data.outputImage`

**For `text` handles, extract from:**
- `prompt` → `data.prompt`
- `llmGenerate` → `data.outputText`

### Adding New Node Types

When creating a new node type:

1. **Define the data interface** in `src/types/index.ts`
2. **Add to `NodeType` union** in `src/types/index.ts`
3. **Create default data** in `createDefaultNodeData()` in `workflowStore.ts`
4. **Add dimensions** to `defaultDimensions` in `workflowStore.ts`
5. **Create the component** in `src/components/nodes/`
6. **Export from** `src/components/nodes/index.ts`
7. **Register in nodeTypes** in `WorkflowCanvas.tsx`
8. **Add minimap color** in `WorkflowCanvas.tsx`
9. **Update `getConnectedInputs`** if the node produces output that other nodes consume
10. **Add execution logic** in `executeWorkflow()` if the node requires processing
11. **Update `ConnectionDropMenu.tsx`** to include the node in appropriate source/target lists

### Handle Naming Convention

Use descriptive handle IDs that match the data type:
- `id="image"` for image data
- `id="text"` for text data

Future handle types might include:
- `audio` - for audio data
- `video` - for video data
- `json` - for structured data
- `number` - for numeric values

### Validation

Connection validation happens in `isValidConnection()` in `WorkflowCanvas.tsx`. Update this function if adding new handle types with specific rules.

Workflow validation happens in `validateWorkflow()` in `workflowStore.ts`. Add checks for required inputs on new node types.

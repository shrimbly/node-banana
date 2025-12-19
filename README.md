# Node Banana

> **Note:** This is in early development and hasn't been extensively tested. Use Chrome for best results.

Node Banana is a node-based workflow application for AI image generation. Build image generation pipelines by connecting nodes on a visual canvas.

![Node Banana Screenshot](docs/screenshot.png)

## Features

- **Visual Node Editor** - Drag-and-drop nodes onto an infinite canvas with pan and zoom
- **Image Annotation** - Full-screen editor with drawing tools (rectangles, circles, arrows, freehand, text)
- **Multi-Provider AI Image Generation** - Generate images using:
  - Google Gemini (Nano Banana, Nano Banana Pro)
  - Azure AI Foundry FLUX.2 Pro (Black Forest Labs)
  - Azure AI Foundry GPT Image
- **Text Generation** - Generate text using Google Gemini or OpenAI models
- **Workflow Chaining** - Connect multiple nodes to create complex pipelines
- **Save/Load Workflows** - Export and import workflows as JSON files
- **Node Groups** - Organize nodes into collapsible groups
- **Auto-Save** - Automatically save workflows to disk

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript
- **Node Editor**: @xyflow/react (React Flow)
- **Canvas**: Konva.js / react-konva
- **State Management**: Zustand
- **Styling**: Tailwind CSS

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm (recommended) or npm

### Installation

```bash
# Clone the repository
git clone https://github.com/your-username/node-banana.git
cd node-banana

# Install dependencies
pnpm install
```

### Environment Variables

Copy the example environment file and add your API keys:

```bash
cp .env.local.example .env.local
```

Then edit `.env.local` with your API keys:

```env
# Google Gemini API (for Nano Banana models)
# Get your key from: https://aistudio.google.com/apikey
GEMINI_API_KEY=your_gemini_api_key

# OpenAI API (optional, for OpenAI LLM provider)
# Get your key from: https://platform.openai.com/api-keys
OPENAI_API_KEY=your_openai_api_key

# Azure AI Foundry - FLUX.2 Pro
# Get from Azure AI Foundry portal > Keys and Endpoint
AZURE_API_KEY=your_azure_flux_api_key
AZURE_FLUX_ENDPOINT=https://your-resource.openai.azure.com/providers/blackforestlabs/v1/flux-2-pro?api-version=preview

# Azure AI Foundry - GPT Image
# Get from Azure AI Foundry portal > Keys and Endpoint
AZURE_GPT_IMAGE_API_KEY=your_azure_gpt_image_api_key
AZURE_GPT_IMAGE_ENDPOINT=https://your-resource.openai.azure.com/openai/v1/images/generations
```

> **Note:** You only need to configure the API keys for the models you plan to use.

### Development

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Build

```bash
pnpm build
pnpm start
```

## Supported Models

### Image Generation

| Model | Provider | Description |
|-------|----------|-------------|
| Nano Banana | Google Gemini | gemini-2.5-flash-image - Fast image generation |
| Nano Banana Pro | Google Gemini | gemini-3-pro-image-preview - Higher quality, more options |
| Azure FLUX.2 Pro | Azure AI Foundry | Black Forest Labs FLUX.2 Pro model |
| Azure GPT Image | Azure AI Foundry | GPT-based image generation with quality controls |

### Text Generation (LLM Node)

| Model | Provider |
|-------|----------|
| gemini-2.5-flash | Google |
| gemini-3-pro-preview | Google |
| gpt-4.1-mini | OpenAI |
| gpt-4.1-nano | OpenAI |

## Usage

1. **Add nodes** - Click the floating action bar (+) to add nodes to the canvas
2. **Connect nodes** - Drag from output handles to input handles (matching types only)
3. **Configure nodes** - Adjust settings like model, aspect ratio, quality, or drawing tools
4. **Run workflow** - Click the Run button (▶) to execute the pipeline
5. **Save/Load** - Use the header menu to save or load workflows

### Node Types

| Node | Description |
|------|-------------|
| **Image Input** | Load images from your computer |
| **Annotation** | Draw on images with shapes, arrows, and text |
| **Prompt** | Create text prompts for generation |
| **Generate** | AI image generation with multiple model options |
| **LLM Generate** | AI text generation for dynamic prompts |
| **Output** | Display and export final images |

## Connection Rules

- **Image** handles (left side) connect to **Image** handles only
- **Text** handles (left side) connect to **Text** handles only
- Image inputs on generation nodes accept **multiple connections** (for multi-image context)
- Text inputs accept **single connections**

## Example Workflows

The `/examples` directory contains example workflow files. To try them:

1. Start the dev server with `pnpm dev`
2. Drag any `.json` file from `/examples` into the browser window
3. Review the prompts and adjust as needed
4. Click Run to execute

## Azure AI Foundry Setup

To use Azure models, you need to deploy them in Azure AI Foundry:

1. Go to [Azure AI Foundry](https://ai.azure.com)
2. Create or select a project
3. Navigate to **Model catalog**
4. Deploy **FLUX.2-pro** (Black Forest Labs) and/or **gpt-image-1** (Azure OpenAI)
5. Copy your API keys from **Keys and Endpoint**

### Endpoint Configuration

The Azure endpoints are configured via environment variables. Set them in your `.env.local` file:

```env
AZURE_FLUX_ENDPOINT=https://your-resource.openai.azure.com/providers/blackforestlabs/v1/flux-2-pro?api-version=preview
AZURE_GPT_IMAGE_ENDPOINT=https://your-resource.openai.azure.com/openai/v1/images/generations
```

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## License

MIT

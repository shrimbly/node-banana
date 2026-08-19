<div align="center">

<img width="full" alt="Node Banana" src="public/node-banana.png" />

### An Open Visual Workflow Editor for AI APIs

[![GitHub stars](https://img.shields.io/github/stars/shrimbly/node-banana?style=flat&logo=github)](https://github.com/shrimbly/node-banana/stargazers)
[![License](https://img.shields.io/github/license/shrimbly/node-banana?style=flat)](LICENSE)
[![Discord](https://img.shields.io/badge/Discord-555?logo=discord)](https://discord.com/invite/89Nr6EKkTf)

<br />

Build AI image, 3D, audio and video generation pipelines by connecting nodes on a visual canvas.<br />
Multi-provider support. Dynamic prompting features. Local, private, MIT, BYOK.

<br />

[**Documentation**](https://node-banana-docs.vercel.app/) &nbsp;&bull;&nbsp; [Discord](https://discord.com/invite/89Nr6EKkTf)

<br />

</div>

## Build Complex AI Pipelines Visually

Node Banana is a node-based workflow editor for AI media generation. Drag nodes onto an infinite canvas, connect them with typed handles, and execute pipelines that call AI APIs in dependency order.

- **Build dynamic prompts** with variables, LLM/VLM-powered prompt construction, and reusable prompt chains
- **Generate workflows from natural language** or choose from preset templates
- **Chain multiple AI models together** across providers in a single pipeline
- **Generate images, video, 3D models, and audio** from a single workflow
- **Annotate and edit images** with a full-screen drawing editor
- **Save and share workflows** as portable JSON files

## Features

| Feature | Description |
|:--------|:------------|
| **Dynamic Prompting** | Build prompts with variables, LLM-powered text construction, and reusable prompt chains that adapt per run and per input |
| **Prompt to Workflow** | Generate complete workflows from natural language descriptions |
| **Visual Node Editor** | Drag-and-drop nodes onto an infinite canvas with pan and zoom |
| **Image Generation** | Generate images using Google Gemini, Replicate, fal.ai, Kie.ai, and more |
| **Video Generation** | Generate video via AI API providers |
| **Audio Generation** | Text-to-speech and AI audio generation |
| **3D Generation** | Generate 3D models or use them as node inputs |
| **Image Annotation** | Full-screen editor with drawing tools (rectangles, circles, arrows, freehand, text) |
| **Text Generation** | Generate text using Google Gemini, OpenAI, or Anthropic models |
| **Workflow Chaining** | Connect multiple nodes to create complex multi-step pipelines |
| **Group Locking** | Lock node groups to skip them during execution |
| **Save/Load** | Export and import workflows as JSON files |

## Supported Providers

| Provider | Status |
|:---------|:-------|
| [Google Gemini](https://ai.google.dev/) | Fully supported |
| [Replicate](https://replicate.com/) | Supported |
| [fal.ai](https://fal.ai/) | Supported |
| [Kie.ai](https://kie.ai/) | Supported |
| [WaveSpeed](https://wavespeed.ai/) | Supported |
| [metaso](https://metaso.cn/) | MiniMax H3 video |
| [OpenAI](https://openai.com/) | LLM only |

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Quick Start

```bash
git clone https://github.com/shrimbly/node-banana.git
cd node-banana
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Environment Variables

Create a `.env.local` file in the root directory:

```env
GEMINI_API_KEY=your_gemini_api_key          # Required for prompt-to-workflow
OPENAI_API_KEY=your_openai_api_key          # Optional
ANTHROPIC_API_KEY=your_anthropic_api_key    # Optional
REPLICATE_API_KEY=your_replicate_api_key    # Optional
FAL_API_KEY=your_fal_api_key                # Optional
KIE_API_KEY=your_kie_api_key                # Optional
WAVESPEED_API_KEY=your_wavespeed_api_key    # Optional
METASO_API_KEY=your_metaso_api_key          # Optional
METASO_API_BASE_URL=https://metaso.cn/api/minimax/ # Optional override
```

API keys can also be entered in the app (Settings → Providers), which is the
usual way — the environment variables are for headless or shared deployments.

### Running ComfyUI workflows

Drop any ComfyUI workflow onto the canvas and it becomes a node. `Shift + C`
adds an empty ComfyUI node and opens the same dialog to pick a workflow for it.
If the workflow was set up as an app in ComfyUI — using **App Mode** to pick
its inputs and outputs — those selections become the node's handles and
settings directly; otherwise Node Banana detects them and asks you to confirm.
The **Blueprints** tab lists the ready-made pipelines your ComfyUI already
ships, so there is nothing to upload at all.

Choose where they run in **Settings → ComfyUI**:

- **Comfy Cloud** (default) — no GPU or install needed; add an API key from
  [platform.comfy.org](https://platform.comfy.org/profile/api-keys).
- **This computer** — your own ComfyUI at `http://127.0.0.1:8188`. It needs the
  models and custom nodes the workflow uses.
- **Remote** — a ComfyUI elsewhere on your network.

**API keys can also be configured in Project Settings within the app.** 

### Build

```bash
npm run build
npm run start
```

## Example Workflows

The `/examples` directory contains example workflow files. To try them:

1. Start the dev server with `npm run dev`
2. Drag any `.json` file from the `/examples` folder into the browser window
3. Review the prompts in each node before running — they're targeted to specific use cases

## Node Types

| Type | Purpose |
|:-----|:--------|
| **Image Input** | Load or upload reference images |
| **Audio Input** | Load or upload audio files |
| **Prompt** | Text prompt input |
| **Prompt Constructor** | Build dynamic prompts with variables and LLM-powered text construction |
| **Array** | Batch process multiple inputs through a workflow |
| **Generate** | AI image generation (multi-provider) |
| **Generate Video** | AI video generation |
| **Generate Audio** | Text-to-speech and AI audio generation |
| **Generate 3D** | AI 3D model generation |
| **LLM** | AI text generation (Gemini, OpenAI, Anthropic) |
| **Annotation** | Draw on images with full-screen editor |
| **Split Grid** | Split image into grid cells |
| **Video Stitch** | Combine video clips into a single output |
| **Video Trim** | Trim video clips to a specific range |
| **Video Frame Grab** | Extract frames from video |
| **Image Compare** | Side-by-side image comparison |
| **Ease Curve** | Define easing curves for parameter interpolation |
| **Router** | Route data to different branches |
| **Switch** | Toggle between execution paths |
| **Conditional Switch** | Route data based on conditions |
| **GLB Viewer** | Load and display 3D GLB models |
| **Output** | Display final result |
| **Output Gallery** | Display multiple results in a gallery |

## Tech Stack

<p>
  <a href="https://nextjs.org/"><img src="https://img.shields.io/badge/Next.js-000000?logo=next.js&logoColor=white" alt="Next.js" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://reactflow.dev/"><img src="https://img.shields.io/badge/React%20Flow-FF0072?logo=react&logoColor=white" alt="React Flow" /></a>
  <a href="https://konvajs.org/"><img src="https://img.shields.io/badge/Konva.js-0D83CD?logo=konva&logoColor=white" alt="Konva.js" /></a>
  <a href="https://zustand-demo.pmnd.rs/"><img src="https://img.shields.io/badge/Zustand-443E38?logo=react&logoColor=white" alt="Zustand" /></a>
  <a href="https://tailwindcss.com/"><img src="https://img.shields.io/badge/Tailwindcss-%2338B2AC.svg?logo=tailwind-css&logoColor=white" alt="TailwindCSS" /></a>
</p>

## Testing

```bash
npm test              # Watch mode
npm run test:run      # Single run
npm run test:coverage # With coverage report
```

## Contributing

PRs are welcome! Fork the repo, branch from `develop`, and open a PR back to `develop`.

This is primarily built for my own workflows — if a PR conflicts with my plans I'll politely decline. For larger contributions, join the [Discord](https://discord.com/invite/89Nr6EKkTf) to coordinate first.

## Community

- **[Discord](https://discord.com/invite/89Nr6EKkTf)** — Chat, get help, and share workflows
- **[Documentation](https://node-banana-docs.vercel.app/)** — Guides and reference
- **[GitHub Issues](https://github.com/shrimbly/node-banana/issues)** — Report bugs and request features

## License

MIT

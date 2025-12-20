# Node Banana

> **Important note:** This is in early development and hasn't been tested off my machines,it probably has some issues. Use Chrome. 

Node Banana is node-based workflow application for generating images with NBP. Build image generation pipelines by connecting nodes on a visual canvas. Built mainly with Opus 4.5.

## Features

- **Visual Node Editor** - Drag-and-drop nodes onto an infinite canvas with pan and zoom
- **Image Annotation** - Full-screen editor with drawing tools (rectangles, circles, arrows, freehand, text)
- **AI Image Generation** - Generate images using Google Gemini models
- **Text Generation** - Generate text using Google Gemini or OpenAI models
- **Workflow Chaining** - Connect multiple nodes to create complex pipelines
- **Save/Load Workflows** - Export and import workflows as JSON files

## Tech Stack

- **Framework**: Next.js 16 (App Router)
- **Language**: TypeScript
- **Node Editor**: @xyflow/react (React Flow)
- **Canvas**: Konva.js / react-konva
- **State Management**: Zustand
- **Styling**: Tailwind CSS
- **AI**: Google Gemini API, OpenAI API

## Getting Started

### Prerequisites

- Node.js 18+
- npm

### Environment Variables

Create a `.env.local` file in the root directory:

```env
GEMINI_API_KEY=your_gemini_api_key
OPENAI_API_KEY=your_openai_api_key  # Optional, for OpenAI LLM provider
```

### Installation

```bash
npm install
```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Build

```bash
npm run build
npm run start
```

## Example Workflows

The `/examples` directory contains some example workflow files from my personal projects. To try them:

1. Start the dev server with `npm run dev`
2. Drag any `.json` file from the `/examples` folder into the browser window
3. Make sure you review each of the prompts before starting, these are fairly targetted to the examples. 

## Usage

1. **Add nodes** - Click the floating action bar to add nodes to the canvas
2. **Connect nodes** - Drag from output handles to input handles (matching types only)
3. **Configure nodes** - Adjust settings like model, aspect ratio, or drawing tools
4. **Run workflow** - Click the Run button to execute the pipeline
5. **Save/Load** - Use the header menu to save or load workflows

### Keyboard Shortcuts

- **Shift + P** - Add Prompt node
- **Shift + I** - Add Image Input node
- **Shift + G** - Add Generation node
- **Shift + L** - Add LLM Generate node
- **Shift + A** - Add Annotation node
- **Cmd/Ctrl + C** - Copy selected nodes
- **Cmd/Ctrl + V** - Paste nodes or clipboard content (images/text)
- **V** - Stack selected nodes vertically
- **H** - Stack selected nodes horizontally
- **G** - Arrange selected nodes in a grid

### macOS Trackpad Controls

When using a trackpad on macOS, enhanced gesture controls are automatically enabled:

- **Pinch to Zoom** - Use two-finger pinch gesture to zoom in/out on the canvas
- **Two-Finger Pan** - Smoothly pan around the canvas with two-finger scroll
- **Precise Navigation** - High-precision scrolling for fine control

The app automatically detects macOS trackpads and enables these features.

## Connection Rules

- **Image** handles connect to **Image** handles only
- **Text** handles connect to **Text** handles only
- Image inputs on generation nodes accept multiple connections
- Text inputs accept single connections

## License

MIT

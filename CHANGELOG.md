# Changelog

All notable changes to Node Banana will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **AI Quickstart Feature** - Generate complete workflows from natural language descriptions
  - Welcome screen appears on empty canvas with preset templates and custom description input
  - 6 preset workflow templates: Product Shot, Model + Product, Color Variations, Background Swap, Style Transfer, Scene Composite
  - Content level selector (empty/minimal/full) to control how much detail is pre-filled
  - Uses Gemini LLM to generate custom workflows from descriptions
  - JSON validation and repair for generated workflows
  - Sample images included in `/public/sample-images/` for templates

- **Test Suite** - Comprehensive testing with Vitest
  - 108 tests covering quickstart templates, validation, and prompts
  - 90%+ code coverage for quickstart module
  - Run tests with `npm test` or `npm run test:coverage`

- **Node Expansion & Run** - Expand nodes to full-screen modal and run individual nodes
- **Group Locking** - Lock node groups to skip them during workflow execution
- **Image Carousel** - Browse through image history on generation nodes

### Fixed

- Run button and global modal state issues
- Carousel image inversion
- Two-finger pan behavior on Mac
- Comment tooltip z-index issues

## [1.0.0] - Initial Release

### Added

- Visual node editor with drag-and-drop canvas
- Image Input node for loading images
- Prompt node for text input
- Annotation node with full-screen drawing tools (rectangles, circles, arrows, freehand, text)
- NanoBanana node for AI image generation using Gemini
- LLM Generate node for text generation (Gemini and OpenAI)
- Output node for displaying results
- Workflow save/load as JSON files
- Connection validation (image-to-image, text-to-text)
- Multi-image input support for generation nodes

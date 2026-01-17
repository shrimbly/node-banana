# Changelog

All notable changes to Node Banana will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

## [0.2.0] - 2026-01-17

### Added - Multi-Agent Development Sprint

This release was built autonomously by **Jetpack** - a multi-agent orchestration system that coordinated 10 AI agents working in parallel. All 9 tasks completed successfully in 1 hour with 0 failures.

#### New Node Types

- **Image Compare Node** - Side-by-side comparison of two images with a draggable slider overlay. Features zoom sync between both images and swap button functionality.

- **Batch Variations Node** - Generate multiple image variations (2-8) from a single prompt. Includes progress indicator and ability to select/favorite individual results from a grid output.

- **Conditional Branch Node** - If/else logic based on image analysis. Routes workflow to different output handles based on image properties (dimensions, dominant color, brightness) with AND/OR logic support.

- **Color Palette Extraction Node** - Extract dominant colors (5-10) from an image and output as a palette. Includes ability to apply extracted palette to another image via color mapping.

- **Loop/Iterator Node** - Repeat connected subgraph N times, passing iteration index and previous output to next iteration. Supports accumulating results into a gallery output.

- **Mask/Inpainting Node** - Selective image editing with a Konva-based mask painting interface. User paints areas to edit, connects prompt describing changes. Includes mask feathering and expansion controls.

- **Image Filter Effects Node** - Apply visual filters and adjustments with sliders for brightness, contrast, saturation, hue rotation, blur, and sharpen. Includes preset filters (vintage, noir, vivid) with real-time preview.

#### New Features

- **Workflow Template Gallery** - Browse and import workflow templates. Includes Quick Start templates (Product Shot, Model + Product, Color Variations, Background Swap, Style Transfer, Scene Composite) and Community Workflows section.

- **Undo/Redo System** - Full undo/redo functionality with Cmd+Z (undo) and Cmd+Shift+Z (redo) keyboard shortcuts. Maintains history stack for workflow state changes.

#### New Utilities

- `colorPalette.ts` - Color extraction and palette manipulation utilities
- `imageAnalysis.ts` - Image property analysis (dimensions, brightness, dominant colors)
- `maskInpaintStore.ts` - Zustand store for mask painting state management

#### Tests

- Comprehensive test suite for undo/redo functionality
- Tests for Template Gallery Modal component

### Technical Details

- **Total new code**: ~4,824 lines across 11 new files
- **Modified files**: 15 existing files updated for integration
- **Store changes**: +806 lines added to `workflowStore.ts` for undo/redo

### Agent Attribution

| Task | Agent | Duration |
|------|-------|----------|
| Workflow Template Gallery | agent-7c8a80f7 | 10m |
| Color Palette Extraction | agent-6ff3b3bd | 17m |
| Undo/Redo System | agent-7c8a80f7 | 18m |
| Batch Variations Node | agent-fd88f466 | 19m |
| Loop/Iterator Node | agent-30f89159 | 19m |
| Image Filter Effects | agent-eeddacd8 | 19m |
| Image Comparison Node | agent-b4d76485 | 20m |
| Conditional Branch Node | agent-7c8a80f7 | 20m |
| Mask/Inpainting Node | agent-52904c0e | 23m |

---

## [0.1.0] - 2026-01-16

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

# Weavy Workflow Tips & Learnings

Sources:
- Rory Flynn — Weavy Flow State #1 (March 2026)
- Weavy Official — "How to Build Consistent AI Machines" tutorial (March 2026)
- Weavy Official — "Power of System Prompts" tutorial (March 2026)
- Al Raoni — "Infinite Reshoot System" Weavy Breakdown (March 2026)
- Raoni Lima — "The Real Office Hours" Weavy workflow walkthrough (March 2026)

## Core Workflow Formula

1. **Work backwards** — Start with proven output. Run prompt 5-10x to verify. Then reverse-engineer into a workflow.
2. **Three steps:** Deconstruction → System Prompts → Sequencing (tools + order)
3. **Pay the tax upfront** — 5 min building a reusable workflow saves hours over single-use prompting.
4. **"A prompt gives you a fish, a system prompt gives you a net"** — Regular prompts produce one output. System prompts produce reusable machines.

## System Prompt Generator (Meta-Workflow)

Source: Weavy "Power of System Prompts" tutorial

A workflow whose OUTPUT is a system prompt (plain text), not images/video. Feed 7 inputs → get a production-ready system prompt to paste into other workflows.

**The 7 inputs:**
1. **Job** — What should the system do? ("generate 5 brand-consistent image prompts")
2. **Target environment** — Where is the output used? ("image-to-image model, Nano Banana")
3. **Inputs specification** — What will the system receive? ("one reference image + brand guidelines text")
4. **Core operation** — The cognitive task ("analyze reference image to understand scene and subject")
5. **Desired outputs** — Exact output format ("5 image prompts, each a different camera angle, separated by *")
6. **Hard rules & prohibitions** — Must-do and must-never-do lists
7. **Interpretation mode** — Strict (follow exactly) vs. creative (interpret freely)
- *(bonus)* **Missing info policy** — What to do when context is incomplete (guess, ask, use defaults)

**Architecture (confirmed from workflow screenshots):**
```
[User Inputs] → [Prompt Text nodes] → [Prompt Concatenator] → [Master LLM (Gemini)] → [Output]
     ×7 fields       ×7 populated          "All user Data"         ↑ System Prompt:
     + 2 selects      text nodes            with [labels]          "The Master Prompt"
```
Each user input field (dark card with placeholder) connects to a Prompt Text node (with actual content), then all 7+ streams merge in a Prompt Concatenator with labeled sections `[The Job:]`, `[Target Environment:]`, etc. The Master System Prompt sits as the System Prompt on the final LLM node (Gemini).

**The 12-section output structure** (mandatory in every generated system prompt):
1. Role & Identity
2. Inputs Specification
3. Global Objectives
4. Two-Phase Workflow: Analysis → Prompt Construction
5. Image Prompting Principles
6. Video / Motion Prompting Principles
7. Environmental Motion Logic
8. Identity Preservation Rules
9. Prompt Structure & Formatting
10. Model-Specific Adaptation
11. Hard Constraints & Prohibited Behaviors
12. Optional Internal Examples

**5 Interpretation Modes** (behavioral slider for creative freedom):
1. Strict / Evidence-Only
2. Conservative / Minimal Inference
3. Professional Defaults (Balanced)
4. Creative / Interpretive ← default
5. Exploratory / Generative

**Critical design principle:** "Do NOT confuse levels of control. The system prompt must define HOW TO WRITE prompts, not lock in per-output creative choices. Define a PROCESS for choosing style, lighting, motion, camera — not hardcoded defaults."

**Key insight:** "Don't think you'll put 7 inputs and get the perfect system prompt. You DO need to iterate." The generator is an accelerator, not a one-shot solution.

**Weavy workflow links:**
- System Prompt Generator: https://app.weavy.ai/flow/9JnuVIOlhBJHXb83Ycdyei
- Prompt vs system prompt comparison: https://app.weavy.ai/flow/XVaA078kDhD...
- Multiple prompt variations from one subject: https://app.weavy.ai/flow/wF5rxs66oMI...
- Split + pipe to generative models: https://app.weavy.ai/flow/YANQxyBcjvt...

## System Prompt Architecture

- **Role first** — Always start with a role: "You are a technical image analysis and canvas adaptation system..."
- **JSON format** for complex system prompts — gives structure, not required but helpful
- **Negative constraints are gold** — Tell the model what NOT to do:
  - "Subject never perfectly centered"
  - "Camera always tilted"
  - "Reject standard portrait framing"
  - "Never looking directly at camera"
  - "50% negative space minimum"
- **Fidelity locks** — Lock what must stay consistent:
  - Material continuity, stitching, lighting direction
  - Proportions, environment anchor, color temperature
- **Build a bank** — Reusable building blocks: anchor locks, composition rules, shot lists, aesthetic rules
- **Limit the output range** — Tighter constraints = more predictable results. Easier to loosen than to tighten.

## Prompt Techniques

- **"Keep this, change that"** — Simple structure for image editing nodes:
  - "Keep this exact car, preserve fine details. Change to a front view."
- **Shot lists in system prompts** — Define exact angles:
  - Shot 1: full body front, Shot 2: full body side, Shot 3: 3/4 angle, etc.
- **Star separator** — Use `*` between prompts when batching in one node
- **Macro/detail shots** — Tell the model it can focus on a part, not the whole object

## Smart Techniques

- **Contact sheets as reference** — 9 angles in a 3x3 grid = "mini-LoRA" without training
- **Proportion guides** — Show product relative to real-world objects for correct scaling
- **White/neutral background first** — Forces model to focus on the object. Add environment later.
- **Flip reference images** — If you only have a 3/4 rear view, flip it to get front context too
- **2D vector → 3D product** — Works well: input flat art, system prompt describes material/lighting/studio

## Model Testing Protocol

- Have 10-15 standard test prompts for each model type (video/image)
- Video: test physics (mirrors/reflections), extreme camera motion, human emotion, dialogue
- Image: test control level (long detailed prompts), consistency, small text, intricate products
- If it fails the basics, move on immediately — too many good models to waste time
- **Test with fast/cheap models first** — Grok, Flux Fast, Imagine Fast for first 10 generations
- Switch to high-fidelity (Nano Banana, Kling, VO) once the prompt is dialed in

## Breaking AI Aesthetics (Anti-Average)

Nano Banana / ChatGPT image defaults to fix:
- Perfectly symmetrical → mandate asymmetry, rule of thirds
- Perfectly centered → off-center, cropped, corner placement
- Perfect lighting → harsh flash, shadows, chromatic aberration
- Clean/polished → motion blur, grain, film texture
- Full object in frame → allow cropping, partial views, macro
- Looking at camera → off-gaze, candid, in-motion

## Brand Workflow Pattern

1. Ingest brand guidelines (even 180-page docs) via agents
2. Extract and codify rules into system prompt building blocks
3. Hard-code brand rules as baseline in every workflow
4. Goal: "on brand from the start" — iterate within brand, not toward it

## Context Architecture (Fragile → Bulletproof)

Source: Weavy "How to Build Consistent AI Machines" tutorial

**Core principle:** "When AI makes a bad decision, it's usually not because it's wrong — it's because it was forced to guess."

- **Define output first, then derive inputs** — Not "what inputs do I have?" but "what does the system need to NEVER guess?" Work backwards from the desired output to identify every context gap.
- **Context-stacking** — Layer multiple context streams in a Prompt Concatenator:
  1. Visual identity (extracted from reference images by a dedicated LLM node)
  2. Brand/marketing brief (static text)
  3. Task-specific guidelines (e.g., AB testing rules, shot requirements)
  4. User input (the variable: image, category selection, text)
  5. Successful examples (3-5 proven outputs as reference images)
- **Visual Language Extractor pattern** — Dedicated perception node that receives 3-5 successful examples and extracts the visual identity as structured text (colors, composition rules, typography, mood). This text becomes context for all downstream creative nodes.
- **"Even wildcard stays on brand"** — When context is deep enough, maximum creative freedom still produces on-brand results. The insight: don't restrict the prompt, enrich the context.
- **Fragile vs. bulletproof test** — Run the same workflow with "wildcard" or extreme categories. If it goes off-brand, the problem is missing context, not a bad prompt.

## Infinite Reshoot Pattern

Source: Al Raoni — "Infinite Reshoot System" Weavy Breakdown

Generate unlimited pose/angle/scene variations from a single character or product image — no LoRAs, no training.

**Core workflow:**
1. Start with a strong reference image (e.g., character from Midjourney)
2. Upscale with **Enhancor** node to lock face/detail fidelity
3. LLM node (ChatGPT) as "image analyst and reshoot director" — analyzes reference + writes N variation prompts
4. Array splits prompts → SeedDream or Nano Banana Pro generates variations
5. Pick best output → feed back as new reference → repeat

**Key architecture insight — Modular Prompt Separation:**
- **System prompt** stays on the LLM node (defines the role: "image analyst and reshoot")
- **Action instructions** go in a separate Prompt Text node connected to the Prompt* port
- This lets you swap action instructions without touching the system prompt
- Example: same system prompt, different action text = completely different shoot (new wardrobe, new scene, new age)

**Prompt Concatenator for modular inputs:**
- Create separate Prompt Text nodes for each variable dimension: clothes, age, skin, hair, setting
- Merge them in a Prompt Concatenator with labeled sections
- Swap one box (e.g., "winter jacket" → "summer dress") without rebuilding the whole prompt
- This makes the workflow reusable across projects

**Output formatting:**
- LLM outputs 15 variations separated by `**` (double asterisk)
- Array node splits by `**`
- Note: Al Raoni uses `**` but our standard separator hierarchy (`^`, `§`, `†`) is safer — `**` can conflict with markdown bold

**Model selection for generation:**
- **SeedDream**: Preferred for 4K quality and character consistency. Best for faces and skin realism.
- **Nano Banana Pro (4K mode)**: Now competitive with SeedDream. Use when you need web search or multi-reference capability.
- Both outperform standard Nano Banana significantly at 4K resolution.

**Iterative refinement loop:**
- Run the workflow once → review outputs
- Pick the best result → plug it back as the new reference image
- Each iteration tightens consistency and refines the character/product
- 2-3 iterations typically enough for production quality
- "No LoRA needed" — reference image + good system prompt achieves comparable consistency

**Why this works:** The system prompt creates a persistent "photographer brain" that understands the subject from the reference image. Each run is a new photoshoot of the same subject, not a new generation from scratch.

## Variables vs. Prompt Concatenator

Source: Raoni Lima — "The Real Office Hours"

- **Variables** are the "new way" — use `@variable_name` inside any prompt box. You can reuse the same variable across multiple downstream prompts. Settings: show value, show source, or both.
- **Prompt Concatenator** is the "old way" — just sequences text inputs. No tagging, no reuse, no editing within the template.
- **Best practice:** Use variables for anything that might change (camera angle, color, clothing). Put fixed constraints (e.g., "full product in frame, no cropping") directly in the prompt text — they don't need to be variable.
- **Safety pattern:** Put important constraints in a separate variable so they can't be accidentally deleted when editing the main prompt text.

## Context Window Overload ("Less Is More")

Source: Raoni Lima + Zane (Rory Flynn) — "The Real Office Hours"

**The #1 cause of inconsistent generation results: overloading the model's context window.**

- Too many reference images + too much text prompt = **context rot**
- Symptoms: proportions changing between generations, "slop", model ignoring some instructions, inconsistent subject details
- **Fix: aggressively reduce inputs.** Ask: "What does the model ACTUALLY need to understand my goal?"
- Three similar photos of the same model add zero extra value — one good photo is enough
- Separate measurement text + product image is worse than one annotated product image

**Annotated reference images:** Use Nano Banana Pro to annotate product images with measurements directly ON the image (e.g., "3cm length" with arrows). Visual annotations are far more reliable than text-based size instructions. Command: "Annotate this with measurements in detail."

**Compositor for multi-reference consolidation:** When you need makeup + dress + earring + environment references, don't feed 4+ separate images. Composite them into one image in quadrants (2x2 grid), then feed that single composite + the main character separately. This reduces image count and helps the model understand what's primary (character) vs. accessory (styling context).

## Kling Multi-Scene / Multi-Cut

Source: Raoni Lima — "The Real Office Hours"

**"CUT TO" is the critical syntax for Kling multi-scene generation.** Without it, Kling produces one continuous shot. With it, Kling understands to create distinct scene transitions.

- System prompt generates the full multi-cut script with "CUT TO" markers between scenes
- Can feed the complete multi-cut prompt directly to Kling (no need for Array split in this case)
- Scene development input can be loose/creative ("add some weird camera angles and POV, drone shots, be creative") — the system prompt structures it properly
- This is a Kling-specific syntax — other video models may not respect it

## Model Comparison Block

Source: Raoni Lima — "The Real Office Hours"

For the first image of every new workflow: connect the same prompt to multiple generation models, select all, and hit generate simultaneously. Compare results before committing to a model for the rest of the workflow.

Useful models to test in parallel: Nano Banana 2, Recraft V4, Nano Banana Pro, SeedDream. Each has different aesthetic strengths:
- **Recraft V4**: Excellent cinematic quality, no "plastic look", but no image input — text-only. Best for first-frame style decisions.
- **Nano Banana Pro**: Best all-rounder with image input, good at 2K, excellent at 4K.

## Product 360 Visualization

Source: Raoni Lima — "The Real Office Hours"

One product image → LLM generates descriptions for 3 additional camera angles → Array splits → List Selector picks individual angles → Generate each. Use the `++` separator in the LLM output for Array parsing.

This creates a multi-angle product sheet useful for:
- Kling Elements (frontal = main image, 3 angles = reference slots)
- Contact sheets / consistency reference
- Product catalogs

Character variant: similar but generates side view, back view, and face closeup instead of product angles.

## Prompt Shortener Pattern

Source: Raoni Lima — "The Real Office Hours"

When prompts accumulate too much text from upstream context stacking, add a dedicated "Prompt Shortener" LLM node. System prompt: "Make this prompt more concise. Remove unnecessary wording. Keep all critical details." This prevents context rot in downstream generation models.

## Compositor Techniques

Source: Raoni Lima — "The Real Office Hours"

- **Video on video**: Compositor supports video layers, not just images. Overlay video on video for complex compositions.
- **Opacity overlay for text**: Add a 30% opacity dark layer between video/image and text to improve readability.
- **Custom mattes/masks**: Build masks in compositor (white = show, black = hide), convert with "Merge Alpha" node. Works with both video and images.
- **Live updates**: When you change an image/video upstream, compositor updates automatically across all connected outputs and sizes.
- **Multi-format export**: Same composition → multiple aspect ratios (9:16, 1:1, etc.) via separate compositor nodes.

## Asset Reversion Workflow

Simple but high-value: one image → multiple aspect ratios in one click.
- Lock subject center, outpaint surroundings
- System prompt handles matching environment for each ratio
- Works surprisingly well with titles and small print

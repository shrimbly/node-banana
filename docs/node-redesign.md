# Node anatomy

Every node on the canvas is built from the same parts, top to bottom:

1. **Media card** — `bg-card`, 1px `card-border`, 12px squircle, 4px padding.
   The media inside (image, video, waveform, text surface, 3D canvas…) is
   clipped to an 8px squircle and always shown at its native aspect ratio.
   Selection ring, running outline and error border live on this card only.
   Sockets sit in its border: inputs on the left, outputs on the right, the
   first centred 24px from the card's top, then every 30px.
2. **Gap row** (28px) — history prev/next with dots and a `3 / 5` counter, or
   a video scrub row. Nodes with neither keep an 8px spacer instead.
3. **Controls card** — `node width − 24px`, at most 360px, centred, 10px
   squircle. Its left and right edges are grips: dragging one gives the card
   its own width (160–720px, stored as `controlsWidth` on the node) and
   double-clicking it returns the card to following the node. Collapsed it is a 28px summary row (provider icon · model name,
   truncated · summary values · chevron). Expanded it shows the settings panel
   on `bg-panel`: one column of 22px rows, 72px label column, wells on
   `bg-well` with 8px squircle corners and a faint recess (`shadow-well`).

**Header** (`src/components/nodes/FloatingNodeHeader.tsx`) floats 26px above
the media card, transparent. Left: provider badge and the title, 12px
semibold uppercase in neutral-400. On generate nodes the title is the model
picker (chevron, white-6% hover fill, click opens the browser); elsewhere a
double-click renames it. Right, never fading: the amber readiness pill, the
lock badge, and a filled blue comment glyph when a comment exists (hover
reads it, click edits). Then Expand where the node has an editor, Run and
the kebab, which fade in together on hover or selection and never change
width. The kebab menu holds Browse, Run (⌥↵), Rename, then
Fallback, Optional input and Comment; a set fallback puts a blue dot on the
kebab.

**Dropdowns** (`src/components/nodes/ui/Dropdown.tsx`) replace native
selects everywhere. The well is the trigger; the list opens under it at the
same width on the Instrument menu skin, at the panel's density (22px rows,
10px type) or the dialog's (28px, 12px). The selected row carries a check on
the right, the pointer or keyboard row the neutral-700 fill. Past eight
options a search well appears and typing filters; below that typing jumps as
on a native select. Inside the canvas the list is portaled into the React
Flow viewport so it zooms with the node and escapes the card's clip; it
flips above the trigger when the window edge is near.

**Video playback** follows what the user last asked of the video. Untouched,
a video previews while its node is hovered (after a short delay) and pauses
where it is when the pointer leaves. Pressing play in the scrub row pins
playback, so leaving the node no longer stops it. Pausing or scrubbing holds
the chosen frame, and hovering will not restart it; only play does. A new
source, or the video ending on its own, returns it to hover previews. See
`src/hooks/useVideoAutoplay.ts`.

**Sound** is one setting shared by every player and kept between sessions
(`src/store/videoSoundStore.ts`, `node-banana-video-sound`). The scrub row's
sound button, after the time readout, toggles it and pins playback, so the
video is heard from then on; resting on the button for 300ms opens the volume
above it. Hover previews are always silent. Under 240px of row the time
readout hides first and the button stays.

Logic nodes (Router, Switch, ConditionalSwitch, Array) are a single card
styled like the controls card, with their sockets on that card's border and
rows laid out at the socket pitch.

Node **height is derived** from width ÷ media aspect plus the gap row and the
measured controls card. Users resize width only — the node's, and
independently the controls card's. The exceptions carry a `HeightGrip` on
the media card's bottom edge and store the result as `mediaHeight`: the
text surfaces (prompt, LLM, Comfy text) and the output gallery's grid.

The tokens live in `src/app/globals.css` (`@theme`) and, for anything
computed in JavaScript, `src/components/nodes/ui/tokens.ts`.

# Node anatomy

Every node on the canvas is built from the same parts, top to bottom:

1. **Media card** — `bg-card`, 1px `card-border`, 12px squircle, 4px padding.
   The media inside (image, video, waveform, text surface, 3D canvas…) is
   clipped to an 8px squircle and always shown at its native aspect ratio.
   Selection ring, running outline and error border live on this card only.
   Sockets sit in its border: inputs on the left, outputs on the right, the
   first centred 24px from the card's top, then every 30px.
2. **Gap row** (28px) — history prev/next with dots and a `3 / 5` counter, or
   a video scrub row. Empty on nodes with neither.
3. **Controls card** — `node width − 24px`, at most 360px, centred, 10px
   squircle. Collapsed it is a 28px summary row (provider icon · model name,
   truncated · summary values · chevron). Expanded it shows the settings panel
   on `bg-panel`: one column of 22px rows, 72px label column, wells on
   `bg-well` with 8px squircle corners and a faint recess (`shadow-well`).

Logic nodes (Router, Switch, ConditionalSwitch, Array) are a single card
styled like the controls card, with their sockets on that card's border and
rows laid out at the socket pitch.

Node **height is derived** from width ÷ media aspect plus the gap row and the
measured controls card. Users resize width only.

The tokens live in `src/app/globals.css` (`@theme`) and, for anything
computed in JavaScript, `src/components/nodes/ui/tokens.ts`.

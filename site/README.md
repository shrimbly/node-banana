# Landing page

Astro site, one static page. `npm install` then `npm run dev` in `site/` serves it with hot reload at http://localhost:3105; `npm run build` writes the deployable folder to `site/dist/`.
Markup lives in `src/components/` (one file per section) and `src/partials/` (generated node graphs and marquees, from `.scratch/gen_window.py` and `.scratch/gen_sections.py`); styles in `src/styles/global.css`; behaviour in `src/scripts/site.js`.
Download links: the two `href`s in the platform menu in `src/components/Fold.astro`; the main button copies the visitor's platform.
Version text: `--nb-version` at the top of `global.css`, one edit at release time.
Deploy `site/dist/`; set `og:image` in `src/layouts/Base.astro` to an absolute URL once the domain is known.

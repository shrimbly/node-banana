# Landing page

Static site, no build step. Preview with `python3 -m http.server 3105 -d site` (or `npx serve site -l 3105`) and open http://localhost:3105.
Download links: the two `href`s in the platform menu in `index.html` (the comment above them marks the spot); the main button copies the visitor's platform.
Version text: `--nb-version` at the top of `styles.css`, one edit at release time.
Deploy the `site/` folder as-is; set `og:image` in `index.html` to an absolute URL once the domain is known.

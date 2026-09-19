// @ts-check
import { defineConfig } from "astro/config";

// The landing page: one static page, no client framework. `astro dev` serves it
// with hot reload on 3105; `astro build` writes the deployable folder to dist/.
export default defineConfig({
  output: "static",
  server: { port: 3105, host: false },
  devToolbar: { enabled: false },
});

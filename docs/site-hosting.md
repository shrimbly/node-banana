# Site hosting

The landing page is the Astro project in `site/`. Vercel builds it and serves the static files. The download buttons go to `/download/mac` and `/download/windows`. Vercel redirects those paths to the installers on GitHub Releases. The app's updater also reads GitHub Releases, and nothing about it changes.

Do the steps in order. Each step says how to check it.

## How downloads work

- Every release carries the versioned installers that the updater uses: `Node-Banana-<version>-arm64.dmg`, `Node-Banana-<version>-x64.exe`, the `.zip` and `.blockmap` files, and `latest-mac.yml` / `latest.yml`.
- The release workflow also uploads two copies without the version in the name: `Node-Banana-mac-arm64.dmg` and `Node-Banana-windows-x64.exe`.
- GitHub redirects `https://github.com/shrimbly/node-banana/releases/latest/download/<name>` to the asset with that name in the latest published release.
- `site/vercel.json` redirects (302) `/download/mac` and `/download/windows` to those GitHub URLs, and `/download` to the latest release page. The redirects are fixed config: there is no function, no API call and no rate limit.

So a download link works when the latest *published* release has the versionless copies. Releases before 2.0.0 have no installers, so `/download/mac` ends in a GitHub 404 until 2.0.0 is published. Publish 2.0.0 before you announce the site.

## 1. Create the Vercel project

1. In Vercel, select **Add New… → Project**, then import `shrimbly/node-banana` from GitHub. Give the Vercel GitHub app access to that repository.
2. **Root Directory:** `site`. This is the one setting that matters. Without it, Vercel builds the Next.js app at the repository root.
3. **Framework Preset:** Astro. `site/vercel.json` already sets these, so leave the overrides off:
   - Install command: `npm ci`
   - Build command: `npm run build`
   - Output directory: `dist`
4. **Node.js version** (Settings → Build and Deployment): 22.x or later.
5. **Environment variable (optional):** the page makes `og:image`, `og:url` and its canonical link absolute with `https://nodebanana.app`, built into `site/astro.config.mjs`, so link previews in Slack, X and Discord show the image. `SITE_URL` (no trailing slash) overrides that address; set it only if the site moves, or for Preview if previews should point at themselves. It is not a secret.
6. Select **Deploy**.

Check:

- The build log shows `npm run build` in `site` and ends with `1 page(s) built`.
- The deployment opens at its `*.vercel.app` address and shows the page.
- `curl -sI https://<project>.vercel.app/download/mac` returns `HTTP/2 302` and `location: https://github.com/shrimbly/node-banana/releases/latest/download/Node-Banana-mac-arm64.dmg`.
- `curl -sI https://<project>.vercel.app/ | grep -i content-security-policy` prints the policy.
- `curl -sI https://<project>.vercel.app/assets/og.png | grep -i cache-control` prints `max-age=86400`. Vercel's Astro preset adds a one-year `immutable` rule for `/assets/*` before ours; if that one wins, an updated image keeps its old copy in browsers for a year. Tell the site's maintainer if you see `immutable` here.

## 2. Choose the production branch and the preview behaviour

1. **Settings → Git → Production Branch:** `master`. The site then shows what has shipped. `develop` and feature branches get preview deployments.
2. **Settings → Build and Deployment → Root Directory:** turn on **Skip deployments when there are no changes to the root directory or its dependencies**. A push that changes only the app then builds nothing.
3. Every pushed branch that changes `site/` gets a preview at `https://<project>-git-<branch>-<team>.vercel.app`. Vercel posts its link on the pull request. Previews are protected by Vercel Authentication by default, so only members of the Vercel team can open them. Change that under **Settings → Deployment Protection** if a reviewer outside the team needs a preview.
4. Pushes to `master` that change `site/` deploy to production by themselves.

Check: push a branch that changes a file in `site/`. A preview appears under **Deployments** with the branch name, and the production deployment does not change.

## 3. Add the custom domain

`nodebanana.app` was bought through Vercel, so Vercel is its registrar and its DNS host (nameservers `ns1.vercel-dns.com` and `ns2.vercel-dns.com`). There are no records to create at another registrar.

1. In the project, select **Settings → Domains → Add** and type `nodebanana.app`. Vercel offers to add `www.nodebanana.app` and to redirect one to the other. Accept it, and keep the apex (no `www`) as the main address, so it matches `SITE_URL`.
2. Vercel creates the DNS records by itself, because it hosts the domain's DNS. The Domains page shows **Valid Configuration** within a minute or two.
3. In the team's **Domains** page (outside the project), check that **Auto Renew** is on for `nodebanana.app`.
4. If you later want email on the domain, add the mail provider's `MX` and `TXT` records under the team's **Domains → nodebanana.app → DNS Records**. They do not affect the site.

Check:

- `dig +short nodebanana.app NS` returns `ns1.vercel-dns.com` and `ns2.vercel-dns.com`.
- `dig +short nodebanana.app A` returns Vercel addresses (`216.150.…` today).
- The project's Domains page shows `nodebanana.app` and `www.nodebanana.app` with a green check.

## 4. HTTPS

Vercel issues a Let's Encrypt certificate for each domain after the DNS check passes, usually within a few minutes, and renews it by itself. `.app` domains are HTTPS-only in every major browser (the whole `.app` ending is on the browsers' HSTS preload list), so the site cannot be visited before the certificate exists. It also redirects HTTP to HTTPS. `site/vercel.json` sends `Strict-Transport-Security: max-age=63072000` (two years, no `includeSubDomains`, so other subdomains on plain HTTP are not affected).

Check:

- `curl -sI http://nodebanana.app` returns a redirect to `https://nodebanana.app/` (browsers never request the `http://` address).
- `curl -sI https://www.nodebanana.app` returns a redirect (`307` or `308`) to `https://nodebanana.app/`.
- `curl -sI https://nodebanana.app | grep -i strict-transport` prints the header.
- The page's link preview shows the image: paste the address into the [opengraph.xyz](https://www.opengraph.xyz/) checker or a Slack message.

## 5. Analytics

The page carries Vercel Web Analytics (`@vercel/analytics/astro`, mounted in `site/src/layouts/Base.astro`): page views, and a `Download` event with the platform for every click on a `/download/*` link, which `site/src/scripts/site.js` sends because those paths answer with a redirect rather than a page. It sets no cookies and stores nothing that identifies a visitor. In production the script and its beacon are served from the site's own `/_vercel/insights/` path, so the Content-Security-Policy in `site/vercel.json` needs no extra host.

1. In the project, open the **Analytics** tab and select **Enable**. Until then the script answers 404 and nothing is counted; the page itself is unaffected.
2. Redeploy once after enabling if the deployment predates it.

Check:

- `curl -sI https://nodebanana.app/_vercel/insights/script.js` returns `HTTP/2 200`.
- Open the page, then the **Analytics** tab: the visit appears within a minute. Click a download button; the `Download` event appears under **Events** (custom events need a plan that includes them; on Hobby only the page views show).

## 6. A release becomes a download

1. Push the tag `v<version>` (see [desktop-preview.md](desktop-preview.md#releases-and-updates)). The Release workflow uploads the versioned installers, the updater manifests, and the two versionless copies into a **draft** release.
2. Check the draft has `Node-Banana-mac-arm64.dmg` and `Node-Banana-windows-x64.exe` beside the versioned files.
3. Add the notes and select **Publish release**. Leave **Set as the latest release** on.
4. From then on, `/download/mac` and `/download/windows` give the new installers. Installed apps find the update at their next check.
5. Redeploy the site so it shows the new version number: the page reads it from the repository's `package.json` when it builds (`site/src/lib/release.ts`), and the skip rule from section 2 means a push that changes only the root `package.json` builds nothing. Either **Redeploy** the latest production deployment from the Vercel dashboard, or let the release commit touch a file under `site/` (the CHANGELOG link, say). The download links do not depend on this.

The workflow change must be in the tagged commit. If `v2.0.0` was tagged before this change reached it, upload the copies by hand as below.

Check:

```bash
curl -sIL https://nodebanana.app/download/mac | grep -iE '^HTTP|^location'
```

The chain is `302` to `github.com/…/releases/latest/download/Node-Banana-mac-arm64.dmg`, `302` to `github.com/…/releases/download/v<version>/Node-Banana-mac-arm64.dmg`, then `302` to GitHub's file host and `200`. Do the same for `/download/windows`. A `404` at the end means the latest published release has no copy of that name.

### A release built by hand

`npm run electron:package -- --publish` does not make the copies. Make them after both builds are in the draft and before you publish:

```bash
v=2.0.0
gh release download "v$v" --repo shrimbly/node-banana --pattern "Node-Banana-$v-arm64.dmg" --pattern "Node-Banana-$v-x64.exe" --dir /tmp/nb
cp "/tmp/nb/Node-Banana-$v-arm64.dmg" /tmp/nb/Node-Banana-mac-arm64.dmg
cp "/tmp/nb/Node-Banana-$v-x64.exe" /tmp/nb/Node-Banana-windows-x64.exe
gh release upload "v$v" /tmp/nb/Node-Banana-mac-arm64.dmg /tmp/nb/Node-Banana-windows-x64.exe --repo shrimbly/node-banana --clobber
```

## 7. Roll back

**The site.** In **Deployments**, open the last good production deployment, then select **Instant Rollback** (or **Promote to Production** on an older deployment). The domain points at it within seconds. After a rollback, Vercel stops moving the domain to new production deployments. When the fix is on `master`, promote the new deployment to turn that back on. Check with `curl -sI https://nodebanana.app` and the deployment id in the dashboard.

**A bad release.** Downloads follow GitHub's latest release, and so does the updater. Edit the bad release and turn it back into a draft (or mark it as a pre-release). GitHub's latest release becomes the previous one, and `/download/mac` follows within a few minutes (GitHub caches the redirect briefly). The previous release must have its own versionless copies; upload them as in [A release built by hand](#a-release-built-by-hand) if not. Apps that already installed the bad version stay on it until a newer release is published.

## Reference

- `site/vercel.json` — build settings, the download redirects, security headers, caching. `/assets/*` (the page's images and videos, whose names carry no hash) is cached for a day; the hashed `/_astro/*` files for a year.
- The Content-Security-Policy allows Google Fonts, the GitHub API (the star count) and `vercel.live` (the toolbar and comments on preview deployments). A new external script, font or API in the page needs adding there, or the browser blocks it. The browser console names the blocked address.
- To try `vercel.json` without an account: copy `site/` to a temporary folder, create `.vercel/project.json` containing `{"projectId":"x","orgId":"x","settings":{"framework":"astro"}}`, run `vercel build`, then read the routes in `.vercel/output/config.json`.

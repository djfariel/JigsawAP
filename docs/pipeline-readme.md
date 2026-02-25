# JigsawAP Asset Pipeline Guide

This document explains how the JavaScript/CSS pipeline works in plain language.

## What problem this solves

Before this pipeline, the app served large unminified files directly from the repo.
Now we:

1. Minify and optimize assets.
2. Generate fingerprinted filenames (hashes) for cache safety.
3. Publish tagged builds that jsDelivr can serve as a CDN.

Netlify still serves `index.html` and all static fallback files.

## CI/CD in plain English

- `CI` (Continuous Integration): automatic checks/build steps that run in GitHub when code changes.
- `CD` (Continuous Delivery/Deployment): automatic publishing/release steps after checks pass.

In this project:
- GitHub Actions is the CI/CD system.
- A release tag like `v1.2.3` starts the publish workflow.

## Files added for this pipeline

- `package.json`: npm scripts and dev dependencies for minification/build.
- `asset-list.json`: source-of-truth list of CSS/JS assets and script order.
- `scripts/build-assets.mjs`: builds optimized hashed files into `dist-assets/`.
- `purgecss.config.cjs`: CSS pruning config with a safelist for dynamic classes.
- `postcss.config.cjs`: PostCSS plugins used for CSS optimization.
- `cdn-loader.js`: loads assets from jsDelivr first, with local fallback.
- `.github/workflows/publish-cdn-assets.yml`: tag-triggered release workflow.

## How build output works

Run:

```bash
npm run build:assets
```

This generates:

- `dist-assets/<file>.<hash>.js|css`
- `dist-assets/manifest.json` (maps original file -> hashed output)
- `dist-assets/manifest.js` (browser-friendly manifest)
- `dist-assets/asset-order.json` (script order metadata)

Hashes let browsers cache files safely. If file content changes, the hash changes.

## How CDN loading works at runtime

`index.html` loads `cdn-loader.js`, which:

1. Reads `window.JIGSAW_CDN_CONFIG` (`repo`, `tag`, `enabled`).
2. Tries to fetch `dist-assets/manifest.json` from jsDelivr:
   - `https://cdn.jsdelivr.net/gh/<owner>/<repo>@<tag>/dist-assets/manifest.json`
3. If CDN manifest exists, scripts/CSS are loaded from CDN hashed files.
4. If CDN fails, it falls back to local `dist-assets`.
5. If local `dist-assets` is missing, it falls back to original local files.

This keeps the app working even if CDN has an issue.

## Day-to-day workflow

1. Make code/CSS changes.
2. Run:
   - `npm install` (first time only)
   - `npm run build:assets`
3. Commit your source changes plus `dist-assets/` updates.
4. Merge to `main`.
5. When ready for a release, create and push a tag:
   - `git tag v1.2.3`
   - `git push origin v1.2.3`
6. GitHub Action runs and creates a release.
7. Update `window.JIGSAW_CDN_CONFIG.tag` in `index.html` to that release tag if needed.

## Safe release checklist

- `npm run build:assets` completed without errors.
- `dist-assets/manifest.json` changed as expected.
- App still works locally.
- Tag format matches `v*` (example: `v1.2.3`).

## Rollback

If a release has problems:

1. Change `window.JIGSAW_CDN_CONFIG.tag` in `index.html` to a previous known-good tag.
2. Commit and deploy through Netlify.
3. Confirm app behavior and console are clean.

Because filenames are versioned by tag and hash, rollback is quick and predictable.

## Troubleshooting

- Workflow says generated files differ:
  - Run `npm run build:assets`
  - Commit updated `dist-assets/`
  - Re-create/push the tag
- CDN 404 errors:
  - Confirm tag exists on GitHub.
  - Confirm files are present in that tagged commit.
  - Verify `repo` and `tag` in `window.JIGSAW_CDN_CONFIG`.

# Releasing

The CLI is published as a **single bundled JS file** (`packages/cli/dist/index.js`) because Node's
type stripping does not support TypeScript files under `node_modules`.

## Pre-flight

```bash
pnpm install
pnpm test
pnpm --dir apps/desktop build
pnpm pack:check        # builds the bundle, copies LICENSE/NOTICE, packs the CLI tarball
```

`pnpm pack:check` should print a tarball around ~130 KB containing `dist/index.js`, `LICENSE`,
`NOTICE`, `README.md`, `package.json`. Install it in a scratch directory to verify:

```bash
mkdir -p /tmp/sp-install && cd /tmp/sp-install
npm init -y && npm install /path/to/sessionport-cli-0.1.0.tgz
./node_modules/.bin/sessionport --help
```

## Version + changelog

1. Bump `version` in `packages/cli/package.json` (and root `package.json` for consistency).
2. Move `CHANGELOG.md` entries under the new version.
3. Commit, tag, push:

```bash
git commit -am 'release: v0.1.0'
git tag v0.1.0
git push origin main --tags
```

## CI

`.github/workflows/release.yml` runs on `v*` tags:

- `publish-npm`: builds the bundle and publishes `@sessionport/cli` (needs `NPM_TOKEN` secret).
- `desktop-dmg`: builds the unsigned macOS dmg/zip and attaches them to a GitHub Release.

## Manual fallback

```bash
NODE_AUTH_TOKEN=... pnpm publish:cli
pnpm --dir apps/desktop dist   # dmg/zip under apps/desktop/release/
gh release create v0.1.0 --generate-notes apps/desktop/release/*.dmg
```

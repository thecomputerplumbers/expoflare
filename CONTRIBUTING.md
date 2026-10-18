# Contributing

## Checks

Run `mise run check`. Changes to the build output or the runtime also need `pnpm test:e2e`. CI runs both on every pull request.

## Pull request titles

PRs are squash-merged, and the PR title becomes the commit on `main`. Titles follow [Conventional Commits](https://www.conventionalcommits.org/), and CI checks them:

```
fix(expoflare): keep env-level rules
feat(updates): serve Android assets from R2
docs: explain custom entries
```

- `feat` is a new feature (a minor release once we're past 1.0, a patch release before that). `fix` and `perf` are patch releases.
- `docs`, `test`, `refactor`, `build`, `ci` and `chore` don't release anything.
- Breaking changes: add `!` after the type (`feat(expoflare)!: ...`) or a `BREAKING CHANGE:` footer.
- Scopes are optional: `expoflare`, `updates`, `deps`, `release`, `examples`.

## Releases

[release-please](https://github.com/googleapis/release-please) keeps a release PR open on `main` with the next version of each package that changed, based on the commits since its last release, and a `CHANGELOG.md` entry for each. Merging that PR tags the release (`expoflare-v0.1.1`, `expoflare-updates-v0.2.0`), creates the GitHub release, and publishes the package to npm from GitHub Actions with provenance (`.github/workflows/release.yml`, npm trusted publishing). Don't edit versions or changelogs by hand, and don't run `npm publish` locally.

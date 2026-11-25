# Releasing

Releases are published from a version tag. The tag triggers [`release.yml`](../.github/workflows/release.yml), which:

1. checks that the tag is `v` plus the `version` in `package.json`, and that `CHANGELOG.md` has a non-empty section for that version;
2. runs the whole CI ([`ci.yml`](../.github/workflows/ci.yml)) on Windows, macOS and Linux, against the oldest supported VS Code and the current one;
3. publishes a GitHub Release with that version's changelog section as its notes and the `.vsix` that CI built and tested attached.

Nothing is published if any step fails. A tag with a hyphen (`v0.3.0-beta.1`) becomes a pre-release.

## Steps

1. Make sure `main` is green in CI.
2. Pick the version ([semantic versioning](https://semver.org/); while the major version is 0, a minor bump may break things).
3. Set the version in `package.json` and `package-lock.json`: `npm version <version> --no-git-tag-version`.
4. In `CHANGELOG.md`, rename `## Unreleased` to `## <version> — <YYYY-MM-DD>`, and start a new empty `## Unreleased` above it if you like.
5. If dependencies changed, run `npm run notices` and commit `THIRD_PARTY_NOTICES.md`. (`npm run package` refuses to build when it is out of date.)
6. Check locally: `npm run check` and `npm run package`.
7. Commit, then tag and push:

   ```bash
   git commit -am "Release <version>"
   git tag v<version>
   git push origin main v<version>
   ```

8. Watch the **Release** workflow in the Actions tab. When it finishes, the release is under **Releases** with the `.vsix` attached.

## If a release fails

- **Version or notes check failed:** fix `package.json` or `CHANGELOG.md`, then move the tag: `git tag -f v<version>` and `git push -f origin v<version>`.
- **CI failed:** fix the problem on `main`, then move the tag to the fixed commit the same way. Only do this before the release has been published; once people may have downloaded a version, publish a new one instead.

## Marketplace and Open VSX

Not set up yet. Both need a publisher account whose ID matches `"publisher"` in `package.json` (`iliketocode2`), and a token stored as a repository secret. `vsce publish` and `ovsx publish` can then be added to `release.yml` after the GitHub Release step.

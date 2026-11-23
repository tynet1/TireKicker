# Releasing (maintainers)

A release is a version tag. Pushing it runs `.github/workflows/release.yml`: the full test suite against Postgres,
then the Docker image to `ghcr.io/tynet1/tirekicker` (tagged `0.3.0`, `0.3` and `latest`), then a GitHub Release
whose notes are that version's section of `CHANGELOG.md`.

## Cut a release

1. Make sure CI is green on `main`.
2. Pick the version: while the major version is 0, bump the minor (0.2 → 0.3) for features or migrations and the
   patch (0.3.0 → 0.3.1) for fixes only.
3. In one commit, set it in three places:
   - `CHANGELOG.md`: a new `## [0.3.0] - YYYY-MM-DD` section at the top (say which migrations run and anything an
     admin must do), and its link at the bottom;
   - `package.json` and `package-lock.json` (`npm version 0.3.0 --no-git-tag-version` does both);
   - `compose.release.yml`: the image pin, `tirekicker:${TIREKICKER_VERSION:-0.3.0}`.
4. Tag and push:

   ```bash
   git tag -a v0.3.0 -m "TireKicker v0.3.0"
   git push origin main v0.3.0
   ```

5. Watch the Release workflow under the repository's **Actions** tab. It refuses a tag that doesn't match
   `package.json` and `compose.release.yml`, or a version with no CHANGELOG section.

If it fails after the image was pushed, fix the problem and release the next patch version; don't move a tag that
people may already have pulled.

## One-time setup

- The first image is published as a private package. On GitHub, open the profile's **Packages → tirekicker →
  Package settings** and set its visibility to **Public**, so installs can pull it without signing in.
- The update check in Admin → About (from 0.3.0) reads `https://api.github.com/repos/tynet1/TireKicker/releases/latest`, so every
  release must be published as a GitHub Release (the workflow does that), not just a tag.

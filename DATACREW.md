# DataCrew fork notes

This is a fork of [alvarosanchez/paperclip-github-plugin](https://github.com/alvarosanchez/paperclip-github-plugin).

## Branch policy

- `main` mirrors upstream. Do not commit to it directly.
- DataCrew changes live on `datacrew/*` branches.
- Update with `git fetch upstream && git merge upstream/main` (or `gh repo sync`).

## How we run it

- Installed on bonker's Paperclip from a local path: build with `npm ci && npm run build`, copy `dist`, `package.json` and a production `node_modules` to `/paperclip/plugin-src/github-sync`, then `POST /api/plugins/install` with `isLocalPath: true`.
- Scheduled sync stays off unless a repo is mapped to a project. Mapping a repo imports all of its open issues.
- Upstream issues #195 and #196 ("company context is required") only appear while no repo is mapped. With a mapping the job runs scoped and the errors stop (checked on Paperclip v2026.1012.0, plugin 0.18.0).
- Linking an issue only works for the repo mapped to that issue's project.

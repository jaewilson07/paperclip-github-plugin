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

## Push on the `ready-for-agent` label (DAT-1429)

- Job `push.ready-for-agent` runs every minute. It pushes Paperclip issues that carry the `ready-for-agent` label (case-insensitive), are not done or cancelled, sit in a project with a mapped repository and have no GitHub link. Unlabelled issues are never pushed.
- Action `issue.pushNowIfReady` (`companyId`, `issueId`) applies the same rules to one issue without waiting for the tick. `issue.pushToGitHub` stays the unconditional manual push.
- A failed push stores no link. It is commented on the ticket once per distinct error, then retried on every tick; the marker search in the push prevents a duplicate GitHub issue.

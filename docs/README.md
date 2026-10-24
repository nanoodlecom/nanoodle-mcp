# Deploy

`mcp.nanoodle.com` loads graphs from a host directory that refreshes only when
[`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) runs. The job
SSHs to the box and runs the forced command `nanoodle-mcp`. That command is the
whole deploy. The workflow does not pass a commit SHA.

A push to `main` or `master` starts it. `repository_dispatch` event type
`awesome-noodles-updated` is also wired to the same job. The awesome-noodles
sender workflow is not on that repo's `main`, and no token setup is authorized.
The dispatch trigger stays inert until Mikkel puts the sender on
awesome-noodles `main` and adds the token secret there himself.

## Which revision is deployed

`GET https://mcp.nanoodle.com/version` returns `{ name, version, commit }`.
`commit` is the short git SHA of the nanoodle-mcp checkout the running process
started from (`git rev-parse --short=7 HEAD` in that checkout, at least 7 hex
digits).

A push deploy's Actions run records the same commit as `github.sha`. After the
run, compare that SHA with `commit` on `/version`. A `repository_dispatch` run's
SHA is this repo's default-branch HEAD at dispatch time. It is not an
awesome-noodles SHA, and the workflow never sends it to the box.

`/version` does not name the graph files. The served graph is whatever the host
directory held when the process started. `GET https://mcp.nanoodle.com/graph/photo-to-video.json`
is the photo-to-video graph the server loaded.

## Rollback

The rollback this workflow supports is a revert merge to `main` (or `master`).
That push runs this deploy again. The host command then deploys current `main`.

Re-running the deploy workflow for a prior good SHA does not roll back. Every
run executes the same SSH command, `nanoodle-mcp`, and does not pass a SHA, so
a re-run ships whatever the host deploys as current `main`, not the old run's
commit.

## The photo-to-video check does not roll back

After the SSH step, `node scripts/check-live-photo-to-video.mjs` fetches the
live graph. The video node (`ivideo`) must be model
`minimax-h3-singularity/image-to-video`, resolution `480p`, and duration `5`
(five seconds). Anything else, including a missing model or
`minimax-h3/image-to-video-spicy`, exits non-zero.

That failure fails the job. It does not revert the box, restore the previous
graph, or start another deploy. The SSH step has already finished. To undo a
bad deploy, revert `main` and let that new push deploy.

## Concurrency

The workflow uses group `nanoodle-mcp-deploy` with `cancel-in-progress: false`.
The deploy already in progress runs to completion. GitHub keeps only one
pending run in the group, so a newer queued run replaces the older pending one
(the older pending run is canceled). Pushes and dispatches share this group.

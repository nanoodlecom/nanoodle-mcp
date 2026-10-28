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
`commit` is the short git SHA of the nanoodle-mcp app checkout the running
process started from (`git rev-parse --short=7 HEAD` in that checkout, at least
7 hex digits).

A push deploy's Actions run records that push as `github.sha`. A
`repository_dispatch` run's SHA is this repo's default-branch HEAD at dispatch
time. The workflow never sends either value to the box. Compare `github.sha`
with `commit` on `/version` when you want the app checkout that was current for
that run.

`/version`'s `commit` and the workflow SHA identify only the nanoodle-mcp app
checkout. They do not say which awesome-noodles graph revision is live. The
served graphs are the files in the host directory when the process started.
`GET https://mcp.nanoodle.com/graph/photo-to-video.json` is the photo-to-video
graph that was loaded.

## Rollback

A revert merge of nanoodle-mcp `main` (or `master`) redeploys this app. That
push runs this workflow again. Re-running an old deploy does not select that
run's SHA: every run executes the same SSH command, `nanoodle-mcp`, and does
not pass a commit, so the host deploys whatever it deploys for current `main`.

Reverting nanoodle-mcp `main` does not undo graph changes made in
awesome-noodles. Those graphs are not in this repo. To restore a graph, restore
a verified earlier graph snapshot, or get an approved upstream revert in
awesome-noodles, then redeploy so the host directory refreshes.

## The photo-to-video check does not roll back

After the SSH step, `node scripts/check-live-photo-to-video.mjs` fetches the
live graph. The video node (`ivideo`) must be model
`minimax-h3-singularity/image-to-video`, resolution `480p`, and duration `5`
(five seconds). Anything else, including a missing model or
`minimax-h3/image-to-video-spicy`, exits non-zero.

That failure fails the job. It does not revert the box, restore the previous
graph, or start another deploy. The SSH step has already finished. Restoring
a graph takes a verified earlier snapshot, or an approved awesome-noodles
revert, and then another deploy.

## Concurrency

The workflow uses group `nanoodle-mcp-deploy` with `cancel-in-progress: false`.
The deploy already in progress runs to completion. GitHub keeps only one
pending run in the group, so a newer queued run replaces the older pending one
(the older pending run is canceled). Pushes and dispatches share this group.

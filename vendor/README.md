# Vendored executor

The active executor is `nanoodle-0.13.1.tgz`, packed from Nanoodle JS commit
`bcf2561d980ffc058281afb1d8ace5662e7bb196`. The archive keeps the file set from
the proposed 0.13.1 re-pin, including the SDK fixtures used by MCP tests. Its
SHA-256 is `162638cb2280f5b8a868bcff96b32056e51bac196946f109ed14befcf3c3c5b8`.

## Rebuild the retained 0.9.0 archive

The 0.9.0 conditional execution patch backports routing, decision validation
and pricing metadata from the SDK. Rebuild the archive from the previous
archive and the checked-in patch.

```sh
task_vendor="$(mktemp -d)"
task_repo="$PWD"
tar -xzf vendor/nanoodle-0.9.0-content-url.tgz -C "$task_vendor"
(cd "$task_vendor/package" && git apply --unidiff-zero "$task_repo/vendor/nanoodle-0.9.0-decider-branches.patch")
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --mode='go-w,a+rX' -C "$task_vendor" -cf - package \
  | gzip -n > "$task_vendor/nanoodle-0.9.0-decider-branches.tgz"
cmp vendor/nanoodle-0.9.0-decider-branches.tgz "$task_vendor/nanoodle-0.9.0-decider-branches.tgz"
```

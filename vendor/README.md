# Vendored executor

The active executor is `nanoodle-0.13.1.tgz`, packed from Nanoodle JS commit
`bcf2561d980ffc058281afb1d8ace5662e7bb196`. The archive keeps the file set from
the proposed 0.13.1 re-pin, including the SDK fixtures used by MCP tests. Its
SHA-256 is `162638cb2280f5b8a868bcff96b32056e51bac196946f109ed14befcf3c3c5b8`.

The public SDK archive from
[the v0.13.1 main build](https://github.com/nanoodlecom/nanoodle-js/actions/runs/44442280983)
at `722ca7817211db0a44b354c3db906517f4346ba3` has integrity
`sha512-xMHyXm5gd24y5AiKUwY6fpsJEV9p2TmWsrXEOA+SuI8oPJmwRpJgEX1EVokfCmz05kTQmF7UA6w4lr4FvQONGw==`.
The public and vendored archives have byte-identical executable files,
starter graph, and license. The public README includes the SDK release
documentation already on main, and the vendored package manifest omits
only npm's `files` allowlist to include the tests and fixtures needed by MCP.

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

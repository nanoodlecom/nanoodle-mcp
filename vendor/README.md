# Vendored executor

MCP keeps the 0.9.0 executor's existing payment and request behavior. The
conditional execution patch backports routing, decision validation and pricing
metadata from the SDK. Rebuild the pinned archive from the previous archive
and the checked-in patch.

```sh
task_vendor="$(mktemp -d)"
task_repo="$PWD"
tar -xzf vendor/nanoodle-0.9.0-content-url.tgz -C "$task_vendor"
(cd "$task_vendor/package" && git apply --unidiff-zero "$task_repo/vendor/nanoodle-0.9.0-decider-branches.patch")
tar --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner --mode='go-w,a+rX' -C "$task_vendor" -cf - package \
  | gzip -n > "$task_vendor/nanoodle-0.9.0-decider-branches.tgz"
cmp vendor/nanoodle-0.9.0-decider-branches.tgz "$task_vendor/nanoodle-0.9.0-decider-branches.tgz"
```

The Netcup hotfix backports the SDK's x402 completion and replay diagnostics
from nanoodle-js commit `13f3c424cc5636c7c03f663915cdc13d16efe4ad`.
To rebuild `nanoodle-0.9.0-x402-diagnostics.tgz`, start with
`nanoodle-0.9.0-decider-branches.tgz`, apply
`nanoodle-0.9.0-x402-diagnostics.patch` in the extracted package, and use the
same tar and gzip options above.

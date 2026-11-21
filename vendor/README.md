# Historical executor archives

The MCP server now installs the Nanoodle version pinned in `package.json` from npm.

The archived 0.13.1 runtime files came from
[nanoodle@0.13.1 on npm](https://www.npmjs.com/package/nanoodle/v/0.13.1) at SDK
commit `5029a858f7ee4a8d726931315fbd3d7c1fd4f20b`. The vendored archive has
SHA-256 `f4693fcfaacb7fea7a1a30a0eea87a192547c8e47420603f7806d80495d15e66`.

The public archive has integrity
`sha512-Ljwp8Ggiasl5hYME5sZp4zWWI4gHfAS45/QzfkOYpSornMovHYpRpaG0TNRvDoiavCq8uMmhqwWS9rOqbm3mew==`.
Every published file and its executable mode matches the vendored copy, except
`package.json`, where the vendored manifest omits the `files` allowlist.
The additional files are the tests and fixtures from the same SDK commit.

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

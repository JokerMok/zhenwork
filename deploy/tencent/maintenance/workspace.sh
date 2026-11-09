# Shared by the three local staging entrypoints. Never operates on server data.
zw_build_begin() {
  zw_helper="$repo/deploy/tencent/maintenance/workspace.py"
  work=$(python3 "$zw_helper" begin --repo "$repo" --kind "$1" --release "$release" --sha "$sha" \
    --artifacts "${ZHENWORK_RELEASE_ARTIFACTS:-$repo/.codex/release-artifacts}" \
    --temporary "${ZHENWORK_BUILD_TMPDIR:-$repo/.codex/build-tmp}" \
    --max-pending "${ZHENWORK_MAX_PENDING_CANDIDATES:-10}" --pid "$$")
  trap 'zw_build_close $?' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  python3 "$zw_helper" extract --work "$work"
  stage="$work/stage"
}

zw_build_close() {
  local result=$1
  trap - EXIT INT TERM
  if ! python3 "$zw_helper" close --work "$work" --exit-code "$result"; then
    echo "Build workspace cleanup failed; see BUILD.json. No historical release was deleted." >&2
    [[ $result != 0 ]] || result=1
  fi
  exit "$result"
}

zw_build_complete() {
  python3 "$zw_helper" complete --work "$work"
}

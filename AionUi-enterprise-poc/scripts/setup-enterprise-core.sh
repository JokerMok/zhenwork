#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
core_dir="$repo_root/upstream-core"
expected_commit=47e66d0d151123e973b3fd1e77afcb5671b3f8c5
aionrs_dir="$repo_root/upstream-aionrs"
aionrs_commit=8e61a90329fa9f67c4fdf7e97fe02c24dba33f75
# Public ZhenWork snapshots include the complete, already patched Rust source.
if [[ -f "$core_dir/.zhenwork-source.json" && -f "$aionrs_dir/.zhenwork-source.json" ]]; then
  printf 'ZhenWork vendored Core and aionrs sources are already prepared.\n'
  exit 0
fi
git_bin="${GIT_BIN:-git}"
if [[ "$(uname -s)" == 'Darwin' && -x /usr/bin/git ]]; then git_bin=/usr/bin/git; fi

if [[ ! -d "$core_dir/.git" ]]; then
  "$git_bin" clone --depth=1 --branch v0.2.2 https://github.com/iOfficeAI/AionCore.git "$core_dir"
fi
actual_commit="$("$git_bin" -C "$core_dir" rev-parse HEAD)"
if [[ "$actual_commit" != "$expected_commit" ]]; then
  printf 'Unexpected AionCore commit: %s\n' "$actual_commit" >&2
  exit 1
fi
latest_core_patch="$repo_root/patches/aioncore-enterprise-idle-status.patch"
previous_core_patch="$repo_root/patches/aioncore-enterprise-cron-preflight.patch"
if "$git_bin" -C "$core_dir" apply --reverse --check "$latest_core_patch" 2>/dev/null; then
  : # Already prepared; later patches can overlap earlier reverse-check contexts.
elif "$git_bin" -C "$core_dir" apply --reverse --check "$previous_core_patch" 2>/dev/null; then
  "$git_bin" -C "$core_dir" apply --check "$latest_core_patch"
  "$git_bin" -C "$core_dir" apply "$latest_core_patch"
else
  for patch in aioncore-enterprise-local-gate.patch aioncore-enterprise-skill.patch aioncore-enterprise-docx-reader.patch aioncore-content-skills.patch aioncore-local-folder.patch aioncore-hide-cache-diagnostics.patch aioncore-enterprise-client-pref-encryption.patch aioncore-enterprise-local-token-env.patch aioncore-enterprise-background-model-context.patch aioncore-enterprise-response-redaction.patch aioncore-enterprise-model-abort.patch aioncore-enterprise-cron-preflight.patch aioncore-enterprise-idle-status.patch; do
    if "$git_bin" -C "$core_dir" apply --reverse --check "$repo_root/patches/$patch" 2>/dev/null; then
      : # already applied
    else
      "$git_bin" -C "$core_dir" apply --check "$repo_root/patches/$patch"
      "$git_bin" -C "$core_dir" apply "$repo_root/patches/$patch"
    fi
  done
fi
if [[ ! -d "$aionrs_dir/.git" ]]; then
  "$git_bin" clone --depth=1 --branch v0.2.11 https://github.com/iOfficeAI/aionrs.git "$aionrs_dir"
fi
actual_aionrs_commit="$("$git_bin" -C "$aionrs_dir" rev-parse HEAD)"
if [[ "$actual_aionrs_commit" != "$aionrs_commit" ]]; then
  printf 'Unexpected Aionrs commit: %s\n' "$actual_aionrs_commit" >&2
  exit 1
fi
if "$git_bin" -C "$aionrs_dir" apply --reverse --check "$repo_root/patches/aionrs-enterprise-web-approval.patch" 2>/dev/null; then
  : # already applied
else
  "$git_bin" -C "$aionrs_dir" apply --check "$repo_root/patches/aionrs-enterprise-web-approval.patch"
  "$git_bin" -C "$aionrs_dir" apply "$repo_root/patches/aionrs-enterprise-web-approval.patch"
fi
if "$git_bin" -C "$core_dir" apply --reverse --check "$repo_root/patches/aioncore-enterprise-web-approval-source.patch" 2>/dev/null; then
  : # already applied
else
  "$git_bin" -C "$core_dir" apply --check "$repo_root/patches/aioncore-enterprise-web-approval-source.patch"
  "$git_bin" -C "$core_dir" apply "$repo_root/patches/aioncore-enterprise-web-approval-source.patch"
fi
printf 'AionCore prepared at %s\n' "$core_dir"
printf 'Build when the Rust toolchain is available: cd "%s" && cargo build -p aionui-app --bin aioncore\n' "$core_dir"

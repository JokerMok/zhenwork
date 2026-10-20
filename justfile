set shell := ["bash", "-euo", "pipefail", "-c"]

default:
    @just --list

# Scoped release-maintenance checks only. Product tests/build evidence is tracked separately.
verify:
    git diff --check
    @for file in deploy/tencent/*.sh; do bash -n "$file"; done
    python3 deploy/tencent/verify-maintenance.py

# Push only an already-reviewed clean commit after the scoped checks.
push *args: verify
    @test -z "$(git status --porcelain)" || { echo 'Refusing push: worktree is not clean.' >&2; exit 1; }
    git push {{args}}

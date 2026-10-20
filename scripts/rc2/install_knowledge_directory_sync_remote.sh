#!/usr/bin/env bash
set -euo pipefail

target=${1:-tencent-main}
if [[ ! ${target} =~ ^[A-Za-z0-9._@-]+$ || ${target} == -* ]]; then
  echo "Invalid SSH target: ${target}" >&2
  exit 2
fi

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
files=(
  install_knowledge_directory_sync.sh
  knowledge_directory_sync.py
  knowledge-directory-sync.example.json
  README-knowledge-directory-sync.md
)
for name in "${files[@]}"; do
  if [[ ! -f "${source_dir}/${name}" ]]; then
    echo "Missing installer source: ${source_dir}/${name}" >&2
    exit 2
  fi
done

remote_dir=$(ssh "${target}" 'mktemp -d /tmp/zhenwork-knowledge-directory-install.XXXXXX')
if [[ ! ${remote_dir} =~ ^/tmp/zhenwork-knowledge-directory-install\.[A-Za-z0-9]+$ ]]; then
  echo "Target returned an unsafe temporary path." >&2
  exit 2
fi

cleanup_remote() {
  ssh "${target}" "python3 -c 'import shutil; shutil.rmtree(\"${remote_dir}\")'"
}
trap 'cleanup_remote >/dev/null 2>&1 || true' EXIT

tar -C "${source_dir}" -cf - "${files[@]}" | ssh "${target}" "tar -C ${remote_dir} -xf -"
ssh "${target}" "sudo bash ${remote_dir}/install_knowledge_directory_sync.sh"
cleanup_remote
remote_dir=
trap - EXIT

echo "Remote knowledge directory sync tool installation completed on ${target}."

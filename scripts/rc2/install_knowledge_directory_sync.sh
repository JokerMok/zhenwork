#!/usr/bin/env bash
set -euo pipefail

if [[ $(uname -s) != Linux ]]; then
  echo "This installer only runs on the target Linux server." >&2
  exit 2
fi

if [[ ${EUID} -ne 0 ]]; then
  echo "Run this installer as root (for example, with sudo)." >&2
  exit 2
fi

source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
destination=/srv/apps/zhenwork/tools/knowledge-directory

for name in knowledge_directory_sync.py knowledge-directory-sync.example.json README-knowledge-directory-sync.md; do
  if [[ ! -f "${source_dir}/${name}" ]]; then
    echo "Missing installer source: ${source_dir}/${name}" >&2
    exit 2
  fi
done

python3 -m json.tool "${source_dir}/knowledge-directory-sync.example.json" >/dev/null
install -d -o root -g root -m 0755 "${destination}"

install_atomic() {
  local source=$1 target=$2 mode=$3 temporary
  temporary=$(mktemp "${destination}/.${target}.XXXXXX")
  trap 'rm -f -- "${temporary}"' RETURN
  install -o root -g root -m "${mode}" "${source}" "${temporary}"
  mv -f -- "${temporary}" "${destination}/${target}"
  trap - RETURN
}

install_atomic "${source_dir}/knowledge_directory_sync.py" knowledge_directory_sync.py 0755
install_atomic "${source_dir}/README-knowledge-directory-sync.md" README.md 0644
install_atomic "${source_dir}/knowledge-directory-sync.example.json" knowledge-directory-sync.example.json 0600

echo "Installed knowledge directory sync tool in ${destination}."
echo "No private config, credentials, state, shared directory, service, or timer was created or changed."

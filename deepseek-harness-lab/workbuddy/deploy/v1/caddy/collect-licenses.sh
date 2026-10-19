#!/bin/sh
set -eu
mkdir -p /out/licenses/go
cp /usr/local/go/LICENSE /out/licenses/go/LICENSE
go list -m -json all > /out/licenses/module-graph.jsonstream
go list -m -f '{{if and .Dir .Version}}{{.Path}} {{.Version}} {{.Dir}}{{end}}' all | while read -r module version directory; do
  [ -n "$module" ] || continue
  destination="/out/licenses/$module@$version"
  mkdir -p "$destination"
  find "$directory" -maxdepth 1 -type f \( -iname '*license*' -o -iname '*copying*' -o -iname '*notice*' -o -iname '*copyright*' \) -exec cp '{}' "$destination/" \;
done

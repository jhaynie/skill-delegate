#!/usr/bin/env bash
# Link ~/.local/bin/delegate to this skill's command. Linux and macOS.
set -eu

skill="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
target="$skill/bin/delegate"
dest="${HOME}/.local/bin/delegate"

if [[ ! -x "$target" ]]; then
  printf 'install: missing %s\n' "$target" >&2
  exit 1
fi
if ! node -e 'const [a, b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 18) ? 0 : 1)'; then
  printf 'install: node 22.18 or newer is required, found %s\n' "$(node --version 2>/dev/null || echo missing)" >&2
  exit 1
fi
if [[ -e "$dest" && ! -L "$dest" ]]; then
  printf 'install: %s exists and is not a symlink. Move it aside first.\n' "$dest" >&2
  exit 1
fi

mkdir -p "${HOME}/.local/bin"
ln -sfn "$target" "$dest"

line="$("$dest" --help | tail -n 1)"
case "$line" in
  "docs: $skill/README.md $skill/docs/runners.md") ;;
  *)
    printf 'install: %s did not resolve to this package (%s)\n' "$dest" "$line" >&2
    exit 1
    ;;
esac

printf 'linked %s -> %s\n' "$dest" "$target"
case ":${PATH}:" in
  *":${HOME}/.local/bin:"*) ;;
  *)
    printf 'Add %s to PATH, then open a new shell:\n' "${HOME}/.local/bin"
    printf '  export PATH="$HOME/.local/bin:$PATH"\n'
    ;;
esac

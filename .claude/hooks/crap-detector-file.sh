#!/usr/bin/env bash
# Hook PostToolUse : analyse le fichier que l'agent vient d'écrire.
#
# Sortie 2 = Claude Code renvoie stderr à l'agent, qui corrige dans la foulée.
# En PostToolUse le fichier est déjà écrit : la sortie 2 n'annule rien, elle signale.
# C'est la boucle courte : un seuil dépassé est signalé à l'édition, pas trois
# heures plus tard en CI.
#
# Sortie 0 dans tous les autres cas, y compris si l'outil n'est pas construit :
# un hook cassé ne doit jamais bloquer une session.
set -uo pipefail

root="${CLAUDE_PROJECT_DIR:-$PWD}"
payload="$(cat)"

file="$(printf '%s' "$payload" | node -e '
let raw = "";
process.stdin.on("data", (chunk) => { raw += chunk; });
process.stdin.on("end", () => {
  try {
    const parsed = JSON.parse(raw);
    process.stdout.write(String(parsed?.tool_input?.file_path ?? ""));
  } catch {
    process.stdout.write("");
  }
});
' 2>/dev/null)"

case "$file" in
  *.ts|*.tsx|*.mts|*.cts) ;;
  *) exit 0 ;;
esac
case "$file" in
  *.test.ts|*.test.tsx|*.spec.ts|*.d.ts) exit 0 ;;
esac
[ -f "$file" ] || exit 0

if [ -f "$root/dist/cli.js" ]; then
  node "$root/dist/cli.js" file "$file" --root "$root"
elif [ -x "$root/node_modules/.bin/crap-detector" ]; then
  "$root/node_modules/.bin/crap-detector" file "$file" --root "$root"
else
  exit 0
fi

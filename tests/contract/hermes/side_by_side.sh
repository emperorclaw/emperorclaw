#!/bin/sh
# S-14 probe: can a second Hermes checkout live beside the image's pinned v0.22.4 install?
# Installs v0.21.6 with install.sh --dir into ~/.hermes/hermes-agent-v0.21.6 (same HERMES_HOME),
# then reports which binary each launcher runs and whether the first install still works.
# Usage (inside the contract image): /opt/contract/side_by_side.sh  (needs network; ~3 min)
set -u
OTHER_REF="${OTHER_REF:-v0.21.6}"
OTHER_DIR="$HOME/.hermes/hermes-agent-${OTHER_REF}"
echo "== before"
ls -l "$HOME/.local/bin/hermes"; cat "$HOME/.local/bin/hermes"; hermes --version | head -1
echo "== install $OTHER_REF into $OTHER_DIR"
curl -fsSL "https://raw.githubusercontent.com/NousResearch/hermes-agent/${OTHER_REF}/scripts/install.sh" -o /tmp/install-other.sh
bash /tmp/install-other.sh --skip-setup --skip-browser --branch "$OTHER_REF" --dir "$OTHER_DIR" > /tmp/install-other.log 2>&1
echo "install rc=$?"; tail -15 /tmp/install-other.log
echo "== after"
cat "$HOME/.local/bin/hermes"
echo "default launcher: $(hermes --version 2>&1 | head -1)"
for d in "$HOME/.hermes/hermes-agent" "$OTHER_DIR"; do
    for b in "$d/.hermes/bin/hermes" "$d/venv/bin/hermes" "$d/.venv/bin/hermes"; do
        [ -x "$b" ] && echo "$b -> $("$b" --version 2>&1 | head -1)"
    done
    echo "$d HEAD=$(git -C "$d" describe --tags 2>/dev/null) $(git -C "$d" rev-parse --short HEAD 2>/dev/null)"
done
ls -d "$HOME"/.hermes/installs/*/environments/*/venv 2>/dev/null

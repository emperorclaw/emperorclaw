# Runtime image for a single Hermes-backed Emperor Claw agent (managed mode, "Mode B"),
# run as a sibling container over the Docker Engine API (src/lib/hermes-provisioning.ts).
# One container = one Emperor agent = one Hermes profile = one standalone gateway.
#
# Process tree (docs/design/hermes-persistent-runtime.md section 7):
#   tini -g (PID 1) -> entrypoint.sh -> exec bridge (python -m emperor_bridge run)
#                                         -> supervisor.py -> hermes gateway (own session)
#
# Build context: integrations/hermes
#   docker build -t emperorclaw-hermes:dev integrations/hermes
FROM python:3.11-slim

# Hermes is pinned by tag AND commit: the build fails on any other checkout.
ARG HERMES_REF=v0.22.4
ARG HERMES_SHA=4d04303818b61bf3aa09278af48356315515965b
ARG BRIDGE_VERSION=0.9.3

RUN groupadd --gid 1001 hermes && useradd --uid 1001 --gid hermes --create-home hermes

RUN apt-get update && apt-get install -y --no-install-recommends \
        git ca-certificates curl xz-utils build-essential tini procps \
    && rm -rf /var/lib/apt/lists/*

# Node.js via NodeSource, system-wide, so the Hermes installer finds a working node/npm on PATH
# and skips its own download-and-extract fallback (that fallback fails in this image with a
# silent exit 127 when unpacking into the non-root user's $HOME).
RUN curl -fsSL --retry 6 --retry-delay 15 --retry-all-errors https://deb.nodesource.com/setup_26.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

USER hermes
WORKDIR /home/hermes
ENV PATH="/home/hermes/.local/bin:${PATH}"

# Pinned install: install.sh is fetched by the pinned commit (not the movable tag), the checkout
# is the tag, and the build fails unless HEAD is that commit. The browser stays installed (no --skip-browser): managed agents may need it.
# v0.22.4 puts its venv under ~/.hermes/installs/<id>/environments/<hash>/venv (not
# ~/.hermes/hermes-agent/venv). Expose it at a stable path: the bridge, the supervisor and the
# healthcheck all run on it. The stable path is an exec wrapper, NOT a symlink: Python looks for
# pyvenv.cfg next to the unresolved executable path, so a symlink outside the venv starts the bare
# base interpreter without the venv's site-packages (no websockets).
RUN curl -fsSL --retry 6 --retry-delay 15 --retry-all-errors "https://raw.githubusercontent.com/NousResearch/hermes-agent/${HERMES_SHA}/scripts/install.sh" \
      | bash -s -- --skip-setup --skip-computer-use --branch "${HERMES_REF}" \
 && sha="$(git -C /home/hermes/.hermes/hermes-agent rev-parse HEAD)" \
 && echo "hermes-agent HEAD=${sha}" \
 && test "${sha}" = "${HERMES_SHA}"
# v0.22.4 keys dependency state by checkout: installs/<sha256(realpath(checkout))[:16]>/, and that
# install's facts.json names the selected venv. (Its hermes_cli is a copy under
# environments/<hash>/workspace, so filtering on hermes_cli.__file__ does not identify the checkout.)
RUN PY="$(python3 -c 'import hashlib, json, os, sys; root = os.path.realpath(sys.argv[1]); key = hashlib.sha256(root.encode()).hexdigest()[:16]; facts = json.load(open(os.path.join(sys.argv[2], "installs", key, "facts.json"))); print(os.path.join(facts["packages"]["venv"]["environment"], "bin", "python"))' \
            /home/hermes/.hermes/hermes-agent /home/hermes/.hermes)" \
 && test -x "${PY}" \
 && mkdir -p /home/hermes/.local/bin \
 && printf '#!/bin/sh\nexec %s "$@"\n' "${PY}" > /home/hermes/.local/bin/hermes-venv-python \
 && chmod 0755 /home/hermes/.local/bin/hermes-venv-python \
 && /home/hermes/.local/bin/hermes-venv-python -c "import sys, websockets, hermes_cli; assert sys.version_info >= (3, 11); assert int(websockets.__version__.split('.')[0]) >= 13; print('hermes venv', sys.executable, sys.version.split()[0], 'websockets', websockets.__version__)" \
 && hermes --version

# Docker initializes a fresh named volume from this directory. Without an existing directory it
# creates a root-owned mount that Hermes cannot write.
RUN mkdir -p /home/hermes/.hermes/profiles /home/hermes/.local/state/emperor-hermes

# Plugin + bridge are stdlib-only Python (websockets comes from the Hermes venv).
USER root
COPY emperor-claw/ /opt/emperor-claw-plugin/
COPY entrypoint.sh /entrypoint.sh
RUN find /opt/emperor-claw-plugin -name __pycache__ -type d -prune -exec rm -rf {} + \
    && chmod 0755 /entrypoint.sh \
    && chown -R hermes:hermes /opt/emperor-claw-plugin
USER hermes

LABEL org.emperorclaw.bridge-version="${BRIDGE_VERSION}" \
      org.emperorclaw.hermes-version="${HERMES_REF}" \
      org.emperorclaw.hermes-commit="${HERMES_SHA}"

ENV PYTHONPATH=/opt/emperor-claw-plugin/bridge \
    PYTHONUNBUFFERED=1 \
    HERMES_PYTHON=/home/hermes/.local/bin/hermes-venv-python \
    HERMES_CHECKOUT=/home/hermes/.hermes/hermes-agent \
    EMPEROR_HERMES_PINNED_VERSION=0.22.4

# Docker's SIGTERM reaches tini, which forwards it to the bridge's process group. The gateway runs
# in its own session, so only the supervisor stops it (drain first). Provisioning sets
# StopTimeout 75 s: the gateway drain (30 s; it exits ~20 s later) and the supervisor's SIGKILL
# deadline (55 s) fit inside it.
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD ["/home/hermes/.local/bin/hermes-venv-python", "-m", "emperor_bridge", "healthcheck"]
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/entrypoint.sh"]

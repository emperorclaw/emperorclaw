# Runtime image for a single Hermes-backed Emperor Claw agent, run as a
# sibling container over the Docker Engine API (see /src/lib/docker.ts and
# provisionHermesContainer()). One container = one Emperor agent = one
# Hermes profile = one bridge process (integrations/hermes/emperor-claw/bridge).
FROM python:3.11-slim

RUN groupadd --gid 1001 hermes && useradd --uid 1001 --gid hermes --create-home hermes

RUN apt-get update && apt-get install -y --no-install-recommends \
        git \
        ca-certificates \
        curl \
        xz-utils \
    && rm -rf /var/lib/apt/lists/*

# Pre-install Node.js 26 (system-wide, as root) so the Hermes installer's own
# `command -v node` check below finds a working Node/npm already on PATH and
# skips its bundled auto-download-and-extract-node fallback. That fallback
# (fetching a tarball from nodejs.org and unpacking it into the non-root
# hermes user's $HOME) reliably fails during extraction in this image with an
# unexplained exit 127 and no diagnostic output — installing Node via
# NodeSource here avoids that broken path entirely.
RUN curl -fsSL https://deb.nodesource.com/setup_26.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Plugin + bridge are stdlib-only Python — no requirements.txt needed.
COPY emperor-claw/ /opt/emperor-claw-plugin/

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && chown -R hermes:hermes /opt/emperor-claw-plugin

USER hermes
WORKDIR /home/hermes
ENV PATH="/home/hermes/.local/bin:${PATH}"

# Install the Hermes Agent CLI using its own documented installer.
#
# ASSUMPTION TO VERIFY: there is no official `hermes-agent` PyPI package as of
# writing this Dockerfile — `docs/v1.1/hermes-runtime.md` (this repo) and
# `integrations/hermes/emperor-claw/README.md` both document installation only
# via this curl | bash script from NousResearch/hermes-agent, not `pip
# install`. That script is run here as the non-root `hermes` user (not root)
# so anything it writes under $HOME (~/.local/bin, ~/.hermes, any venv it
# creates) is owned by and consistent for the user the container actually
# runs as. If NousResearch later ships a real `hermes-agent` PyPI package,
# this RUN line can be simplified to `pip install --no-cache-dir hermes-agent`.
RUN curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh \
    | bash -s -- --skip-setup

ENTRYPOINT ["/entrypoint.sh"]

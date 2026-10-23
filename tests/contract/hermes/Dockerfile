# Contract harness image (design 0.9 §9.1): a real Hermes gateway pinned to v0.22.4, the Hermes
# fake OpenAI-compatible provider, the fake Emperor API and both suites (gateway_probe.py,
# bridge_contract.py). It is layered on top of the SHIPPED managed image so the contract proves
# what we ship:
#   docker build -t emperorclaw-hermes:ci integrations/hermes
#   docker build --build-arg BASE_IMAGE=emperorclaw-hermes:ci \
#       -f tests/contract/hermes/Dockerfile -t emperor-hermes-contract:v0.22.4 .
# Build context: the repository root (Dockerfile.dockerignore keeps it to the plugin + this folder).
# tests/contract/hermes/run.sh does all of this; HERMES_BASE=spike swaps in Dockerfile.spike-base.
ARG BASE_IMAGE=emperorclaw-hermes:ci
FROM ${BASE_IMAGE}

ARG HERMES_COMMIT=4d04303818b61bf3aa09278af48356315515965b

USER root
# procps: the probe reads gateway RSS. Both bases are Debian (python:3.11-slim).
RUN (command -v ps >/dev/null 2>&1 || (apt-get update && apt-get install -y --no-install-recommends procps \
        && rm -rf /var/lib/apt/lists/*))

# Fail the build unless the base carries exactly the pinned Hermes commit.
RUN set -e; \
    sha="$(git -c safe.directory='*' -C /home/hermes/.hermes/hermes-agent rev-parse HEAD)"; \
    echo "hermes-agent HEAD=$sha"; \
    test "$sha" = "${HERMES_COMMIT}"

# Probe client dependency, pinned, in its own venv (the Hermes venv is left untouched).
RUN python -m venv /opt/probe && /opt/probe/bin/pip install --no-cache-dir websockets==15.0.1
# The repo's plugin + bridge replace whatever the base image carries (same files in CI).
RUN rm -rf /opt/emperor-claw-plugin
COPY integrations/hermes/emperor-claw/ /opt/emperor-claw-plugin/
COPY tests/contract/hermes/ /opt/contract/
RUN mkdir -p /results && chown -R hermes:hermes /opt/emperor-claw-plugin /opt/contract /results \
    && chmod +x /opt/contract/run_contract.sh

USER hermes
WORKDIR /home/hermes
ENV PATH="/home/hermes/.local/bin:${PATH}" \
    HERMES_REPO=/home/hermes/.hermes/hermes-agent
# The shipped image's healthcheck probes a bridge this image does not run as PID 1.
HEALTHCHECK NONE
ENTRYPOINT ["/opt/contract/run_contract.sh"]
CMD []

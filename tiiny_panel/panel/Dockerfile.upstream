# The Tiiny Control Panel in server mode, for an always-on machine: a home server, a NAS or a Raspberry Pi.
# Easiest: docker/setup.sh sets it up, starts it and shows the address and setup code. By hand: compose.yaml
# (docker compose up -d), then: docker exec tiiny-panel tiiny-panel info.
# The user guide explains it all: docs/USER_GUIDE.md, "Run it on a home server".
#
# The image holds only the panel (Python's standard library, no other packages). Tiiny's own command-line tool isn't
# part of it: the container installs it into /data with Tiiny's installer on its first start. (The start script is in
# /app/bin, not /usr/local/bin, because that installer removes files named *tiiny* there as old copies of its tool.)
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl tzdata \
 && rm -rf /var/lib/apt/lists/*

# Everything the panel keeps is in /data: chats, settings, signed-in devices, and Tiiny's tool with its config.
ENV TIINY_UI_SERVER=1 \
    TIINY_UI_CONTAINER=1 \
    HOME=/data \
    XDG_CONFIG_HOME=/data/config \
    XDG_DATA_HOME=/data/share \
    PATH="/app/bin:/data/.local/tiiny/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY tiiny_ui.py ./
COPY tiinyui/ ./tiinyui/
COPY static/ ./static/
COPY docker/entrypoint.sh /app/bin/tiiny-panel
RUN chmod 0755 /app/bin/tiiny-panel

VOLUME /data
EXPOSE 8765 8766
HEALTHCHECK --interval=30s --timeout=6s --start-period=90s CMD ["/app/bin/tiiny-panel", "health"]
ENTRYPOINT ["/app/bin/tiiny-panel"]

LABEL org.opencontainers.image.title="Tiiny Control Panel" \
      org.opencontainers.image.description="A private web control panel for your Tiiny AI device, in server mode" \
      org.opencontainers.image.source="https://github.com/0xStian/tiiny-control-panel" \
      org.opencontainers.image.licenses="MIT"

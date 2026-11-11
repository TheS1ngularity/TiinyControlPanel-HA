# Home Assistant add-on build of the Tiiny Control Panel (community project by 0xStian, MIT licence).
# panel/ is an unmodified copy of the panel's source; ha/patch_for_ha.py applies the Home Assistant edits at build time.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates curl tzdata \
 && rm -rf /var/lib/apt/lists/*

ENV TIINY_UI_SERVER=1 \
    TIINY_UI_CONTAINER=1 \
    HOME=/data \
    XDG_CONFIG_HOME=/data/config \
    XDG_DATA_HOME=/data/share \
    PATH="/app/bin:/data/.local/tiiny/bin:${PATH}" \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app
COPY panel/tiiny_ui.py ./
COPY panel/tiinyui/ ./tiinyui/
COPY panel/static/ ./static/
COPY panel/docker/entrypoint.sh /app/bin/tiiny-panel
COPY ha/ha-ingress.js ./static/ha-ingress.js
COPY ha/patch_for_ha.py /tmp/patch_for_ha.py
COPY ha/start.py /app/bin/ha-start.py
RUN sed -i 's/\r$//' /app/bin/tiiny-panel \
 && chmod 0755 /app/bin/tiiny-panel \
 && python3 /tmp/patch_for_ha.py /app \
 && python3 -m py_compile /app/tiiny_ui.py \
 && rm /tmp/patch_for_ha.py

HEALTHCHECK --interval=30s --timeout=6s --start-period=90s CMD ["/app/bin/tiiny-panel", "health"]
ENTRYPOINT ["python3", "/app/bin/ha-start.py"]

# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852
FROM ${NODE_IMAGE} AS node
FROM ${UBUNTU_IMAGE} AS base
ENV DEBIAN_FRONTEND=noninteractive NEXT_TELEMETRY_DISABLED=1
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates libglib2.0-0 libgl1 libgomp1 libmagic1 tar && rm -rf /var/lib/apt/lists/*
COPY --from=node /usr/local/ /usr/local/
WORKDIR /app

FROM base AS python-dependencies
COPY services/pdf-parser/requirements-cpu-standard.lock.txt /tmp/python.lock
RUN python3 -m venv /app/.venv && /app/.venv/bin/pip install --no-cache-dir -r /tmp/python.lock

FROM base AS dependencies
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/agent/package.json packages/agent/package.json
COPY packages/contracts/package.json packages/contracts/package.json
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY apps/pi-web/package.json apps/pi-web/package-lock.json apps/pi-web/
RUN cd apps/pi-web && npm ci --ignore-scripts --no-audit --no-fund

FROM dependencies AS build
COPY packages/contracts/ packages/contracts/
COPY apps/pi-web/ apps/pi-web/
COPY scripts/pi-web.mjs scripts/pi-web.mjs
RUN npm run build:web

FROM base AS runtime
ENV NODE_ENV=production T1_SERVER_HOST=127.0.0.1 T1_SERVER_PORT=3210 T1_DATA_DIR=runtime-data T1_IMPORT_RETAINED=false T1_WORKBENCH_MODEL_ENABLED=false \
    HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1 OMP_NUM_THREADS=4 OPENBLAS_NUM_THREADS=4 MKL_NUM_THREADS=4
COPY --from=dependencies /app/node_modules /app/node_modules
COPY --from=python-dependencies /app/.venv /app/.venv
COPY --from=build /app/apps/pi-web /app/apps/pi-web
COPY package.json package-lock.json tsconfig.json ./
COPY packages/ packages/
COPY apps/server/ apps/server/
COPY services/pdf-parser/ services/pdf-parser/
COPY config/pdf-parser.json config/pdf-parser.json
COPY docs/acceptance/s3/parser-selection-2026-11-03/decision.json docs/acceptance/s3/parser-selection-2026-11-03/decision.json
COPY docs/acceptance/s4/selection-optimization/continuation-2026-11-03/supplier-alias-confirmation.json docs/acceptance/s4/selection-optimization/continuation-2026-11-03/supplier-alias-confirmation.json
COPY tests/extraction/fixtures/runtime-responses.ts tests/extraction/fixtures/runtime-responses.ts
COPY deploy/ deploy/
RUN groupadd --gid 10001 t1 && useradd --uid 10001 --gid t1 --no-create-home --home-dir /app/runtime-data t1 && mkdir -p runtime-data .tools/pdf-parser/models && chown 10001:10001 runtime-data
USER 10001:10001
EXPOSE 30141
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=4 CMD ["node", "deploy/healthcheck.mjs"]
CMD ["node", "deploy/supervisor.mjs"]

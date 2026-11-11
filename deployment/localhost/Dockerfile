FROM node:24-bookworm-slim AS web

WORKDIR /src
ARG DAYNIGHT_NPM_REGISTRY=https://registry.npmjs.org/
RUN npm_config_registry="$DAYNIGHT_NPM_REGISTRY" npm install --global pnpm@11.28.6
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
COPY packages/daynight/package.json ./packages/daynight/package.json
COPY packages/daynight/tsconfig*.json ./packages/daynight/
COPY packages/daynight-web/package.json ./packages/daynight-web/package.json
RUN pnpm install --registry="$DAYNIGHT_NPM_REGISTRY" --frozen-lockfile --ignore-scripts --filter @codetreker/daynight-web... --filter @codetreker/daynight...
COPY packages/daynight-web ./packages/daynight-web
COPY packages/daynight/src ./packages/daynight/src
COPY packages/daynight/scripts ./packages/daynight/scripts
RUN pnpm build && node packages/daynight/scripts/package-image-validation.ts /out/image-validation
RUN pnpm web:build

FROM golang:1.27.2-bookworm AS build

WORKDIR /src/packages/daynight-server
COPY packages/daynight-server/go.mod packages/daynight-server/go.sum ./
RUN go mod download
COPY packages/daynight-server/api ./api
COPY packages/daynight-server/cmd ./cmd
COPY packages/daynight-server/internal ./internal
COPY --from=web /src/packages/daynight-server/internal/service/webui/dist ./internal/service/webui/dist
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/daynight-server ./cmd/daynight-server

FROM node:24-bookworm-slim

RUN groupadd --gid 10001 daynight && useradd --uid 10001 --gid daynight --no-create-home daynight \
    && mkdir -p /var/lib/daynight/storage /var/lib/daynight/logs \
    && chmod 0700 /var/lib/daynight/logs \
    && chown 10001:10001 /var/lib/daynight/storage /var/lib/daynight/logs
COPY --from=build --chmod=0555 /out/daynight-server /usr/local/bin/daynight-server
COPY --from=web /out/image-validation /opt/daynight/image-validation
ENV DAYNIGHT_IMAGE_NODE_PATH=/usr/local/bin/node \
    DAYNIGHT_IMAGE_HELPER_PATH=/opt/daynight/image-validation/image-validation-helper.js \
    DAYNIGHT_IMAGE_MANIFEST_PATH=/opt/daynight/image-validation/image-validation-manifest.json \
    DAYNIGHT_IMAGE_TEMP_DIRECTORY=storage/.image-validation
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/daynight-server"]

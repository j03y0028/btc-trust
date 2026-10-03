# syntax=docker/dockerfile:1
# BTC Trust — single image for myNode (amd64 + arm64):
#   * the API serves the built frontend on one port (9330)
#   * bundled Bitcoin Core for the separate TEST wallet node (regtest/signet), started as its own container
# Build:  docker buildx build --platform linux/amd64,linux/arm64 -t btctrust:0.8.0 .

ARG NODE_IMAGE=node:22-bookworm-slim

# ---- 1. frontend (Vite production build, CSP meta injected) ----
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS frontend
WORKDIR /src
COPY shared/ shared/
COPY frontend/package.json frontend/package-lock.json frontend/
RUN npm --prefix frontend ci --no-audit --no-fund
COPY frontend/ frontend/
RUN npm --prefix frontend run build

# ---- 2. backend bundle (esbuild, deps stay external) ----
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS backend
WORKDIR /src
COPY shared/ shared/
COPY backend/package.json backend/package-lock.json backend/
RUN npm --prefix backend ci --no-audit --no-fund
COPY backend/ backend/
RUN npm --prefix backend run build

# ---- 3. production node_modules for the target arch ----
FROM ${NODE_IMAGE} AS deps
WORKDIR /app/backend
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ---- 4. Bitcoin Core (official release, SHA-256 pinned from the GPG-verified SHA256SUMS) ----
#      (downloaded on the build platform with Node's fetch: no distro package manager needed)
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS bitcoin
ARG TARGETARCH
ARG BITCOIN_VERSION=31.1
RUN set -eu; \
    case "$TARGETARCH" in \
      amd64) A=x86_64-linux-gnu;  SHA=b80d9c3e04da78fb6f0569685673418cf686fadba9042d926d13fb87ff503f9e ;; \
      arm64) A=aarch64-linux-gnu; SHA=dcf1873f2208ba4f962f3398d47e154c39c0084be8f4553e05c940d0ace3d004 ;; \
      *) echo "unsupported arch $TARGETARCH" >&2; exit 1 ;; \
    esac; \
    F=bitcoin-${BITCOIN_VERSION}-$A.tar.gz; \
    node -e 'fetch(process.argv[1]).then(async r=>{if(!r.ok)throw new Error("HTTP "+r.status);require("fs").writeFileSync(process.argv[2],Buffer.from(await r.arrayBuffer()))}).catch(e=>{console.error(e);process.exit(1)})' \
      https://bitcoincore.org/bin/bitcoin-core-${BITCOIN_VERSION}/$F /tmp/$F; \
    echo "$SHA  /tmp/$F" | sha256sum -c -; \
    tar -xzf /tmp/$F -C /tmp; \
    install -m 0755 /tmp/bitcoin-${BITCOIN_VERSION}/bin/bitcoind /tmp/bitcoin-${BITCOIN_VERSION}/bin/bitcoin-cli /usr/local/bin/

# ---- 5. runtime ----
FROM ${NODE_IMAGE}
LABEL org.opencontainers.image.title="BTC Trust" \
      org.opencontainers.image.description="Family Bitcoin trust app: read-only mainnet dashboard + test-chain wallets (myNode)" \
      org.opencontainers.image.version="0.8.0"
ENV NODE_ENV=production \
    APP_ROOT=/app \
    STATIC_DIR=/app/frontend/dist \
    DATA_DIR=/data \
    API_HOST=0.0.0.0 \
    API_PORT=9330 \
    HWI_MODE=off \
    AUTH_MODE=on
WORKDIR /app
COPY --from=bitcoin /usr/local/bin/bitcoind /usr/local/bin/bitcoin-cli /usr/local/bin/
COPY --from=deps /app/backend/node_modules backend/node_modules
COPY --from=backend /src/backend/dist backend/dist
COPY --from=backend /src/backend/package.json backend/package.json
COPY --from=frontend /src/frontend/dist frontend/dist
COPY frontend/public/bitcoin.pdf frontend/public/bitcoin.pdf
COPY docker/testnode.sh /usr/local/bin/btctrust-testnode
# Non-root. On myNode the service runs the container as the host's "btctrust" user (--user uid:gid) so files on
# /mnt/hdd/mynode/btctrust stay owned by that user; 10001 is only the default for plain `docker run`.
RUN groupadd -g 10001 btctrust && useradd -u 10001 -g btctrust -M -d /data -s /usr/sbin/nologin btctrust \
 && mkdir -p /data && chown btctrust:btctrust /data && chmod 0700 /data && chmod 0755 /usr/local/bin/btctrust-testnode
USER 10001:10001
VOLUME ["/data"]
EXPOSE 9330
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||9330)+'/api/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "backend/dist/index.mjs"]

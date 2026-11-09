# syntax=docker/dockerfile:1
#
# Signing Guard image. Two stages, both pinned by digest so anyone can
# rebuild the same image from the same inputs:
#
#   build    node:24 slim. `npm ci` installs exactly the lockfile, the
#            TypeScript is compiled and the whole test suite runs. A failing
#            test fails the build.
#   runtime  distroless Node 24: the Node binary, glibc, CA roots and tzdata.
#            No shell, no package manager, no root. The only writable paths
#            are the ones the operator mounts, and the guard mounts none.
#
# Config and keys are never baked in: mount them read-only at /config (see
# docker-compose.example.yml). The image contains no secrets and no policy.
#
# To bump a base image, change the tag and digest together and say so in the
# commit; operators re-verify any change to this file.

FROM node:24.22.2-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c AS build
WORKDIR /build
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY src ./src
COPY test ./test
COPY config/guard.example.json ./config/guard.example.json
COPY quickstart/docker-compose.yml ./quickstart/docker-compose.yml
COPY quickstart/config/guard.json ./quickstart/config/guard.json
RUN npm test \
  && npm prune --omit=dev --ignore-scripts --no-audit --no-fund \
  && rm -rf dist/test

FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /build/node_modules ./node_modules
COPY --from=build /build/dist/src ./dist/src
COPY --from=build /build/package.json ./package.json
# distroless `nonroot` is uid/gid 65532.
USER nonroot
EXPOSE 8443
# No curl in the image: the guard probes its own /readyz.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/dist/src/cli.js", "healthcheck", "--config", "/config/guard.json"]
ENTRYPOINT ["/nodejs/bin/node", "--disable-proto=throw", "/app/dist/src/cli.js"]
CMD ["serve", "--config", "/config/guard.json"]

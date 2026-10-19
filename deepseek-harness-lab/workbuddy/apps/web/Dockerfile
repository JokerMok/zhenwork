FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1 AS build
WORKDIR /app
COPY package*.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/manager/package.json apps/manager/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/parser/package.json apps/parser/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/runtime-contract/package.json packages/runtime-contract/package.json
RUN --mount=type=cache,id=workbuddy-npm,target=/root/.npm npm ci --workspace @workspace/web --include-workspace-root --ignore-scripts --no-audit --no-fund --fetch-timeout=600000 --loglevel=http
COPY apps/web apps/web
COPY packages packages
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build -w @workspace/web
FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
ENV NODE_ENV=production HOSTNAME=0.0.0.0 PORT=3000 NEXT_TELEMETRY_DISABLED=1
RUN apk upgrade --no-cache && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg /root/.npm
USER 10001:10001
CMD ["node","apps/web/server.js"]

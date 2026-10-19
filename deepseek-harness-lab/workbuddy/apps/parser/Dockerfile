FROM node:24-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/parser/package.json apps/parser/package.json
COPY apps/gateway/package.json apps/gateway/package.json
COPY apps/manager/package.json apps/manager/package.json
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/runtime-contract/package.json packages/runtime-contract/package.json
RUN npm ci --workspace=@workspace/parser --include-workspace-root=false --omit=dev --ignore-scripts && npm cache clean --force
COPY apps/parser/src/ apps/parser/src/
RUN apk upgrade --no-cache && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg /root/.npm
USER 10001:10001
ENV NODE_ENV=production
ENTRYPOINT ["node","--max-old-space-size=256","apps/parser/src/main.mjs"]

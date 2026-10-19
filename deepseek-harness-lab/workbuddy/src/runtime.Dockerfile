FROM node:24-bookworm-slim
RUN node -e "const fs=require('fs');fs.mkdirSync('/etc/ssl/certs',{recursive:true});fs.writeFileSync('/etc/ssl/certs/ca-certificates.crt',require('tls').rootCertificates.join('\\n'))"
RUN sed -i 's|http://deb.debian.org|https://deb.debian.org|g' /etc/apt/sources.list.d/debian.sources && apt-get update && apt-get install -y --no-install-recommends git python3 make g++ musl-tools ca-certificates ripgrep bubblewrap && rm -rf /var/lib/apt/lists/*
RUN npm install -g pnpm@11.7.0
WORKDIR /opt/harness
ADD upstream.tar /opt/harness/
RUN pnpm install --frozen-lockfile
RUN DSH_CLIENT_COMMIT_HASH=ddefc45fbc7f8e46dd73185e68295696d1297887 pnpm run build && pnpm --dir native/system run build:native
LABEL workbuddy.upstream.sha="ddefc45fbc7f8e46dd73185e68295696d1297887"
ENV HOME=/home/runtime DSH_HOME=/data/home DSH_TELEMETRY_DISABLED=1
USER 10001:10001
WORKDIR /workspace
CMD ["sleep","infinity"]

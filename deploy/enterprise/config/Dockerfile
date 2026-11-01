# Online-build recipe. Resolve and retain the base digest and package inventory at build time.
ARG UBUNTU_BASE=ubuntu:26.04
FROM ${UBUNTU_BASE} AS runtime
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates libssl3t64 libstdc++6 python3 python3-venv python3-pip git curl ripgrep unzip jq poppler-utils qpdf tesseract-ocr tesseract-ocr-eng tesseract-ocr-chi-sim fonts-noto-cjk python3-pypdf python3-reportlab python3-pil && rm -rf /var/lib/apt/lists/*
RUN python3 -m venv --system-site-packages /opt/zhenwork-office && /opt/zhenwork-office/bin/pip install --no-cache-dir openpyxl==3.1.5 python-docx==1.2.0 python-pptx==1.0.2 xlsxwriter==3.2.9 lxml==6.0.2 pdfplumber==0.11.10 pdf2image==1.17.0 pytesseract==0.3.13 pypdfium2==5.14.0
COPY runtime/node/ /usr/local/
COPY native/officecli native/uv native/uvx /usr/local/bin/
ENV PATH=/opt/zhenwork-office/bin:${PATH}
ENV NODE_PATH=/usr/local/lib/node_modules
WORKDIR /tmp
FROM runtime AS gateway
COPY runtime/gateway-bridge.mjs runtime/egress-policy.mjs /opt/aionui/
USER 10001:10001
ENTRYPOINT ["node","/opt/aionui/gateway-bridge.mjs"]
FROM runtime AS core
COPY native/core/ /opt/aionui/core/
COPY runtime/read_docx.py /opt/aionui/tools/read_docx.py
USER 10001:10001
ENTRYPOINT ["/opt/aionui/core/aioncore"]
FROM ${UBUNTU_BASE} AS redis
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends redis-server ca-certificates && rm -rf /var/lib/apt/lists/* && mkdir /data && chown 10002:10002 /data && chmod 0755 /etc/redis
USER 10002:10002
WORKDIR /data
ENTRYPOINT ["redis-server","/etc/redis/zhenwork.conf"]

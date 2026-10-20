#!/bin/bash
# Install only the official Ubuntu libraries used by controlled Office/OCR tools.
set -euo pipefail
[[ $(id -u) == 0 ]] || { echo 'Run as root' >&2; exit 2; }
if /opt/zhenwork-office/bin/python -c 'import openpyxl,docx,pptx,reportlab' >/dev/null 2>&1 && command -v pdftotext >/dev/null && command -v tesseract >/dev/null; then
  exit 0
fi
export DEBIAN_FRONTEND=noninteractive
apt-get update -o Acquire::Retries=0 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30
apt-get install -y --no-install-recommends python3-openpyxl python3-docx python3-reportlab python3-xlsxwriter python3-typing-extensions python3-venv poppler-utils tesseract-ocr tesseract-ocr-chi-sim
/usr/bin/python3 -m venv --system-site-packages /opt/zhenwork-office
/opt/zhenwork-office/bin/python -m pip install --disable-pip-version-check --no-deps --only-binary=:all: --index-url https://pypi.org/simple python-pptx==1.0.2
/opt/zhenwork-office/bin/python -c 'import openpyxl,docx,pptx,reportlab'

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="${ROOT_DIR}/certs"
TF_DIR="${ROOT_DIR}/terraform"

if [[ -d "${CERT_DIR}" ]]; then
  echo "certs/ already exists; existing files will be preserved and overwritten only for matching Terraform outputs." >&2
else
  mkdir -p "${CERT_DIR}"
fi

certificates="$(terraform -chdir="${TF_DIR}" output -json iot_certificates)"
private_keys="$(terraform -chdir="${TF_DIR}" output -json iot_private_keys)"

# Usa Node (ya es prerrequisito del proyecto) en vez de jq, que no viene en Git Bash.
# Rutas relativas a la raíz del repo para evitar problemas de rutas entre Git Bash y Windows.
cd "${ROOT_DIR}"
CERTS_JSON="${certificates}" KEYS_JSON="${private_keys}" node -e '
const fs = require("fs");
const path = require("path");
const certs = JSON.parse(process.env.CERTS_JSON);
const keys = JSON.parse(process.env.KEYS_JSON);
const units = Object.keys(certs);
if (units.length === 0) {
  console.error("No IoT certificates found in Terraform outputs.");
  process.exit(1);
}
for (const unit of units) {
  const dir = path.join("certs", unit);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "certificate.pem.crt"), certs[unit]);
  fs.writeFileSync(path.join(dir, "private.pem.key"), keys[unit], { mode: 0o600 });
  console.log("Exported " + unit);
}
'

if [[ -f "${CERT_DIR}/AmazonRootCA1.pem" ]]; then
  echo "${CERT_DIR}/AmazonRootCA1.pem already exists; leaving it unchanged." >&2
else
  curl --fail --location --silent --show-error \
    https://www.amazontrust.com/repository/AmazonRootCA1.pem \
    --output "${CERT_DIR}/AmazonRootCA1.pem"
fi

echo "IoT certificates exported under ${CERT_DIR}."
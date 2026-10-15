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

for unit in $(jq -r 'keys[]' <<<"${certificates}"); do
  mkdir -p "${CERT_DIR}/${unit}"
  jq -r --arg unit "${unit}" '.[$unit]' <<<"${certificates}" > "${CERT_DIR}/${unit}/certificate.pem.crt"
  jq -r --arg unit "${unit}" '.[$unit]' <<<"${private_keys}" > "${CERT_DIR}/${unit}/private.pem.key"
  chmod 600 "${CERT_DIR}/${unit}/private.pem.key"
done

if [[ -f "${CERT_DIR}/AmazonRootCA1.pem" ]]; then
  echo "${CERT_DIR}/AmazonRootCA1.pem already exists; leaving it unchanged." >&2
else
  curl --fail --location --silent --show-error \
    https://www.amazontrust.com/repository/AmazonRootCA1.pem \
    --output "${CERT_DIR}/AmazonRootCA1.pem"
fi

echo "IoT certificates exported under ${CERT_DIR}."

#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
SUFFIX="${1:-}"
STATE_BUCKET="${2:-}"

if [[ -z "${SUFFIX}" ]]; then
  echo "usage: $0 <bucket-suffix> [state-bucket-name]" >&2
  exit 2
fi

STATE_BUCKET="${STATE_BUCKET:-snowball-tfstate-${SUFFIX}}"
DASHBOARD_BUCKET="snowball-dashboard-${SUFFIX}"
ARTIFACTS_BUCKET="snowball-artifacts-${SUFFIX}"
ARCHIVE_BUCKET="snowball-archive-${SUFFIX}"

create_if_missing() {
  local bucket="$1"
  if aws s3api head-bucket --bucket "${bucket}" --region "${REGION}" >/dev/null 2>&1; then
    echo "Bucket already exists: ${bucket}"
    return
  fi

  echo "Creating bucket: ${bucket}"
  if [[ "${REGION}" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "${bucket}" --region "${REGION}" >/dev/null
  else
    aws s3api create-bucket \
      --bucket "${bucket}" \
      --region "${REGION}" \
      --create-bucket-configuration LocationConstraint="${REGION}" >/dev/null
  fi
}

put_private_defaults() {
  local bucket="$1"
  aws s3api put-public-access-block \
    --bucket "${bucket}" \
    --region "${REGION}" \
    --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption \
    --bucket "${bucket}" \
    --region "${REGION}" \
    --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
}

put_versioning() {
  aws s3api put-bucket-versioning \
    --bucket "$1" \
    --region "${REGION}" \
    --versioning-configuration Status=Enabled
}

create_if_missing "${STATE_BUCKET}"
put_private_defaults "${STATE_BUCKET}"
put_versioning "${STATE_BUCKET}"

create_if_missing "${DASHBOARD_BUCKET}"

create_if_missing "${ARTIFACTS_BUCKET}"

create_if_missing "${ARCHIVE_BUCKET}"

echo "Buckets created. Terraform will configure dashboard, artifacts and archive; state is fully configured here: ${STATE_BUCKET}"

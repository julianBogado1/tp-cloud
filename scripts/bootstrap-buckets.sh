#!/usr/bin/env bash
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
# Region for the replicated dashboard website bucket. Empty (or unset) keeps the
# old behaviour exactly: four buckets in ${REGION}. Must match the Terraform
# variable dashboard_replica_region, or the apply fails with NoSuchBucket.
DASHBOARD_REPLICA_REGION="${DASHBOARD_REPLICA_REGION:-}"
SUFFIX="${1:-}"
STATE_BUCKET="${2:-}"

if [[ -z "${SUFFIX}" ]]; then
  echo "usage: $0 <bucket-suffix> [state-bucket-name]" >&2
  echo "env: DASHBOARD_REPLICA_REGION=us-west-2 also creates the replicated dashboard bucket" >&2
  exit 2
fi

STATE_BUCKET="${STATE_BUCKET:-snowball-tfstate-${SUFFIX}}"
DASHBOARD_BUCKET="snowball-dashboard-${SUFFIX}"
ARTIFACTS_BUCKET="snowball-artifacts-${SUFFIX}"
ARCHIVE_BUCKET="snowball-archive-${SUFFIX}"
DASHBOARD_REPLICA_BUCKET=""
if [[ -n "${DASHBOARD_REPLICA_REGION}" ]]; then
  DASHBOARD_REPLICA_BUCKET="snowball-dashboard-${SUFFIX}-${DASHBOARD_REPLICA_REGION}"
fi

create_if_missing() {
  local bucket="$1" region="$2"
  if aws s3api head-bucket --bucket "${bucket}" --region "${region}" >/dev/null 2>&1; then
    echo "Bucket already exists: ${bucket}"
    return
  fi

  echo "Creating bucket: ${bucket}"
  if [[ "${region}" == "us-east-1" ]]; then
    aws s3api create-bucket --bucket "${bucket}" --region "${region}" >/dev/null
  else
    aws s3api create-bucket \
      --bucket "${bucket}" \
      --region "${region}" \
      --create-bucket-configuration LocationConstraint="${region}" >/dev/null
  fi
}

put_private_defaults() {
  local bucket="$1" region="$2"
  aws s3api put-public-access-block \
    --bucket "${bucket}" \
    --region "${region}" \
    --public-access-block-configuration \
    BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true
  aws s3api put-bucket-encryption \
    --bucket "${bucket}" \
    --region "${region}" \
    --server-side-encryption-configuration \
    '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'
}

put_versioning() {
  aws s3api put-bucket-versioning \
    --bucket "$1" \
    --region "${REGION}" \
    --versioning-configuration Status=Enabled
}

# Print the plan before touching AWS, so it can be reviewed without credentials.
echo "Buckets to create (name and region):"
echo "  - ${STATE_BUCKET} (${REGION})"
echo "  - ${DASHBOARD_BUCKET} (${REGION})"
echo "  - ${ARTIFACTS_BUCKET} (${REGION})"
echo "  - ${ARCHIVE_BUCKET} (${REGION})"
if [[ -n "${DASHBOARD_REPLICA_BUCKET}" ]]; then
  echo "  - ${DASHBOARD_REPLICA_BUCKET} (${DASHBOARD_REPLICA_REGION})"
else
  echo "(no dashboard replica: set DASHBOARD_REPLICA_REGION=us-west-2 to create it)"
fi

create_if_missing "${STATE_BUCKET}" "${REGION}"
put_private_defaults "${STATE_BUCKET}" "${REGION}"
put_versioning "${STATE_BUCKET}"

create_if_missing "${DASHBOARD_BUCKET}" "${REGION}"

create_if_missing "${ARTIFACTS_BUCKET}" "${REGION}"

create_if_missing "${ARCHIVE_BUCKET}" "${REGION}"

# Only create the replica bucket: Terraform configures encryption, the open
# public access block, the website and the public policy, same as the main one.
if [[ -n "${DASHBOARD_REPLICA_BUCKET}" ]]; then
  create_if_missing "${DASHBOARD_REPLICA_BUCKET}" "${DASHBOARD_REPLICA_REGION}"
fi

echo "Buckets created. Terraform will configure dashboard, artifacts and archive; state is fully configured here: ${STATE_BUCKET} (${REGION})"
if [[ -n "${DASHBOARD_REPLICA_BUCKET}" ]]; then
  echo "Dashboard replica: ${DASHBOARD_REPLICA_BUCKET} (${DASHBOARD_REPLICA_REGION}); Terraform needs dashboard_replica_region=${DASHBOARD_REPLICA_REGION}"
fi

#!/usr/bin/env bash
# Provision one cold-chain unit in AWS IoT Core: thing + X.509 certificate +
# the shared least-privilege policy. Equivalent to the console clicks in
# docs/infra-aws-consola.md §4.3. Run from CloudShell or locally with the
# Academy session credentials exported (aws sts get-caller-identity must work).
#
# Usage: scripts/provision-unit.sh SB-004 [certs-dir]
set -euo pipefail

UNIT="${1:?usage: $0 <UNIT_ID> [certs-dir]}"
CERTS_DIR="${2:-certs}"
POLICY="snowball-device-policy"
REGION="${AWS_REGION:-us-east-1}"
OUT="$CERTS_DIR/$UNIT"

if [[ -e "$OUT/private.pem.key" ]]; then
  echo "refusing to overwrite $OUT/private.pem.key (delete the folder to re-provision)" >&2
  exit 1
fi

if DESCRIBE_ERR=$(aws iot describe-thing --thing-name "$UNIT" --region "$REGION" 2>&1 >/dev/null); then
  : # thing already exists
elif [[ "$DESCRIBE_ERR" == *"ResourceNotFoundException"* ]]; then
  aws iot create-thing --thing-name "$UNIT" --region "$REGION" >/dev/null
else
  echo "describe-thing failed (not a not-found error): $DESCRIBE_ERR" >&2
  exit 1
fi
echo "thing $UNIT ok"

mkdir -p "$OUT"
CERT_JSON=$(aws iot create-keys-and-certificate --set-as-active --region "$REGION" \
  --certificate-pem-outfile "$OUT/certificate.pem.crt" \
  --private-key-outfile "$OUT/private.pem.key" \
  --public-key-outfile "$OUT/public.pem.key")
CERT_ARN=$(echo "$CERT_JSON" | python3 -c 'import json,sys;print(json.load(sys.stdin)["certificateArn"])')
CERT_ID="${CERT_ARN##*/}"
chmod 600 "$OUT/private.pem.key"
echo "certificate $CERT_ARN written to $OUT/"

# From here on, the certificate exists and is ACTIVE in AWS. If either attach
# step below fails, do NOT auto-delete anything (shared classroom account) —
# just print exactly what a human needs to clean up before retrying.
report_attach_failure() {
  echo "" >&2
  echo "provisioning failed after creating certificate $CERT_ARN" >&2
  echo "it is ACTIVE in AWS but not attached to the policy/thing. Clean up before retrying:" >&2
  echo "  aws iot update-certificate --certificate-id $CERT_ID --new-status INACTIVE --region $REGION" >&2
  echo "  aws iot delete-certificate --certificate-id $CERT_ID --region $REGION" >&2
  echo "then remove the local folder (the no-clobber guard blocks re-running otherwise):" >&2
  echo "  rm -rf $OUT" >&2
}
trap report_attach_failure ERR

aws iot attach-policy --policy-name "$POLICY" --target "$CERT_ARN" --region "$REGION"
aws iot attach-thing-principal --thing-name "$UNIT" --principal "$CERT_ARN" --region "$REGION"

trap - ERR
echo "policy $POLICY attached, certificate bound to $UNIT"

if [[ ! -e "$CERTS_DIR/AmazonRootCA1.pem" ]]; then
  curl -fsS https://www.amazontrust.com/repository/AmazonRootCA1.pem -o "$CERTS_DIR/AmazonRootCA1.pem"
  echo "AmazonRootCA1.pem downloaded"
fi

cat <<SQL

-- Run against RDS (adjust client_id / route_id / thresholds):
INSERT INTO units (unit_id, client_id, route_id, description) VALUES ('$UNIT', 1, 1, '$UNIT')
ON CONFLICT (unit_id) DO NOTHING;
INSERT INTO device_config (unit_id, setpoint_c, temp_min_c, temp_max_c, tolerance_min) VALUES ('$UNIT', -18, -25, -15, 5)
ON CONFLICT (unit_id) DO NOTHING;
SQL

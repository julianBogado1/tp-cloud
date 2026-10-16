#!/usr/bin/env bash
# Vacía (incluyendo todas las versiones y delete markers) y borra los buckets
# que crea scripts/bootstrap-buckets.sh. Se corre DESPUÉS de `terraform destroy`:
# Terraform no es dueño de los buckets (el SCP del Learner Lab impide usar
# aws_s3_bucket), así que destroy deja los buckets en pie.
#
# Uso:
#   bash scripts/delete-buckets.sh <bucket-suffix> [state-bucket-name] [--include-state] [--yes]
#
#   --include-state  también borra el bucket del state (por defecto se conserva
#                    porque se reutiliza entre sesiones)
#   --yes            no pide confirmación (para automatizar)
#
# Compatible con Git Bash (Windows), Linux y macOS. No usa jq.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
INCLUDE_STATE=false
ASSUME_YES=false
POSITIONAL=()

for arg in "$@"; do
  case "${arg}" in
    --include-state) INCLUDE_STATE=true ;;
    --yes) ASSUME_YES=true ;;
    *) POSITIONAL+=("${arg}") ;;
  esac
done

SUFFIX="${POSITIONAL[0]:-}"
if [[ -z "${SUFFIX}" ]]; then
  echo "usage: $0 <bucket-suffix> [state-bucket-name] [--include-state] [--yes]" >&2
  exit 2
fi

STATE_BUCKET="${POSITIONAL[1]:-snowball-tfstate-${SUFFIX}}"
BUCKETS=("snowball-dashboard-${SUFFIX}" "snowball-artifacts-${SUFFIX}" "snowball-archive-${SUFFIX}")
if [[ "${INCLUDE_STATE}" == "true" ]]; then
  BUCKETS+=("${STATE_BUCKET}")
fi

echo "Se van a VACIAR y BORRAR estos buckets (región ${REGION}):"
printf '  - %s\n' "${BUCKETS[@]}"
if [[ "${INCLUDE_STATE}" != "true" ]]; then
  echo "(el bucket de state ${STATE_BUCKET} se conserva; usá --include-state para borrarlo también)"
fi

if [[ "${ASSUME_YES}" != "true" ]]; then
  read -r -p "Escribí DELETE para continuar: " answer
  if [[ "${answer}" != "DELETE" ]]; then
    echo "Cancelado."
    exit 1
  fi
fi

# Borra todas las versiones (o delete markers) de un bucket, de a una.
# $2 es la expresión JMESPath: 'Versions' o 'DeleteMarkers'.
delete_all() {
  local bucket="$1" field="$2" key version
  while IFS=$'\t' read -r key version; do
    # Git Bash puede dejar un \r al final de cada línea de la salida de la CLI
    key="${key%$'\r'}"
    version="${version%$'\r'}"
    [[ -z "${key}" || "${key}" == "None" ]] && continue
    aws s3api delete-object --bucket "${bucket}" --key "${key}" \
      --version-id "${version}" --region "${REGION}" >/dev/null
  done < <(aws s3api list-object-versions --bucket "${bucket}" --region "${REGION}" \
    --query "${field}[].[Key,VersionId]" --output text)
}

for bucket in "${BUCKETS[@]}"; do
  if ! aws s3api head-bucket --bucket "${bucket}" --region "${REGION}" >/dev/null 2>&1; then
    echo "No existe (o no es accesible), se omite: ${bucket}"
    continue
  fi
  echo "Vaciando ${bucket} ..."
  delete_all "${bucket}" "Versions"
  delete_all "${bucket}" "DeleteMarkers"
  echo "Borrando ${bucket} ..."
  aws s3api delete-bucket --bucket "${bucket}" --region "${REGION}"
done

echo "Listo."

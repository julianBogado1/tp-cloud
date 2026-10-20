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
#   DASHBOARD_REPLICA_REGION (variable de entorno, la misma que
#                    bootstrap-buckets.sh y var.dashboard_replica_region)
#                    también borra el bucket replicado del dashboard en esa
#                    región. Sin ella el bucket réplica queda HUÉRFANO y su
#                    nombre queda tomado para la próxima sesión del Lab.
#
# Compatible con Git Bash (Windows), Linux y macOS. No usa jq.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
DASHBOARD_REPLICA_REGION="${DASHBOARD_REPLICA_REGION:-}"
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
  echo "env: DASHBOARD_REPLICA_REGION=us-west-2 también borra el bucket replicado del dashboard" >&2
  exit 2
fi

STATE_BUCKET="${POSITIONAL[1]:-snowball-tfstate-${SUFFIX}}"
# Pares "nombre|región": los buckets no viven todos en la misma región. Se usa
# una lista de strings y no un array asociativo porque macOS trae bash 3.2.
BUCKETS=("snowball-dashboard-${SUFFIX}|${REGION}" "snowball-artifacts-${SUFFIX}|${REGION}" "snowball-archive-${SUFFIX}|${REGION}")
if [[ -n "${DASHBOARD_REPLICA_REGION}" ]]; then
  BUCKETS+=("snowball-dashboard-${SUFFIX}-${DASHBOARD_REPLICA_REGION}|${DASHBOARD_REPLICA_REGION}")
fi
if [[ "${INCLUDE_STATE}" == "true" ]]; then
  BUCKETS+=("${STATE_BUCKET}|${REGION}")
fi

echo "Se van a VACIAR y BORRAR estos buckets (nombre y región):"
for entry in "${BUCKETS[@]}"; do
  printf '  - %s (%s)\n' "${entry%%|*}" "${entry##*|}"
done
if [[ -z "${DASHBOARD_REPLICA_REGION}" ]]; then
  echo "(no se borra ningún bucket replicado del dashboard; si existe uno, pasá DASHBOARD_REPLICA_REGION=us-west-2 o queda huérfano)"
fi
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
# $2 es la expresión JMESPath: 'Versions' o 'DeleteMarkers'. $3 es la región del
# bucket (no la global: el bucket réplica vive en otra).
delete_all() {
  local bucket="$1" field="$2" region="$3" key version
  while IFS=$'\t' read -r key version; do
    # Git Bash puede dejar un \r al final de cada línea de la salida de la CLI
    key="${key%$'\r'}"
    version="${version%$'\r'}"
    [[ -z "${key}" || "${key}" == "None" ]] && continue
    aws s3api delete-object --bucket "${bucket}" --key "${key}" \
      --version-id "${version}" --region "${region}" >/dev/null
  done < <(aws s3api list-object-versions --bucket "${bucket}" --region "${region}" \
    --query "${field}[].[Key,VersionId]" --output text)
}

for entry in "${BUCKETS[@]}"; do
  bucket="${entry%%|*}"
  region="${entry##*|}"
  if ! aws s3api head-bucket --bucket "${bucket}" --region "${region}" >/dev/null 2>&1; then
    echo "No existe (o no es accesible), se omite: ${bucket} (${region})"
    continue
  fi
  echo "Vaciando ${bucket} (${region}) ..."
  delete_all "${bucket}" "Versions" "${region}"
  delete_all "${bucket}" "DeleteMarkers" "${region}"
  echo "Borrando ${bucket} (${region}) ..."
  aws s3api delete-bucket --bucket "${bucket}" --region "${region}"
done

echo "Listo."

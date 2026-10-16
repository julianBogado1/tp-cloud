# Learner Lab bucket bootstrap

El Learner Lab bloquea la lectura `s3:GetBucketObjectLockConfiguration` del
provider. Crear los buckets con AWS CLI usando el script idempotente:

```bash
scripts/bootstrap-buckets.sh grupo-01 snowball-tfstate-grupo-01
```

Luego inicializar la raíz con el backend S3:

```bash
terraform -chdir=.. init \
  -backend-config="bucket=snowball-tfstate-grupo-01" \
  -backend-config="key=snowball/terraform.tfstate" \
  -backend-config="region=us-east-1"
```

El script configura completamente el bucket de state. Para los buckets
dashboard, artifacts y archive sólo crea el bucket; su versionado, cifrado,
Public Access Block, website, policy y lifecycle quedan bajo Terraform en la
raíz. Así no hay dos propietarios de la misma configuración.

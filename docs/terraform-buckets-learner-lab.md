# Buckets en AWS Learner Lab

El SCP del Learner Lab deniega `s3:GetBucketObjectLockConfiguration`. Por eso
`aws_s3_bucket` no se usa para crear buckets: puede crearlos y fallar durante la
lectura posterior.

Ejecutar antes de `terraform init`:

```bash
scripts/bootstrap-buckets.sh grupo-01 snowball-tfstate-grupo-01
```

El script es el único propietario de la configuración del bucket de state:
versionado, cifrado y Public Access Block. Para dashboard, artifacts y archive
el script sólo crea los buckets. Terraform administra sus configuraciones
standalone: versionado, cifrado, Public Access Block, website, policy y
lifecycle Glacier del archive.

La raíz usa el lockfile nativo de S3 mediante `use_lockfile = true` y se
inicializa pasando bucket, key y región con `-backend-config`.

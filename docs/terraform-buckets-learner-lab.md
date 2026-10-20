# Buckets en AWS Learner Lab

El SCP del Learner Lab deniega `s3:GetBucketObjectLockConfiguration`. Por eso
`aws_s3_bucket` no se usa para crear buckets: puede crearlos y fallar durante la
lectura posterior.

Ejecutar antes de `terraform init`:

```bash
DASHBOARD_REPLICA_REGION=us-west-2 scripts/bootstrap-buckets.sh grupo-01 snowball-tfstate-grupo-01
```

El script es el único propietario de la configuración del bucket de state:
versionado, cifrado y Public Access Block. Para dashboard, artifacts y archive
el script sólo crea los buckets. Terraform administra sus configuraciones
standalone: versionado, cifrado, Public Access Block, website, policy y
lifecycle Glacier del archive.

**El bucket réplica del dashboard** (`snowball-dashboard-<sufijo>-<region>`, en `us-west-2`) sigue
exactamente el mismo patrón: lo crea el script cuando se le pasa `DASHBOARD_REPLICA_REGION`, y
Terraform administra sus cuatro configuraciones con el argumento `region` por recurso. La variable
tiene que coincidir con `dashboard_replica_region` de Terraform, cuyo **default es `us-west-2`**: si
el script no crea el bucket, el `apply` falla con `NoSuchBucket`.

El mismo valor hace falta en `scripts/delete-buckets.sh` al cerrar la sesión. **Sin él el bucket
réplica sobrevive al `destroy`** —Terraform no es su dueño— y su nombre, que es global, queda tomado
para la próxima sesión.

La raíz usa el lockfile nativo de S3 mediante `use_lockfile = true` y se
inicializa pasando bucket, key y región con `-backend-config`.

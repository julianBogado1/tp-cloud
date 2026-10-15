# Terraform state bootstrap

Run once with local state, before initializing `../`:

```bash
terraform init
terraform apply -var-file=terraform.tfvars
```

Use the resulting bucket with the root backend:

```bash
terraform -chdir=.. init \
  -backend-config="bucket=snowball-tfstate-grupo-01" \
  -backend-config="key=snowball/terraform.tfstate" \
  -backend-config="region=us-east-1"
```

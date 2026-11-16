# How to deploy Snowball to the AWS Learner Lab with Terraform

Step-by-step guide with the real values used in this deployment. Run every
command from the repo root unless noted.

| Value | Used |
|---|---|
| Bucket suffix | `sergio-tp01` |
| State bucket | `snowball-tfstate-sergio-tp01` |
| Region | `us-east-1` (replica site in `us-west-2`) |
| Key pair | `vockey` |
| Alerts email | `sergi.smirnoff@gmail.com` |
| Demo password | `<your-password>` (≥ 8 chars, lowercase + digit). Never commit it. |

Bucket names are global: if `bootstrap-buckets.sh` says the name is taken,
change the suffix everywhere.

## 0. Prerequisites

`terraform` (≥ 1.10), `aws` CLI, `node`/`npm`.

```bash
npm ci
```

If `npm run bundle` fails on esbuild, run `npm install-scripts approve esbuild`.

## 1. Lab credentials (every session, they expire in ~4 h)

1. AWS Academy → Learner Lab → **Start Lab**, wait for the green dot.
2. **AWS Details** → **AWS CLI** → **Show**.
3. Paste the whole `[default]` block into `~/.aws/credentials`.
4. The Lab block has no region, so set it once:

```bash
aws configure set region us-east-1
aws sts get-caller-identity     # must show assumed-role/voclabs/...
```

## 2. Create the buckets (the CLI does it, not Terraform)

The Lab SCP denies `s3:GetBucketObjectLockConfiguration`, so `aws_s3_bucket`
cannot be used. See [terraform-buckets-learner-lab.md](terraform-buckets-learner-lab.md).

```bash
DASHBOARD_REPLICA_REGION=us-west-2 bash scripts/bootstrap-buckets.sh sergio-tp01 snowball-tfstate-sergio-tp01
```

## 3. Variables

`terraform/terraform.tfvars` is gitignored.

```bash
cat > terraform/terraform.tfvars <<EOF
region                 = "us-east-1"
bucket_suffix          = "sergio-tp01"
bastion_allowed_cidr   = "$(curl -s https://checkip.amazonaws.com)/32"
key_name               = "vockey"
demo_user_password     = "<your-password>"
sns_subscription_email = "sergi.smirnoff@gmail.com"
EOF
```

## 4. Build the artifacts

API bundle and the Lambda ZIPs. They must exist before `plan`
(`filemd5` / `filebase64sha256`).

```bash
npm run bundle
```

## 5. Terraform

```bash
terraform -chdir=terraform init \
  -backend-config="bucket=snowball-tfstate-sergio-tp01" \
  -backend-config="key=snowball/terraform.tfstate" \
  -backend-config="region=us-east-1"
terraform -chdir=terraform validate
terraform -chdir=terraform plan
terraform -chdir=terraform apply
```

The first apply takes ~10 minutes (NAT Gateway, ALB, ASG).

**Known issue: DynamoDB KMS race.** If the apply fails with
`KMS validation error ... Key 'arn:aws:kms:...:key/...' does not exist` on a
`snowball-*` table, it is the AWS-managed `alias/aws/dynamodb` key being created
lazily while the tables are created in parallel. Run `terraform apply` again;
only the missing pieces are created.

Then confirm the SNS subscription from the email AWS sends you.

## 6. Dashboard

Vite bakes the ALB and Cognito values into the build, so this goes after the
apply. Without the `VITE_COGNITO_*` variables the login says
"Falta configurar Cognito en el build". Before this step the site URL returns
`404 NoSuchKey index.html`: the bucket is empty.

```bash
ALB=$(terraform -chdir=terraform output -raw alb_dns_name)
BUCKET=$(terraform -chdir=terraform output -raw dashboard_bucket)
REPLICA=$(terraform -chdir=terraform output -raw dashboard_replica_bucket)
VITE_API_BASE="http://${ALB}" \
VITE_COGNITO_DOMAIN="$(terraform -chdir=terraform output -raw cognito_domain_url)" \
VITE_COGNITO_CLIENT_ID="$(terraform -chdir=terraform output -raw cognito_client_id)" \
VITE_AUTH_API="$(terraform -chdir=terraform output -raw auth_api_url)" \
  npm run build -w @snowball/dashboard
aws s3 sync packages/dashboard/dist/ "s3://${BUCKET}/" --delete --region us-east-1
[ -n "${REPLICA}" ] && aws s3 sync packages/dashboard/dist/ "s3://${REPLICA}/" --delete --region us-west-2
terraform -chdir=terraform output -raw dashboard_url
```

Dashboard: <http://snowball-dashboard-sergio-tp01.s3-website-us-east-1.amazonaws.com>

Login: **Ingresar con Cognito**, then one of the demo accounts created by
Terraform with the `demo_user_password`:
`admin@snowball.example`, `supervisor@snowball.example`,
`operator@snowball.example`. Start with admin (sees everything).

Allow 3–5 minutes after the apply for the ASG instances to pass the ALB health
check (`/health`, port 3000).

## 7. Devices and simulator

The simulator runs on your machine and publishes MQTT with each unit's X.509
certificate.

```bash
export AWS_DEFAULT_REGION=us-east-1 AWS_REGION=us-east-1   # or: aws configure set region us-east-1
npx tsx scripts/sync-shadows.ts --endpoint "$(terraform -chdir=terraform output -raw iot_endpoint)"
bash scripts/export-certs.sh
npm run simulator -- --endpoint "$(terraform -chdir=terraform output -raw iot_endpoint)" \
  --units SB-001,SB-002,SB-003 --interval 5 --excursion SB-001@60
```

`Region is missing` from `sync-shadows.ts` means the region is not set (see step 1).

## 8. Trigger the alert emails

- **Thermal excursion:** `--excursion SB-001@60` raises SB-001's temperature
  after 60 s.
- **No signal:** `--silence SB-002@30` stops SB-002 after 30 s. The default
  timeout is 10 minutes (`signal_timeout_min` per unit in
  `snowball-device-config`), checked every minute. To test fast, lower it to 1:

```bash
aws dynamodb update-item --region us-east-1 --table-name snowball-device-config \
  --key '{"unit_id":{"S":"SB-002"}}' \
  --update-expression "SET signal_timeout_min = :t" \
  --expression-attribute-values '{":t":{"N":"1"}}'

npm run simulator -- --endpoint "$(terraform -chdir=terraform output -raw iot_endpoint)" \
  --units SB-001,SB-002,SB-003 --interval 5 --excursion SB-001@60 --silence SB-002@30
```

The no-signal alert fires once per silence; restart the simulator to re-arm it.
The next `terraform apply` may reset the timeout to 10 (seed data). Put it back
by hand with `"N":"10"`.

## 9. Verify that everything works

| What | How |
|---|---|
| Readings reach DynamoDB | `aws dynamodb scan --region us-east-1 --table-name snowball-telemetry --select COUNT --query Count` (run twice, it must grow) |
| Latest state per unit | `aws dynamodb scan --region us-east-1 --table-name snowball-unit-state` |
| Alerts raised | `aws dynamodb scan --region us-east-1 --table-name snowball-alerts --select COUNT --query Count` |
| Lambda processing | `aws logs tail /aws/lambda/snowball-alert-processor --region us-east-1 --since 10m` |
| No-signal monitor | `aws logs tail /aws/lambda/snowball-no-signal-monitor --region us-east-1 --since 5m --follow` |
| Queue | SQS → `snowball-readings` → Monitoring → *Number of messages sent*. It looks empty because the Lambda drains it; the DLQ must stay at 0. |
| Emails | Thermal and no-signal arrive from AWS Notifications (check spam). The SNS subscription must be *Confirmed*. |

Notes:

- The `snowball-readings` queue has no SNS subscriptions on purpose. Flow:
  IoT rule → SQS → `alert-processor` Lambda → SNS → email.
- The only CloudWatch alarm is `snowball-no-signal-alarm` (fleet-wide, no
  messages for 15 minutes). Thermal, battery and per-unit no-signal alerts are
  published by Lambdas to SNS, not by CloudWatch alarms.
- **Archive bucket** (`snowball-archive-sergio-tp01`): filled once a day at
  00:15 UTC by `telemetry-export` (`YYYY/MM/DD/<unit>.ndjson.gz`), Glacier after
  90 days. List it with `aws s3 ls s3://snowball-archive-sergio-tp01 --recursive`
  or force a run with
  `aws lambda invoke --region us-east-1 --function-name snowball-telemetry-export /dev/stdout`.
- **Artifacts bucket** (`snowball-artifacts-sergio-tp01`): holds the API bundle
  that EC2 instances download on boot. It holds deployment files, not data.
- **EC2** instances only run the Express API behind the ALB (2–4 `t3.small`,
  private subnets). They are not part of ingestion or alerting.

## 10. Monitoring (CloudWatch)

`terraform/monitoring.tf` adds infrastructure monitoring on top of the business
alerts. The thermal and per-unit no-signal alerts stay in the Lambdas, because
their thresholds are per unit and live in DynamoDB. CloudWatch watches the
health of the system itself.

- **Ops topic:** `snowball-ops-alerts`, encrypted with the project key, emailing
  `sergi.smirnoff@gmail.com`. It is a separate subscription: **confirm the email
  AWS sends** after the apply.
- **15 alarms** named `snowball-ops-*` (ALARM and recovery both notify):

| Alarm | Fires when |
|---|---|
| `dlq-not-empty` | A reading failed 5 times and reached the dead-letter queue |
| `queue-backlog` | The oldest reading has waited more than 2 minutes |
| `alb-unhealthy-hosts` / `alb-no-healthy-hosts` | An API instance fails the health check / none is healthy |
| `alb-5xx` | More than 5 API server errors in 5 minutes |
| `auth-api-5xx` | The Cognito login bridge returns server errors |
| `iot-rule-failures` | An IoT rule action (DynamoDB or SQS) failed |
| `scheduler-target-errors` | EventBridge Scheduler could not invoke a Lambda |
| `lambda-errors-<function>` | Any of the 4 Lambdas finished with errors |
| `dynamodb-throttles-telemetry` / `-state` | DynamoDB rejected writes |

- **Dashboard `snowball`:** CloudWatch → Dashboards. Queue traffic, backlog and
  DLQ, Lambda invocations and errors, API traffic, DynamoDB writes and the state
  of every alarm. Good single screen for a demo.

Alarms show `INSUFFICIENT_DATA` for a few minutes after creation. The no-signal
alarm may briefly fire while the API instances start after a rebuild.

List them:

```bash
aws cloudwatch describe-alarms --region us-east-1 --alarm-name-prefix snowball \
  --query "MetricAlarms[].[AlarmName,StateValue]" --output text | sort
```

### Simulate a failure to see the alarms fire

Each alarm sends an email to the ops topic when it goes to ALARM and again when
it recovers, so confirm that SNS subscription first. CloudWatch lags the event
by 1–2 minutes, and the dashboard does not refresh by itself: use the refresh
button (times in the console are UTC).

**Dead-letter queue (about 2–3 minutes)** fires `snowball-ops-dlq-not-empty`.
The message is put straight into the DLQ, as if a reading had failed 5 times.

```bash
aws sqs send-message --region us-east-1 \
  --queue-url https://sqs.us-east-1.amazonaws.com/345997015683/snowball-readings-dlq \
  --message-body '{"test":"simulated failure"}'
```

Clean up (the alarm recovers about 2–3 minutes later and sends the OK email;
purging twice within 60 seconds fails, which is normal):

```bash
aws sqs purge-queue --region us-east-1 \
  --queue-url https://sqs.us-east-1.amazonaws.com/345997015683/snowball-readings-dlq
```

**Processing backlog (about 5 minutes)** fires `snowball-ops-queue-backlog`.
Switch off the Lambda that consumes the queue while the simulator runs:

```bash
UUID=$(aws lambda list-event-source-mappings --region us-east-1 \
  --function-name snowball-alert-processor --query "EventSourceMappings[0].UUID" --output text)
aws lambda update-event-source-mapping --region us-east-1 --uuid "$UUID" --no-enabled
```

Turn it back on afterwards. Do not leave it off: thermal alerts stop while the
mapping is disabled.

```bash
aws lambda update-event-source-mapping --region us-east-1 --uuid "$UUID" --enabled
```

**Lambda error (about 5 minutes)** fires `snowball-ops-lambda-errors-alert-processor`
if the handler throws on a malformed event. If the output shows no
`FunctionError`, the handler swallowed it and nothing is counted: use one of the
two above.

```bash
aws lambda invoke --region us-east-1 --function-name snowball-alert-processor \
  --cli-binary-format raw-in-base64-out --payload '{"Records":"broken"}' /dev/stdout
```

Other ways to break it:

- **Fleet no-signal alarm:** stop the simulator for 15 minutes (`snowball-no-signal-alarm`).
- **API self-healing:** terminate one EC2 instance from the console and the ASG
  replaces it. One instance down does not fire `alb-no-healthy-hosts`.

To apply only the monitoring (for example without resetting config values you
edited by hand in DynamoDB), target it:

```bash
terraform -chdir=terraform apply -target=module.ops_alarm -target=aws_cloudwatch_dashboard.ops -target=aws_sns_topic_subscription.ops_email
```

A plain `terraform apply` also restores the seed values of
`snowball-device-config` (for example `signal_timeout_min = 10`).

## 11. Tear down (end of every session)

```bash
terraform -chdir=terraform destroy
DASHBOARD_REPLICA_REGION=us-west-2 bash scripts/delete-buckets.sh sergio-tp01 snowball-tfstate-sergio-tp01
```

Without `DASHBOARD_REPLICA_REGION` the replica bucket survives and its global
name stays taken. After a destroy + apply, run `export-certs.sh` again: every
apply creates new certificates.

The NAT Gateway, ALB and EC2 instances cost money while they run.

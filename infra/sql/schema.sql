-- Snowball — business domain schema (RDS PostgreSQL 15)
-- Telemetry does NOT live here: it goes to DynamoDB (see snowball-variante-b.pdf §11).

CREATE TABLE IF NOT EXISTS clients (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS routes (
    id          SERIAL PRIMARY KEY,
    name        TEXT NOT NULL,
    origin      TEXT NOT NULL,
    destination TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS units (
    -- matches the IoT Core thing name and the DynamoDB partition key
    unit_id     TEXT PRIMARY KEY,
    client_id   INTEGER NOT NULL REFERENCES clients(id),
    route_id    INTEGER REFERENCES routes(id),
    description TEXT,
    active      BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS users (
    id          SERIAL PRIMARY KEY,
    email       TEXT NOT NULL UNIQUE,
    -- bcrypt; the JWT is issued by the API (phase 2)
    password_hash TEXT NOT NULL,
    role        TEXT NOT NULL CHECK (role IN ('operator', 'supervisor', 'admin')),
    client_id   INTEGER REFERENCES clients(id)
);

CREATE TABLE IF NOT EXISTS device_config (
    unit_id        TEXT PRIMARY KEY REFERENCES units(unit_id),
    setpoint_c     NUMERIC(5,2) NOT NULL,
    temp_min_c     NUMERIC(5,2) NOT NULL,
    temp_max_c     NUMERIC(5,2) NOT NULL,
    -- minutes the deviation must be sustained before alerting
    tolerance_min  NUMERIC(6,2) NOT NULL DEFAULT 5,
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (temp_min_c < temp_max_c)
);

CREATE TABLE IF NOT EXISTS alerts (
    id            BIGSERIAL PRIMARY KEY,
    unit_id       TEXT NOT NULL REFERENCES units(unit_id),
    severity      TEXT NOT NULL,
    since         TIMESTAMPTZ NOT NULL,
    emitted_at    TIMESTAMPTZ NOT NULL,
    duration_min  NUMERIC(8,1) NOT NULL,
    temp_c        NUMERIC(5,2),
    detail        TEXT NOT NULL,
    -- acknowledgement: who and when (atomic via transactional UPDATE in the API)
    acknowledged_by INTEGER REFERENCES users(id),
    acknowledged_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS alerts_unit_emitted ON alerts (unit_id, emitted_at DESC);
CREATE INDEX IF NOT EXISTS alerts_unacknowledged ON alerts (emitted_at) WHERE acknowledged_at IS NULL;

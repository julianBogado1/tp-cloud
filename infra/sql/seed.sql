-- Demo data: 2 clients, 1 route, 3 units with thresholds, 1 user per role.
-- Idempotent: safe to run more than once.

INSERT INTO clients (id, name, email) VALUES
  (1, 'Frigorífico Sur SA', 'ops@frigorificosur.example'),
  (2, 'Farma Andina SRL', 'logistica@farmaandina.example')
ON CONFLICT (id) DO NOTHING;
SELECT setval('clients_id_seq', (SELECT MAX(id) FROM clients));

INSERT INTO routes (id, name, origin, destination) VALUES
  (1, 'AMBA — Córdoba', 'Buenos Aires', 'Córdoba')
ON CONFLICT (id) DO NOTHING;
SELECT setval('routes_id_seq', (SELECT MAX(id) FROM routes));

INSERT INTO units (unit_id, client_id, route_id, description) VALUES
  ('SB-001', 1, 1, 'Camión frigorífico — carne'),
  ('SB-002', 1, 1, 'Camión frigorífico — lácteos'),
  ('SB-003', 2, 1, 'Furgón — vacunas')
ON CONFLICT (unit_id) DO NOTHING;

INSERT INTO device_config (unit_id, setpoint_c, temp_min_c, temp_max_c, tolerance_min) VALUES
  ('SB-001', -18, -25, -15, 5),
  ('SB-002', -18, -25, -15, 5),
  -- vaccines: 2-8 °C range and short tolerance, for quick demos
  ('SB-003', 5, 2, 8, 1)
ON CONFLICT (unit_id) DO NOTHING;

-- PLACEHOLDER: generate real bcrypt hashes when the API is implemented (phase 2),
-- e.g. with: node -e "console.log(require('bcryptjs').hashSync('the-password', 10))"
INSERT INTO users (email, password_hash, role, client_id) VALUES
  ('operator@snowball.example',   'REPLACE_BCRYPT_HASH', 'operator', 1),
  ('supervisor@snowball.example', 'REPLACE_BCRYPT_HASH', 'supervisor', 1),
  ('admin@snowball.example',      'REPLACE_BCRYPT_HASH', 'admin', NULL)
ON CONFLICT (email) DO NOTHING;

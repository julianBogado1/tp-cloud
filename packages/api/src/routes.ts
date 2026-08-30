import { Router } from 'express';
import type { IngestedReading } from '@snowball/shared';
import { parseTelemetryQuery, type TelemetryQuery } from './query';

/**
 * REST surface consumed by the static dashboard. Read-only over what the
 * ingest path already stored: units + config from RDS, telemetry from
 * DynamoDB, alerts from RDS. Data access is injected so routes are testable
 * without AWS.
 */

export interface UnitRow {
  unit_id: string;
  description: string | null;
  active: boolean;
  setpoint_c: number | null;
  temp_min_c: number | null;
  temp_max_c: number | null;
}

export interface AlertRow {
  id: number;
  unit_id: string;
  severity: string;
  since: string;
  emitted_at: string;
  duration_min: number;
  temp_c: number | null;
  detail: string;
  acknowledged_at: string | null;
}

export interface DataAccess {
  listUnits(): Promise<UnitRow[]>;
  latestReading(unitId: string): Promise<IngestedReading | undefined>;
  queryTelemetry(unitId: string, query: TelemetryQuery): Promise<IngestedReading[]>;
  listAlerts(limit: number): Promise<AlertRow[]>;
}

export function createRouter(data: DataAccess): Router {
  const router = Router();

  router.get('/units', async (_req, res) => {
    try {
      const units = await data.listUnits();
      const withReadings = await Promise.all(
        units.map(async (unit) => ({
          ...unit,
          last_reading: (await data.latestReading(unit.unit_id)) ?? null,
        })),
      );
      res.json(withReadings);
    } catch (err) {
      console.error('GET /units failed:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.get('/units/:id/telemetry', async (req, res) => {
    let query;
    try {
      query = parseTelemetryQuery(req.query as Record<string, string>);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    try {
      res.json(await data.queryTelemetry(req.params.id, query));
    } catch (err) {
      console.error(`GET /units/${req.params.id}/telemetry failed:`, err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.get('/alerts', async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 1000);
    try {
      res.json(await data.listAlerts(limit));
    } catch (err) {
      console.error('GET /alerts failed:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  return router;
}

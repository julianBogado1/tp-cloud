import { Router } from 'express';
import { getAuth, requireRole } from './auth/middleware';
import { scopeOf } from './auth/scope';
import type { DataAccess } from './data-access';
import { parseTelemetryQuery } from './query';

/**
 * Read surface consumed by the dashboard, filtered by the caller's tenant
 * scope. authenticate() is mounted by index.ts on /api before this router
 * (and by every test in beforeAll), so res.locals.auth is always present here.
 * Data access is injected so the routes are testable without AWS.
 */

export function createRouter(data: DataAccess): Router {
  const router = Router();

  router.get('/units', async (_req, res) => {
    const scope = scopeOf(getAuth(res));
    try {
      const units = await data.listUnits(scope);
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
    const scope = scopeOf(getAuth(res));
    let query;
    try {
      query = parseTelemetryQuery(req.query as Record<string, string>);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
      return;
    }
    try {
      if (!(await data.unitInScope(req.params.id, scope))) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json(await data.queryTelemetry(req.params.id, query));
    } catch (err) {
      console.error(`GET /units/${req.params.id}/telemetry failed:`, err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.get('/alerts', async (req, res) => {
    const scope = scopeOf(getAuth(res));
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
    try {
      res.json(await data.listAlerts(limit, scope));
    } catch (err) {
      console.error('GET /alerts failed:', err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.post('/alerts/:id/ack', requireRole('supervisor'), async (req, res) => {
    const auth = getAuth(res);
    const alertId = Number(req.params.id);
    if (!Number.isInteger(alertId) || alertId < 1) {
      res.status(400).json({ error: 'alert id must be a positive integer' });
      return;
    }
    try {
      const result = await data.acknowledgeAlert(alertId, auth.userId, scopeOf(auth));
      if (result.status === 'not-found') res.status(404).json({ error: 'not found' });
      else if (result.status === 'already') res.status(409).json({ error: 'already acknowledged' });
      else res.json(result.alert);
    } catch (err) {
      console.error(`POST /alerts/${req.params.id}/ack failed:`, err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  return router;
}

/** Mounted last in index.ts so every unmatched /api path is JSON. */
export function notFound(): Router {
  const router = Router();
  router.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });
  return router;
}

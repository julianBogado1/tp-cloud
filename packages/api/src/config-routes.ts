import { Router } from 'express';
import { DEVICE_CONFIG_FIELDS, type ThresholdConfig } from '@snowball/shared';
import { getAuth, requireRole } from './auth/middleware';
import { scopeOf } from './auth/scope';
import type { ConfigPatch, DataAccess } from './data-access';
import type { ShadowClient } from './shadow';

/**
 * Remote configuration (spec §4). The setpoint and the thresholds are pushed to
 * the Device Shadow's desired state (only the edited fields, so the shadow merge
 * keeps the rest) and then stored in DynamoDB, where the alert processor reads
 * them. The shadow is written first so DynamoDB never holds a config the unit
 * was not sent. index.ts mounts authenticate() on /api before this router, so
 * res.locals.auth is set.
 */

function parsePatch(body: unknown): ConfigPatch | string {
  if (typeof body !== 'object' || body === null) return 'body must be a JSON object';
  const patch: ConfigPatch = {};
  for (const field of DEVICE_CONFIG_FIELDS) {
    const value = (body as Record<string, unknown>)[field];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) return `${field} must be a number`;
    patch[field] = value;
  }
  if (Object.keys(patch).length === 0) return `at least one of ${DEVICE_CONFIG_FIELDS.join(', ')} is required`;
  if (patch.tolerance_min !== undefined && patch.tolerance_min < 0) return 'tolerance_min must be >= 0';
  return patch;
}

export function createConfigRouter(data: DataAccess, shadow: ShadowClient | undefined): Router {
  const router = Router();

  router.put('/units/:id/config', requireRole('supervisor'), async (req, res) => {
    const scope = scopeOf(getAuth(res));
    const unitId = req.params.id;
    const patch = parsePatch(req.body);
    if (typeof patch === 'string') {
      res.status(400).json({ error: patch });
      return;
    }
    if (patch.setpoint_c !== undefined && !shadow) {
      res.status(503).json({ error: 'shadow not configured' });
      return;
    }
    try {
      if (!(await data.unitInScope(unitId, scope))) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const current = await data.getConfig(unitId);
      if (!current) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const merged: ThresholdConfig = { ...current, ...patch };
      if (merged.temp_min_c >= merged.temp_max_c) {
        res.status(400).json({ error: 'temp_min_c must be lower than temp_max_c' });
        return;
      }
      if (merged.setpoint_c < merged.temp_min_c || merged.setpoint_c > merged.temp_max_c) {
        res.status(400).json({ error: 'setpoint_c must be between temp_min_c and temp_max_c' });
        return;
      }
      if (shadow) {
        try {
          await shadow.updateDesired(unitId, patch);
        } catch (err) {
          console.error(`[shadow] update failed for ${unitId}:`, err);
          res.status(502).json({ error: 'shadow update failed' });
          return;
        }
      }
      const saved = await data.updateConfig(unitId, patch);
      res.json(shadow ? saved : { ...saved, warning: 'shadow not configured' });
    } catch (err) {
      console.error(`PUT /units/${unitId}/config failed:`, err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  router.get('/units/:id/shadow', async (req, res) => {
    const scope = scopeOf(getAuth(res));
    const unitId = req.params.id;
    if (!shadow) {
      res.status(503).json({ error: 'shadow not configured' });
      return;
    }
    try {
      if (!(await data.unitInScope(unitId, scope))) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      const state = await shadow.get(unitId);
      if (!state) {
        res.status(404).json({ error: 'not found' });
        return;
      }
      res.json(state);
    } catch (err) {
      console.error(`GET /units/${unitId}/shadow failed:`, err);
      res.status(500).json({ error: 'internal error' });
    }
  });

  return router;
}

import { Router } from 'express';
import type { Request, Response } from 'express';
import { getDb, getUnifiedApiKey, regenerateUnifiedKey, getSetting, setSetting } from '../db/index.js';
import { applyProxyUrl, applyProxyEnabled, applyProxyBypass, isProxyActive, getProxyUrl, isProxyEnabled, getProxyBypassPlatforms } from '../lib/proxy.js';
import { getSavedFusionConfig, setSavedFusionConfig, savedFusionConfigSchema, getFusionMaxK } from '../services/fusion.js';
import { isUnifyEnabled, setUnifyEnabled, getUnifyOverrides, setUnifyOverrides, unifyOverridesSchema } from '../services/model-groups.js';
import { getClaudeModelMap, setClaudeModelMap } from '../services/anthropic-map.js';
import { encrypt, decrypt, maskKey } from '../lib/crypto.js';
import {
  getRequestMaxTokensBudget,
  getMaxConsecutiveUpstreamFails,
  REQUEST_MAX_TOKENS_BUDGET_SETTING,
  MAX_CONSECUTIVE_UPSTREAM_FAILS_SETTING,
} from '../lib/guardrails.js';
import { z } from 'zod';

export const settingsRouter = Router();

settingsRouter.get('/openrouter', (_req: Request, res: Response) => {
  const isHighTier = getSetting('openrouter_high_tier') === 'true';
  res.json({ highTier: isHighTier });
});

settingsRouter.put('/openrouter', (req: Request, res: Response) => {
  const highTier = Boolean(req.body.highTier);
  setSetting('openrouter_high_tier', highTier ? 'true' : 'false');
  const db = getDb();
  db.prepare("UPDATE models SET rpd_limit = ?, rpm_limit = ? WHERE platform = 'openrouter'").run(highTier ? 1000 : 50, 20);
  res.json({ highTier });
});

const defaultExposedModels = {
  singular: true,
  fusion: false,
  autoIntelligent: false,
  autoFast: false,
  autoBalanced: false,
};

settingsRouter.get('/exposed-models', (_req: Request, res: Response) => {
  const raw = getSetting('api_exposed_models');
  if (raw) {
    try {
      res.json(JSON.parse(raw));
      return;
    } catch {
      // Fallback below
    }
  }
  res.json(defaultExposedModels);
});

const exposedModelsSchema = z.object({
  singular: z.boolean(),
  fusion: z.boolean(),
  autoIntelligent: z.boolean(),
  autoFast: z.boolean(),
  autoBalanced: z.boolean(),
});

settingsRouter.put('/exposed-models', (req: Request, res: Response) => {
  const parsed = exposedModelsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid exposed models config' } });
    return;
  }
  setSetting('api_exposed_models', JSON.stringify(parsed.data));
  res.json(parsed.data);
});

// Get the model-unification setting: the global toggle (default ON) plus any
// merge/split overrides. Governs the dashboard grouping, /v1/models grouping,
// and cross-provider pin failover.
settingsRouter.get('/unify', (_req: Request, res: Response) => {
  res.json({ enabled: isUnifyEnabled(), overrides: getUnifyOverrides() });
});

const unifyPutSchema = z.object({
  enabled: z.boolean().optional(),
  overrides: unifyOverridesSchema.optional(),
});

// Update the unify toggle and/or overrides. Partial: send just `enabled` to
// flip the switch, or `overrides` to adjust grouping, or both.
settingsRouter.put('/unify', (req: Request, res: Response) => {
  const parsed = unifyPutSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors.map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message)).slice(0, 5).join(', ');
    res.status(400).json({ error: { message: `Invalid unify settings: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  if (parsed.data.enabled !== undefined) setUnifyEnabled(parsed.data.enabled);
  if (parsed.data.overrides) setUnifyOverrides(parsed.data.overrides);
  res.json({ enabled: isUnifyEnabled(), overrides: getUnifyOverrides() });
});

// Get the saved fusion default config (panel mode, models, judge, k, strategy).
settingsRouter.get('/fusion', (_req: Request, res: Response) => {
  res.json({ config: getSavedFusionConfig(), maxK: getFusionMaxK() });
});

// Save the fusion default config. A request's inline `fusion` field still
// overrides this per call (see services/fusion.ts resolveEffectiveConfig).
settingsRouter.put('/fusion', (req: Request, res: Response) => {
  const parsed = savedFusionConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors.map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message)).slice(0, 5).join(', ');
    res.status(400).json({ error: { message: `Invalid fusion config: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  const saved = setSavedFusionConfig(parsed.data);
  res.json({ config: saved, maxK: getFusionMaxK() });
});

// Get the Claude Code model map (opus/sonnet/haiku/default → 'auto' | model_id).
// Drives how the Anthropic /v1/messages route resolves Claude Code's built-in
// model names against the free pool.
settingsRouter.get('/anthropic-map', (_req: Request, res: Response) => {
  res.json({ map: getClaudeModelMap() });
});

// Update the Claude Code model map. Partial: send just the families you want to
// change; each value is 'auto' or a catalog model_id.
settingsRouter.put('/anthropic-map', (req: Request, res: Response) => {
  try {
    res.json({ map: setClaudeModelMap(req.body) });
  } catch (err: any) {
    const detail = err?.errors
      ? err.errors.map((e: any) => (e.path?.length ? `${e.path.join('.')}: ${e.message}` : e.message)).slice(0, 5).join(', ')
      : (err?.message ?? 'invalid');
    res.status(400).json({ error: { message: `Invalid anthropic model map: ${detail}`, type: 'invalid_request_error' } });
  }
});

// Get the request guardrails (per-request token budget + failover circuit
// breaker). Both default to 0 = disabled; see lib/guardrails.ts.
settingsRouter.get('/guardrails', (_req: Request, res: Response) => {
  res.json({
    requestMaxTokensBudget: getRequestMaxTokensBudget(),
    maxConsecutiveUpstreamFails: getMaxConsecutiveUpstreamFails(),
  });
});

const guardrailsPutSchema = z.object({
  requestMaxTokensBudget: z.number().int().min(0).optional(),
  maxConsecutiveUpstreamFails: z.number().int().min(0).optional(),
});

// Update the guardrails. Partial: send just the knob you want to change.
// Takes effect on the next request — no restart needed. 0 disables a knob.
settingsRouter.put('/guardrails', (req: Request, res: Response) => {
  const parsed = guardrailsPutSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors.map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message)).slice(0, 5).join(', ');
    res.status(400).json({ error: { message: `Invalid guardrail settings: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  if (parsed.data.requestMaxTokensBudget !== undefined) {
    setSetting(REQUEST_MAX_TOKENS_BUDGET_SETTING, String(parsed.data.requestMaxTokensBudget));
  }
  if (parsed.data.maxConsecutiveUpstreamFails !== undefined) {
    setSetting(MAX_CONSECUTIVE_UPSTREAM_FAILS_SETTING, String(parsed.data.maxConsecutiveUpstreamFails));
  }
  res.json({
    requestMaxTokensBudget: getRequestMaxTokensBudget(),
    maxConsecutiveUpstreamFails: getMaxConsecutiveUpstreamFails(),
  });
});

// Get the unified API key
settingsRouter.get('/api-key', (_req: Request, res: Response) => {
  res.json({ apiKey: getUnifiedApiKey() });
});

// Regenerate the unified API key
settingsRouter.post('/api-key/regenerate', (_req: Request, res: Response) => {
  const newKey = regenerateUnifiedKey();
  res.json({ apiKey: newKey });
});

// Get the proxy settings
settingsRouter.get('/proxy', (_req: Request, res: Response) => {
  res.json({
    proxyUrl: getProxyUrl(),
    enabled: isProxyEnabled(),
    bypassPlatforms: getProxyBypassPlatforms(),
    active: isProxyActive(),
  });
});

// Set the proxy settings. Accepts partial updates: proxyUrl, enabled, bypassPlatforms.
settingsRouter.put('/proxy', (req: Request, res: Response) => {
  const { proxyUrl, enabled, bypassPlatforms } = req.body as {
    proxyUrl?: string;
    enabled?: boolean;
    bypassPlatforms?: string[];
  };

  // --- proxyUrl ---
  if (typeof proxyUrl === 'string') {
    const trimmed = proxyUrl.trim();
    if (trimmed) {
      try {
        const u = new URL(trimmed);
        if (!['http:', 'https:', 'socks5:', 'socks4:'].includes(u.protocol)) {
          res.status(400).json({
            error: { message: 'Proxy URL must use http, https, socks5, or socks4 scheme', type: 'invalid_request_error' },
          });
          return;
        }
      } catch {
        res.status(400).json({
          error: { message: 'Invalid proxy URL — must be a valid URL like socks5://host:port', type: 'invalid_request_error' },
        });
        return;
      }
      setSetting('proxy_url', trimmed);
    } else {
      setSetting('proxy_url', '');
    }
    applyProxyUrl(trimmed);
  }

  // --- enabled ---
  if (typeof enabled === 'boolean') {
    setSetting('proxy_enabled', enabled ? '1' : '0');
    applyProxyEnabled(enabled);
  }

  // --- bypassPlatforms ---
  if (Array.isArray(bypassPlatforms)) {
    const csv = bypassPlatforms.map(s => s.trim()).filter(Boolean).join(',');
    setSetting('proxy_bypass', csv);
    applyProxyBypass(csv);
  }

  res.json({
    proxyUrl: getProxyUrl(),
    enabled: isProxyEnabled(),
    bypassPlatforms: getProxyBypassPlatforms(),
    active: isProxyActive(),
  });
});

// Get the Artificial Analysis API Key (masked)
settingsRouter.get('/artificial-analysis/key', (_req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM api_keys WHERE platform = 'artificial_analysis' LIMIT 1").get() as { id: number, encrypted_key: string, iv: string, auth_tag: string } | undefined;
  if (!row) {
    res.json({ hasKey: false });
    return;
  }
  try {
    const dec = decrypt(row.encrypted_key, row.iv, row.auth_tag);
    res.json({ hasKey: true, maskedKey: maskKey(dec) });
  } catch (err) {
    res.json({ hasKey: false });
  }
});

// Set the Artificial Analysis API Key
settingsRouter.put('/artificial-analysis/key', (req: Request, res: Response) => {
  const { apiKey } = req.body as { apiKey: string };
  if (!apiKey || typeof apiKey !== 'string') {
    res.status(400).json({ error: { message: 'API Key is required', type: 'invalid_request_error' } });
    return;
  }
  
  const trimmed = apiKey.trim();
  if (!trimmed) {
    res.status(400).json({ error: { message: 'API Key is required', type: 'invalid_request_error' } });
    return;
  }
  
  // If the frontend passed back a masked placeholder, ignore the save
  if (trimmed.includes('...') || trimmed.includes('****') || /^•+$/.test(trimmed)) {
    res.json({ success: true });
    return;
  }

  const db = getDb();
  const { encrypted, iv, authTag } = encrypt(trimmed);
  const existing = db.prepare("SELECT id FROM api_keys WHERE platform = 'artificial_analysis' LIMIT 1").get() as { id: number } | undefined;
  if (existing) {
    db.prepare("UPDATE api_keys SET encrypted_key = ?, iv = ?, auth_tag = ? WHERE id = ?").run(encrypted, iv, authTag, existing.id);
  } else {
    db.prepare("INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status) VALUES ('artificial_analysis', 'Artificial Analysis', ?, ?, ?, 'unknown')").run(encrypted, iv, authTag);
  }
  res.json({ success: true });
});

// Test/Sync Artificial Analysis API
settingsRouter.post('/artificial-analysis/test', async (req: Request, res: Response) => {
  const db = getDb();
  const action = (req.body as any)?.action || 'link'; // 'refresh_list', 'link', 'refresh_data', 'reset_model'
  const row = db.prepare("SELECT * FROM api_keys WHERE platform = 'artificial_analysis' LIMIT 1").get() as { encrypted_key: string, iv: string, auth_tag: string } | undefined;
  if (!row) {
    res.status(400).json({ error: { message: 'No Artificial Analysis API key configured', type: 'invalid_request_error' } });
    return;
  }
  let apiKey = '';
  try {
    apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
  } catch (err) {
    res.status(400).json({ error: { message: 'Failed to decrypt API key', type: 'invalid_request_error' } });
    return;
  }

  try {
    const response = await fetch('https://artificialanalysis.ai/api/v2/data/llms/models', {
      headers: {
        'x-api-key': apiKey,
        'Accept': 'application/json',
      }
    });

    if (!response.ok) {
      res.status(400).json({ error: { message: `API Error: ${response.statusText} (${response.status})` } });
      return;
    }

    const data = await response.json() as any;
    
    const models = Array.isArray(data) ? data : (data.models || data.data || []);
    
    if (action === 'refresh_list') {
      res.json({ success: true, count: models.length, applied_updates: 0, models: [] });
      return;
    }

    if (action === 'reset_model') {
      db.prepare(`
        UPDATE base_models 
        SET aa_id = NULL, aa_slug = NULL, coding_score = NULL, agentic_score = NULL, intelligence_score = NULL, speed_score = NULL, release_date = NULL, pricing_json = NULL, benchmarks_json = NULL, updated_at = datetime('now')
        WHERE aa_id IS NOT NULL OR aa_slug IS NOT NULL
      `).run();
    }

    const baseModels = db.prepare(`
      SELECT * FROM base_models 
      WHERE canonical_id NOT LIKE '%embedding%' 
        AND canonical_id NOT LIKE '%bge%' 
        AND canonical_id NOT LIKE '%rerank%'
        AND canonical_id NOT LIKE '%text-embedding%'
    `).all() as any[];

    const updateStmt = db.prepare(`
      UPDATE base_models 
      SET aa_id = ?, aa_slug = ?, creator = ?, coding_score = ?, agentic_score = ?, intelligence_score = ?, speed_score = ?, release_date = ?, pricing_json = ?, benchmarks_json = ?, updated_at = datetime('now')
      WHERE id = ?
    `);

    let applied = 0;
    const importedModels: any[] = [];
    const normalize = (s: string | undefined) => s ? s.toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    const normalizeBetter = (s: string | undefined) => {
      if (!s) return '';
      let str = s.toLowerCase().replace(/thinking/g, 'reasoning').replace(/[^a-z0-9]/g, ' ');
      const words = str.split(/\s+/).filter(w => !['cf', 'fp8', 'fast', 'super', 'google', 'openai', 'anthropic', 'mistral', 'cohere', 'meta', 'llama', 'nvidia', 'zai', 'z', 'ai', 'qwen', 'moonshotai', 'moonshot', 'chat', 'instruct', 'free', 'nitro', 'preview', 'a3b', 'a12b', 'a22b', 'a55b'].includes(w) && w.length > 0);
      words.sort();
      return words.join('');
    };

    const aaProcessed = models.map((m: any) => {
      const slug = (m.slug || m.id || '').toLowerCase();
      const name = (m.name || m.slug || m.id || '').toLowerCase();
      return { ...m, _slug: slug, _name: name, normSlug: normalize(slug), normName: normalize(name), betterSlug: normalizeBetter(slug), betterName: normalizeBetter(name) };
    });

    for (const bm of baseModels) {
      let match = null;
      
      if (bm.aa_id || bm.aa_slug) {
        match = aaProcessed.find((m: any) => m.id === bm.aa_id || m._slug === bm.aa_slug);
      }
      
      if (!match && action !== 'refresh_data') {
        const canonical = bm.canonical_id;
        const groupLabel = bm.group_label.toLowerCase();
        
        const normCanonical = normalize(canonical);
        const normGroupLabel = normalize(groupLabel);
        
        const betterCanonical = normalizeBetter(canonical);
        const betterGroupLabel = normalizeBetter(groupLabel);

        match = aaProcessed.find((m: any) => {
          if (canonical === m._slug || groupLabel === m._name) return true;
          if (normCanonical === m.normSlug || normGroupLabel === m.normName) return true;
          if (betterCanonical && (betterCanonical === m.betterSlug || betterCanonical === m.betterName)) return true;
          if (betterGroupLabel && (betterGroupLabel === m.betterSlug || betterGroupLabel === m.betterName)) return true;
          return false;
        });
      }

      if (match) {
        const m = match;
        const creator = m.model_creator?.name || m.creator || m.company || '';
        const codingScore = m.evaluations?.artificial_analysis_coding_index ?? m.coding_score ?? m.coding_elo ?? null;
        const agenticScore = m.evaluations?.agentic_score ?? m.agentic_score ?? null;
        const intelScore = m.evaluations?.artificial_analysis_intelligence_index ?? m.elo ?? null;
        const speed = m.median_output_tokens_per_second ?? m.speed ?? null;
        const releaseDate = m.release_date ?? null;
        
        let pricingJson = null;
        if (m.pricing) {
          pricingJson = JSON.stringify({
            price_1m_input_tokens: m.pricing.price_1m_input_tokens,
            price_1m_output_tokens: m.pricing.price_1m_output_tokens,
            price_1m_blended_3_to_1: m.pricing.price_1m_blended_3_to_1
          });
        }
        
        let benchmarksJson = null;
        if (m.evaluations) {
          const ev = { ...m.evaluations };
          delete ev.artificial_analysis_coding_index;
          delete ev.artificial_analysis_intelligence_index;
          delete ev.agentic_score;
          benchmarksJson = JSON.stringify(ev);
        }
        
        updateStmt.run(
          m.id || null,
          m._slug || null,
          creator,
          codingScore,
          agenticScore,
          intelScore,
          speed,
          releaseDate,
          pricingJson,
          benchmarksJson,
          bm.id
        );
        
        applied++;
        
        if (!importedModels.some(im => im.id === (m.slug || m.id))) {
          importedModels.push({ id: m.slug || m.id, name: m.name || m.slug || m.id });
        }
      }
    }

    res.json({ success: true, count: importedModels.length, applied_updates: applied, models: importedModels.slice(0, 10) });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message || 'Network error' } });
  }
});

// Get the full list of Artificial Analysis models for manual linking
settingsRouter.get('/artificial-analysis/models', async (_req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare("SELECT * FROM api_keys WHERE platform = 'artificial_analysis' LIMIT 1").get() as { encrypted_key: string, iv: string, auth_tag: string } | undefined;
  if (!row) {
    res.status(400).json({ error: { message: 'No Artificial Analysis API key configured', type: 'invalid_request_error' } });
    return;
  }
  let apiKey = '';
  try {
    apiKey = decrypt(row.encrypted_key, row.iv, row.auth_tag);
  } catch (err) {
    res.status(400).json({ error: { message: 'Failed to decrypt API key', type: 'invalid_request_error' } });
    return;
  }

  try {
    const response = await fetch('https://artificialanalysis.ai/api/v2/data/llms/models', {
      headers: {
        'x-api-key': apiKey,
        'Accept': 'application/json',
      }
    });

    if (!response.ok) {
      res.status(400).json({ error: { message: `API Error: ${response.statusText} (${response.status})` } });
      return;
    }

    const data = await response.json() as any;
    const models = Array.isArray(data) ? data : (data.models || data.data || []);
    
    // Filter out non-text models from AA (if they provide them)
    const lightweightModels = models
      .filter((m: any) => {
        const t = (m.model_type || m.type || '').toLowerCase();
        return !t.includes('embedding') && !t.includes('image') && !t.includes('video') && !t.includes('audio');
      })
      .map((m: any) => ({
      id: m.id,
      slug: m.slug || m.id,
      name: m.name || m.slug || m.id
    }));
    
    // Also fetch base models so UI knows what is currently linked.
    // Exclude common embedding models that shouldn't be linked to AA.
    const baseModels = db.prepare(`
      SELECT * FROM base_models 
      WHERE canonical_id NOT LIKE '%embedding%' 
        AND canonical_id NOT LIKE '%bge%' 
        AND canonical_id NOT LIKE '%rerank%'
        AND canonical_id NOT LIKE '%text-embedding%'
      ORDER BY group_label ASC
    `).all();

    res.json({ aaModels: lightweightModels, baseModels });
  } catch (err: any) {
    res.status(500).json({ error: { message: err.message || 'Network error' } });
  }
});

// Save a manual link override
settingsRouter.post('/artificial-analysis/link', (req: Request, res: Response) => {
  const { base_model_id, aa_id, aa_slug } = req.body as { base_model_id: number, aa_id: string | null, aa_slug: string | null };
  if (!base_model_id) {
    res.status(400).json({ error: { message: 'base_model_id is required' } });
    return;
  }

  const db = getDb();
  
  if (aa_id || aa_slug) {
    db.prepare(`
      UPDATE base_models 
      SET aa_id = ?, aa_slug = ?, updated_at = datetime('now')
      WHERE id = ?
    `).run(aa_id, aa_slug, base_model_id);
  } else {
    // Unlink
    db.prepare(`
      UPDATE base_models 
      SET aa_id = NULL, aa_slug = NULL, coding_score = NULL, agentic_score = NULL, intelligence_score = NULL, speed_score = NULL, release_date = NULL, pricing_json = NULL, benchmarks_json = NULL, updated_at = datetime('now')
      WHERE id = ?
    `).run(base_model_id);
  }

  res.json({ success: true });
});

// Reset all explicit artificial analysis links
settingsRouter.post('/artificial-analysis/reset-links', (_req: Request, res: Response) => {
  const db = getDb();
  
  const updateStmt = db.prepare(`
    UPDATE base_models 
    SET aa_id = NULL, aa_slug = NULL, coding_score = NULL, agentic_score = NULL, intelligence_score = NULL, speed_score = NULL, release_date = NULL, pricing_json = NULL, benchmarks_json = NULL, updated_at = datetime('now')
    WHERE aa_id IS NOT NULL OR aa_slug IS NOT NULL
  `);

  const info = updateStmt.run();

  res.json({ success: true, reset_count: info.changes });
});

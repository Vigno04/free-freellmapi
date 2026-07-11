import crypto from 'crypto';
import type { Db } from '../db/types.js';
import { getDb, getSetting, setSetting } from '../db/index.js';
import { hasProvider } from '../providers/index.js';
import { MEDIA_PLATFORMS } from './media.js';
import type { Platform } from '@freellmapi/shared/types.js';
import type { Scheduler } from '../lib/scheduler.js';
import {
  applyAllModelOverrides,
  applyModelOverrides,
  deleteTombstonedCatalogModels,
  isCatalogModelTombstoned,
} from './model-state.js';

// Generative-media modalities are routed into the separate media_models table
// (see services/media.ts), never into the chat `models` table.
const MEDIA_MODALITIES = new Set(['image', 'audio']);

/**
 * catalog-sync — keeps the local model catalog in step with the published one.
 *
 * Twice a day (and on demand) the server pulls the signed catalog from the
 * catalog service. A valid Premium license key (Bearer) gets the live tier,
 * refreshed every 2-3 days; everyone else gets the monthly snapshot — so free
 * installs still self-heal, just on a slower cadence. The response is verified
 * against a pinned Ed25519 public key over the exact bytes received; anything
 * unsigned or tampered with is discarded, which means a compromised CDN or
 * MITM cannot inject models or quirks into the router.
 *
 * The bundled migrations remain the baseline: a fetched catalog is applied
 * only when it is NEWER than what the binary shipped with (MIN_CATALOG_VERSION
 * below), so a stale monthly snapshot can never roll back models that a newer
 * app version added via migrations.
 */

const DEFAULT_BASE_URL = 'https://api.freellmapi.co';

// The Ed25519 public key the production catalog is signed with. The private
// half was generated on the catalog host and has never left it. Self-hosters
// running their own catalog server can override both via env.
const PINNED_CATALOG_PUBKEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAq9yv4+3EeyMHKsfVYBhkcz1lYgIXSUeHNnN6tNgYX3k=
-----END PUBLIC KEY-----
`;

// Catalogs older than this are ignored. Bump to today's date whenever a model
// migration lands, so the bundled DB is always the floor.
export const MIN_CATALOG_VERSION = '2026.06.07';

export const SETTING_LICENSE_KEY = 'premium_license_key';
export const SETTING_LICENSE_STATUS = 'premium_license_status';
export const SETTING_CATALOG_SOURCE = 'catalog_source';
export const SETTING_CATALOG_SYNC_INTERVAL = 'catalog_sync_interval';
export const SETTING_CATALOG_FALLBACK_SOURCES = 'catalog_fallback_sources';

const DEFAULT_SYNC_INTERVAL_MS = 12 * 60 * 60 * 1000; // twice daily
const BOOT_DELAY_MS = 10_000; // 10s wait on cold start

export function getSyncIntervalMs(): number {
  const intervalStr = getSetting(SETTING_CATALOG_SYNC_INTERVAL) || '12h';
  switch (intervalStr) {
    case '12h': return 12 * 60 * 60 * 1000;
    case '24h': return 24 * 60 * 60 * 1000;
    case '72h': return 72 * 60 * 60 * 1000;
    case 'weekly': return 7 * 24 * 60 * 60 * 1000;
    default: return DEFAULT_SYNC_INTERVAL_MS;
  }
}

const FETCH_TIMEOUT_MS = 20 * 1000;

// settings table keys
const SETTING_APPLIED_VERSION = 'catalog_applied_version';
const SETTING_APPLIED_TIER = 'catalog_applied_tier';
const SETTING_APPLIED_JSON = 'catalog_applied_json';
const SETTING_LAST_SYNC_MS = 'catalog_last_sync_ms';
const SETTING_LAST_ERROR = 'catalog_last_error';

export const SOURCE_DEFAULT = 'default';
export const SOURCE_FREELLM = 'freellm';

export function catalogBaseUrl(): string {
  return (process.env.CATALOG_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
}

function catalogPublicKey(): crypto.KeyObject {
  const pem = process.env.CATALOG_PUBKEY ? process.env.CATALOG_PUBKEY.replace(/\\n/g, '\n') : PINNED_CATALOG_PUBKEY;
  return crypto.createPublicKey({ key: pem, format: 'pem' });
}

export interface LicenseStatus {
  valid: boolean;
  plan: 'annual' | 'lifetime' | null;
  status: string | null;
  expiresAt: string | null;
  cancelAtPeriodEnd?: boolean;
  reason?: string;
  checkedAtMs: number;
}

interface CatalogQuirk {
  slug: string;
  title: string;
  body: string;
  severity: 'blocker' | 'warning' | 'info';
  targets: { platform: string | null; modelGlob: string | null }[];
}

interface CatalogModel {
  platform: string;
  modelId: string;
  displayName: string;
  intelligenceRank: number;
  speedRank: number;
  sizeLabel: string;
  limits: { rpm: number | null; rpd: number | null; tpm: number | null; tpd: number | null };
  monthlyTokenBudget: string | null;
  contextWindow: number | null;
  enabled: boolean;
  supportsVision: boolean;
  supportsTools: boolean;
  /** 'text' (default/absent) routes to the chat `models` table; 'image'/'audio'
   *  route to the separate `media_models` table. */
  modality?: string;
  /** Short display note for media models (e.g. "Keyless - up to 1024x1024"). */
  mediaNote?: string;
}

interface Catalog {
  version: string;
  generatedAt: string;
  tier: 'live' | 'monthly';
  models: CatalogModel[];
  quirks: CatalogQuirk[];
}

export interface SyncResult {
  ok: boolean;
  action: 'applied' | 'up_to_date' | 'skipped_older' | 'error';
  version?: string;
  tier?: string;
  detail?: string;
  counts?: { updated: number; inserted: number; removed: number; skippedUnknownPlatform: number; quirks: number };
}

/** Minimal structural check — enough to fail loudly on a wrong/garbled body. */
function isCatalog(value: unknown): value is Catalog {
  const c = value as Catalog;
  return (
    !!c &&
    typeof c.version === 'string' &&
    (c.tier === 'live' || c.tier === 'monthly') &&
    Array.isArray(c.models) &&
    Array.isArray(c.quirks) &&
    c.models.every(
      (m) =>
        typeof m?.platform === 'string' &&
        typeof m?.modelId === 'string' &&
        typeof m?.displayName === 'string' &&
        typeof m?.enabled === 'boolean' &&
        !!m?.limits &&
        typeof m.limits === 'object',
    ) &&
    c.quirks.every((q) => typeof q?.slug === 'string' && Array.isArray(q?.targets))
  );
}

function routableContextWindow(platform: string, modelId: string, contextWindow: number | null): number | null {
  if (platform === 'github' && modelId === 'openai/gpt-4.1') return 8000;
  return contextWindow;
}

/**
 * Apply a verified catalog to the local DB inside one transaction.
 *
 * Rules of engagement with user data:
 *  - metadata (name, ranks, limits, context, capabilities) tracks the catalog
 *    unless the user has an explicit local override;
 *  - catalog enabled=false force-disables (the model is dead upstream), but
 *    enabled=true never re-enables a model the user turned off themselves;
 *  - models the user added via custom providers (platform='custom' or bound to
 *    a key) are never touched;
 *  - catalog models the user deleted stay deleted via tombstones;
 *  - models that vanished from the catalog are deleted, exactly like the
 *    dead-model migrations do (fallback_config row first, FK order).
 */
export function applyCatalog(db: Db, catalog: Catalog): NonNullable<SyncResult['counts']> {
  const counts = { updated: 0, inserted: 0, removed: 0, skippedUnknownPlatform: 0, quirks: 0 };

  const selectModel = db.prepare('SELECT id, enabled FROM models WHERE platform = ? AND model_id = ?');
  const updateModel = db.prepare(`
    UPDATE models SET
      display_name = @displayName, intelligence_rank = @intelligenceRank, speed_rank = @speedRank,
      size_label = @sizeLabel, rpm_limit = @rpm, rpd_limit = @rpd, tpm_limit = @tpm, tpd_limit = @tpd,
      monthly_token_budget = @monthlyTokenBudget, context_window = @contextWindow,
      supports_vision = @supportsVision, supports_tools = @supportsTools,
      enabled = @enabled
    WHERE id = @id
  `);
  const insertModel = db.prepare(`
    INSERT INTO models (platform, model_id, display_name, intelligence_rank, speed_rank, size_label,
                        rpm_limit, rpd_limit, tpm_limit, tpd_limit, monthly_token_budget, context_window,
                        enabled, supports_vision, supports_tools)
    VALUES (@platform, @modelId, @displayName, @intelligenceRank, @speedRank, @sizeLabel,
            @rpm, @rpd, @tpm, @tpd, @monthlyTokenBudget, @contextWindow,
            @enabled, @supportsVision, @supportsTools)
  `);

  // Generative-media models go to their own table (never the chat router's pool).
  const selectMedia = db.prepare('SELECT id, enabled FROM media_models WHERE platform = ? AND model_id = ?');
  const updateMedia = db.prepare(`
    UPDATE media_models SET
      display_name = @displayName, modality = @modality, priority = @priority,
      quota_label = @quotaLabel, enabled = @enabled
    WHERE id = @id
  `);
  const insertMedia = db.prepare(`
    INSERT INTO media_models (platform, model_id, display_name, modality, priority, enabled, quota_label)
    VALUES (@platform, @modelId, @displayName, @modality, @priority, @enabled, @quotaLabel)
  `);

  const apply = db.transaction(() => {
    const inCatalog = new Set<string>();
    const inMediaCatalog = new Set<string>();

    for (const m of catalog.models) {
      // Media modalities are gated on MEDIA_PLATFORMS (decoupled from the chat
      // provider registry) and routed to media_models, then skip the chat path.
      const modality = m.modality ?? 'text';
      if (MEDIA_MODALITIES.has(modality)) {
        if (!MEDIA_PLATFORMS.has(m.platform)) {
          counts.skippedUnknownPlatform++;
          continue;
        }
        if (isCatalogModelTombstoned(db, 'media', m.platform, m.modelId)) continue;
        inMediaCatalog.add(`${m.platform}:${m.modelId}`);
        const mrow = selectMedia.get(m.platform, m.modelId) as { id: number; enabled: number } | undefined;
        const mfields = {
          displayName: m.displayName,
          modality,
          priority: m.intelligenceRank ?? 0,
          quotaLabel: m.mediaNote ?? '',
        };
        if (mrow) {
          const enabled = m.enabled ? mrow.enabled : 0; // catalog disable wins; local disable wins
          updateMedia.run({ ...mfields, id: mrow.id, enabled });
          counts.updated++;
        } else {
          insertMedia.run({ ...mfields, platform: m.platform, modelId: m.modelId, enabled: m.enabled ? 1 : 0 });
          counts.inserted++;
        }
        continue;
      }

      if (m.platform === 'custom' || !hasProvider(m.platform as Platform)) {
        // An older binary may receive models for providers it cannot route yet;
        // skip them — they will appear after the user updates the app.
        counts.skippedUnknownPlatform++;
        continue;
      }
      if (isCatalogModelTombstoned(db, 'chat', m.platform, m.modelId)) continue;
      inCatalog.add(`${m.platform}:${m.modelId}`);

      const row = selectModel.get(m.platform, m.modelId) as { id: number; enabled: number } | undefined;
      const fields = {
        displayName: m.displayName,
        intelligenceRank: m.intelligenceRank,
        speedRank: m.speedRank,
        sizeLabel: m.sizeLabel,
        rpm: m.limits.rpm,
        rpd: m.limits.rpd,
        tpm: m.limits.tpm,
        tpd: m.limits.tpd,
        monthlyTokenBudget: m.monthlyTokenBudget,
        contextWindow: routableContextWindow(m.platform, m.modelId, m.contextWindow),
        supportsVision: m.supportsVision ? 1 : 0,
        supportsTools: m.supportsTools ? 1 : 0,
      };
      if (row) {
        // Catalog disable wins (dead upstream); local disable also wins.
        const enabled = m.enabled ? row.enabled : 0;
        updateModel.run({ ...fields, id: row.id, enabled });
        applyModelOverrides(db, m.platform, m.modelId);
        counts.updated++;
      } else {
        insertModel.run({ ...fields, platform: m.platform, modelId: m.modelId, enabled: m.enabled ? 1 : 0 });
        applyModelOverrides(db, m.platform, m.modelId);
        counts.inserted++;
      }
    }

    counts.removed += deleteTombstonedCatalogModels(db);
    applyAllModelOverrides(db);

    // Ensure every model has a fallback_config row (same invariant migrations keep).
    const missingFb = db
      .prepare(
        `SELECT m.id FROM models m LEFT JOIN fallback_config f ON m.id = f.model_db_id WHERE f.id IS NULL`,
      )
      .all() as { id: number }[];
    if (missingFb.length > 0) {
      const maxPriority = (db.prepare('SELECT COALESCE(MAX(priority), 0) AS mx FROM fallback_config').get() as { mx: number }).mx;
      const addFb = db.prepare('INSERT INTO fallback_config (model_db_id, priority, enabled) VALUES (?, ?, 1)');
      missingFb.forEach((r, i) => addFb.run(r.id, maxPriority + 1 + i));
    }

    // Remove catalog-managed models that the catalog no longer lists.
    const candidates = db
      .prepare(`
        SELECT id, platform, model_id
          FROM models
         WHERE platform != 'custom'
           AND key_id IS NULL
           AND size_label NOT IN ('User', 'Custom')
      `)
      .all() as { id: number; platform: string; model_id: string }[];
    const deleteFb = db.prepare('DELETE FROM fallback_config WHERE model_db_id = ?');
    const deleteModel = db.prepare('DELETE FROM models WHERE id = ?');
    for (const c of candidates) {
      if (!hasProvider(c.platform as Platform)) continue; // not catalog-managed by this binary
      if (!inCatalog.has(`${c.platform}:${c.model_id}`)) {
        deleteFb.run(c.id);
        deleteModel.run(c.id);
        counts.removed++;
      }
    }

    // Remove media models the catalog no longer lists (own table, no fallback_config).
    const mediaCandidates = db
      .prepare('SELECT id, platform, model_id FROM media_models')
      .all() as { id: number; platform: string; model_id: string }[];
    const deleteMedia = db.prepare('DELETE FROM media_models WHERE id = ?');
    for (const c of mediaCandidates) {
      if (!MEDIA_PLATFORMS.has(c.platform)) continue; // not media-managed by this binary
      if (!inMediaCatalog.has(`${c.platform}:${c.model_id}`)) {
        deleteMedia.run(c.id);
        counts.removed++;
      }
    }

    // Quirks are pure content: replace wholesale.
    db.prepare('DELETE FROM quirk_targets').run();
    db.prepare('DELETE FROM quirks').run();
    const insertQuirk = db.prepare(
      `INSERT INTO quirks (slug, title, body, severity, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    const insertTarget = db.prepare(
      `INSERT INTO quirk_targets (quirk_id, platform, model_glob) VALUES (?, ?, ?)`,
    );
    const now = Date.now();
    for (const q of catalog.quirks) {
      const info = insertQuirk.run(q.slug, q.title, q.body, q.severity, now, now);
      for (const t of q.targets) insertTarget.run(info.lastInsertRowid, t.platform ?? null, t.modelGlob ?? null);
      counts.quirks++;
    }
  });

  apply();
  return counts;
}

/**
 * Fetch the catalog, verify its signature, and apply it if it moves us forward.
 * `force` skips the `since` short-circuit — used right after a license key is
 * added or removed, where the tier can change without the version changing.
 */

export async function fetchFreellmModels(): Promise<CatalogModel[]> {
  const modelsRes = await fetch('https://freellm.net/models', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!modelsRes.ok) throw new Error(`Failed to fetch freellm.net models: HTTP ${modelsRes.status}`);
  const html = await modelsRes.text();

  const pgRes = await fetch('https://freellm.net/playground', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!pgRes.ok) throw new Error(`Failed to fetch freellm.net playground: HTTP ${pgRes.status}`);
  const pgHtml = await pgRes.text();

  const pgJsonMatch = pgHtml.match(/<script id="playground-data" type="application\/json">([\s\S]*?)<\/script>/);
  const pgItems = pgJsonMatch ? JSON.parse(pgJsonMatch[1]) : [];

  const pgLookup: Record<string, string> = {};
  pgItems.forEach((item: any) => {
    let slug = '';
    if (item.url) {
      const match = item.url.match(/\/models\/[^/]+\/([^/]+)/);
      if (match) slug = match[1].replace(/\/$/, '');
    }
    if (!slug) {
      slug = (item.id || '').toLowerCase().replace(/[\/.:]/g, '-');
    }
    pgLookup[`${item.providerSlug}:${slug}`] = item.apiModelId || item.id;
  });

  const platformMap: Record<string, string> = {
    'nvidia-nim': 'nvidia',
    'openrouter': 'openrouter',
    'cloudflare-workers-ai': 'cloudflare',
    'google-gemini': 'google',
    'ovhcloud-ai-endpoints': 'ovh',
    'groq': 'groq',
    'mistral-ai': 'mistral',
    'llm7-io': 'llm7',
    'cerebras': 'cerebras',
    'cohere': 'cohere',
    'ollama-cloud': 'ollama',
    'opencode': 'opencode',
    'agnes-ai': 'agnes',
    'hugging-face': 'huggingface',
    'kilo-code': 'kilo',
    'z-ai-zhipu-ai': 'zhipu',
    'sambanova': 'sambanova',
    'siliconflow': 'siliconflow',
    'routeway': 'routeway',
    'bazaarlink': 'bazaarlink',
    'ainative': 'ainative',
    'nara': 'nara',
    'ai-horde': 'aihorde',
    'modelscope': 'modelscope',
    'github-models': 'github',
    'aion-labs': 'aionlabs',
    'glhf-chat': 'glhf',
    'chutes-ai': 'chutes',
    'grok-(xai)': 'grok'
  };

  const trRegex = /<tr[^>]*?class="[^"]*?model-row[^"]*?"([^>]*?)>/g;
  let match;
  const models: CatalogModel[] = [];

  while ((match = trRegex.exec(html)) !== null) {
    const attrsStr = match[1];
    const attrs: Record<string, string> = {};
    const attrRegex = /data-([a-zA-Z0-9-]+)="([^"]*?)"/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(attrsStr)) !== null) {
      attrs[attrMatch[1]] = attrMatch[2];
    }

    const providerSlug = attrs['provider-slug'];
    const platform = platformMap[providerSlug];
    if (!platform) continue;

    const rowStart = match.index;
    const rowEnd = html.indexOf('</tr>', rowStart);
    const rowHtml = html.substring(rowStart, rowEnd !== -1 ? rowEnd : html.length);
    
    const hrefMatch = rowHtml.match(/href="\/models\/[^/]+\/([^"]+?)"/);
    const slug = hrefMatch ? hrefMatch[1].replace(/\/$/, '') : '';

    let modelId = pgLookup[`${providerSlug}:${slug}`];

    if (!modelId) {
      modelId = attrs.name;
      if (platform === 'openrouter') {
        modelId = slug.replace('-', '/');
        if (attrs.free === '1' && !modelId.endsWith(':free')) {
          modelId += ':free';
        }
      } else if (platform === 'google') {
        modelId = slug.replace(/-(\d)-(\d)-/g, '-$1.$2-');
      } else if (platform === 'cloudflare') {
        modelId = slug;
        if (modelId.startsWith('cf-')) {
          modelId = '@cf/' + modelId.substring(3).replace(/-(\d)-(\d)-/g, '-$1.$2-').replace('-', '/');
        }
      } else {
        modelId = slug.replace(/-(\d)-(\d)-/g, '-$1.$2-');
      }
    }

    let rpm = null, rpd = null, tpm = null, tpd = null;
    const rateLimitStr = rowHtml.match(/<td[^>]*>([\s\S]*?)<\/td>/g);
    if (rateLimitStr && rateLimitStr[5]) {
      const text = rateLimitStr[5].replace(/<[^>]*>/g, '').trim();
      const rpmMatch = text.match(/(\d+(?:,\d+)?)\s*RPM/i);
      if (rpmMatch) rpm = parseInt(rpmMatch[1].replace(/,/g, ''), 10);
      const rpdMatch = text.match(/(\d+(?:,\d+)?)\s*(?:RPD|req\/day)/i);
      if (rpdMatch) rpd = parseInt(rpdMatch[1].replace(/,/g, ''), 10);
      const tpmMatch = text.match(/(\d+(?:,\d+)?)\s*TPM/i);
      if (tpmMatch) tpm = parseInt(tpmMatch[1].replace(/,/g, ''), 10);
      const tpdMatch = text.match(/(\d+(?:,\d+)?)\s*TPD/i);
      if (tpdMatch) tpd = parseInt(tpdMatch[1].replace(/,/g, ''), 10);
    }

    const contextWindow = attrs.context ? parseInt(attrs.context, 10) : null;
    const isImage = attrs.modality && (attrs.modality.includes('image') || attrs.modality.includes('video'));
    const modality = isImage ? 'image' : 'text';

    models.push({
      platform,
      modelId,
      displayName: attrs.name,
      intelligenceRank: attrs.score ? parseInt(attrs.score, 10) : 50,
      speedRank: 50,
      sizeLabel: 'Free',
      limits: { rpm, rpd, tpm, tpd },
      monthlyTokenBudget: '',
      contextWindow,
      enabled: attrs.free === '1',
      supportsVision: attrs.modality ? attrs.modality.includes('vision') : false,
      supportsTools: true,
      modality
    });
  }
  return models;
}

export async function fetchDefaultCatalog(force = false): Promise<{ catalog: Catalog | null, isNotModified: boolean, rawBytes?: Buffer, error?: Error }> {
  const key = getSetting(SETTING_LICENSE_KEY);
  const applied = getSetting(SETTING_APPLIED_VERSION);
  try {
    const headers: Record<string, string> = {};
    if (key) headers.Authorization = `Bearer ${key}`;
    const url = new URL(`${catalogBaseUrl()}/v1/latest`);
    if (applied && !force) url.searchParams.set('since', applied);

    const res = await fetch(url, { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

    if (res.status === 304) {
      return { catalog: null, isNotModified: true };
    }
    if (!res.ok) throw new Error(`catalog fetch failed: HTTP ${res.status}`);

    const signature = res.headers.get('x-catalog-signature');
    if (!signature) throw new Error('catalog response missing signature');
    const bytes = Buffer.from(await res.arrayBuffer());
    const verified = crypto.verify(null, bytes, catalogPublicKey(), Buffer.from(signature, 'base64'));
    if (!verified) throw new Error('catalog signature verification FAILED — discarding response');

    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isCatalog(parsed)) throw new Error('catalog payload has unexpected shape');
    
    return { catalog: parsed, isNotModified: false, rawBytes: bytes };
  } catch (err) {
    return { catalog: null, isNotModified: false, error: err instanceof Error ? err : new Error(String(err)) };
  }
}

export async function syncCatalog(force = false): Promise<SyncResult> {
  const db = getDb();
  const primarySource = getSetting(SETTING_CATALOG_SOURCE) || SOURCE_DEFAULT;
  const fallbacksStr = getSetting(SETTING_CATALOG_FALLBACK_SOURCES) || '';
  const fallbackSources = fallbacksStr.split(',').map(s => s.trim()).filter(Boolean);

  let primaryCatalog: Catalog | null = null;
  let rawDefaultBytes: Buffer | null = null;
  let defaultTier = getSetting(SETTING_APPLIED_TIER);
  let defaultVersion = getSetting(SETTING_APPLIED_VERSION);

  // 1. Fetch primary
  try {
    if (primarySource === SOURCE_FREELLM) {
      const models = await fetchFreellmModels();
      const d = new Date();
      const versionStr = `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCDate()).padStart(2, '0')}`;
      primaryCatalog = {
        version: versionStr,
        generatedAt: d.toISOString(),
        tier: 'live',
        models: models,
        quirks: []
      };
    } else {
      const result = await fetchDefaultCatalog(force);
      if (result.error) {
        throw result.error;
      }
      if (result.isNotModified) {
        // Not modified, no force, we can short circuit
        setSetting(SETTING_LAST_SYNC_MS, String(Date.now()));
        setSetting(SETTING_LAST_ERROR, '');
        return { ok: true, action: 'up_to_date', version: getSetting(SETTING_APPLIED_VERSION) ?? undefined };
      }
      
      const catalog = result.catalog!;
      if (catalog.version < MIN_CATALOG_VERSION) {
        setSetting(SETTING_LAST_SYNC_MS, String(Date.now()));
        setSetting(SETTING_LAST_ERROR, '');
        return { ok: true, action: 'skipped_older', version: catalog.version, tier: catalog.tier };
      }

      // Check if same as applied
      const sameAsApplied = getSetting(SETTING_APPLIED_VERSION) === catalog.version && getSetting(SETTING_APPLIED_TIER) === catalog.tier;
      if (sameAsApplied && !force) {
        setSetting(SETTING_LAST_SYNC_MS, String(Date.now()));
        setSetting(SETTING_LAST_ERROR, '');
        return { ok: true, action: 'up_to_date', version: catalog.version, tier: catalog.tier };
      }

      primaryCatalog = catalog;
      rawDefaultBytes = result.rawBytes || null;
      defaultTier = catalog.tier;
      defaultVersion = catalog.version;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[catalog-sync] fetch failed: ${message}`);
    setSetting(SETTING_LAST_ERROR, message);
    return { ok: false, action: 'error', detail: message };
  }

  if (!primaryCatalog) {
    return { ok: false, action: 'error', detail: 'Unknown error resolving primary catalog' };
  }

  // 2. Fetch fallbacks
  const fallbackModelsMap = new Map<string, CatalogModel>();
  for (const fallback of fallbackSources) {
    if (fallback === primarySource) continue;
    try {
      if (fallback === SOURCE_FREELLM) {
        const models = await fetchFreellmModels();
        for (const m of models) fallbackModelsMap.set(`${m.platform}:${m.modelId}`, m);
      } else if (fallback === SOURCE_DEFAULT) {
        const result = await fetchDefaultCatalog(true); // force to skip 304
        if (result.catalog) {
          for (const m of result.catalog.models) fallbackModelsMap.set(`${m.platform}:${m.modelId}`, m);
        }
      }
    } catch (err) {
      console.warn(`[catalog-sync] Failed to fetch fallback source ${fallback}`, err);
    }
  }

  // 3. Merge data
  for (const pm of primaryCatalog.models) {
    const fm = fallbackModelsMap.get(`${pm.platform}:${pm.modelId}`);
    if (fm) {
      if (!pm.limits) pm.limits = { rpm: null, rpd: null, tpm: null, tpd: null };
      if (!fm.limits) fm.limits = { rpm: null, rpd: null, tpm: null, tpd: null };
      
      if (pm.intelligenceRank === 50 && fm.intelligenceRank !== 50) pm.intelligenceRank = fm.intelligenceRank;
      if (pm.speedRank === 50 && fm.speedRank !== 50) pm.speedRank = fm.speedRank;
      if (pm.sizeLabel === 'Free' && fm.sizeLabel !== 'Free') pm.sizeLabel = fm.sizeLabel;
      if (pm.limits.rpm === null && fm.limits.rpm !== null) pm.limits.rpm = fm.limits.rpm;
      if (pm.limits.rpd === null && fm.limits.rpd !== null) pm.limits.rpd = fm.limits.rpd;
      if (pm.limits.tpm === null && fm.limits.tpm !== null) pm.limits.tpm = fm.limits.tpm;
      if (pm.limits.tpd === null && fm.limits.tpd !== null) pm.limits.tpd = fm.limits.tpd;
      if (pm.contextWindow === null && fm.contextWindow !== null) pm.contextWindow = fm.contextWindow;
      if (pm.monthlyTokenBudget === '' && fm.monthlyTokenBudget) pm.monthlyTokenBudget = fm.monthlyTokenBudget;
      if ((!pm.modality || pm.modality === 'text') && fm.modality) pm.modality = fm.modality;
      if (!pm.mediaNote && fm.mediaNote) pm.mediaNote = fm.mediaNote;
    }
  }

  // 4. Apply
  try {
    const counts = applyCatalog(db, primaryCatalog);
    
    // Manage Settings
    if (primarySource === SOURCE_DEFAULT) {
      setSetting(SETTING_APPLIED_VERSION, primaryCatalog.version);
      setSetting(SETTING_APPLIED_TIER, primaryCatalog.tier);
      if (rawDefaultBytes) {
        setSetting(SETTING_APPLIED_JSON, rawDefaultBytes.toString('utf8'));
      }
    } else {
      setSetting(SETTING_APPLIED_VERSION, primaryCatalog.version);
      setSetting(SETTING_APPLIED_TIER, primaryCatalog.tier);
      db.prepare('DELETE FROM settings WHERE key = ?').run(SETTING_APPLIED_JSON);
    }

    console.log(
      `[catalog-sync] applied ${primaryCatalog.tier} v${primaryCatalog.version}: ` +
        `${counts.updated} updated, ${counts.inserted} new, ${counts.removed} removed, ` +
        `${counts.quirks} quirks` +
        (counts.skippedUnknownPlatform ? `, ${counts.skippedUnknownPlatform} skipped (unknown platform)` : ''),
    );
    
    setSetting(SETTING_LAST_SYNC_MS, String(Date.now()));
    setSetting(SETTING_LAST_ERROR, '');
    return { ok: true, action: 'applied', version: primaryCatalog.version, tier: primaryCatalog.tier, counts };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[catalog-sync] apply failed: ${message}`);
    setSetting(SETTING_LAST_ERROR, message);
    return { ok: false, action: 'error', detail: message };
  }
}

/** Revalidate the stored license against the catalog service and cache the result. */
export async function refreshLicenseStatus(): Promise<LicenseStatus | null> {
  const key = getSetting(SETTING_LICENSE_KEY);
  if (!key) return null;
  try {
    const res = await fetch(`${catalogBaseUrl()}/v1/license/check`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok && res.status !== 401) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as Omit<LicenseStatus, 'checkedAtMs'>;
    const status: LicenseStatus = { ...body, checkedAtMs: Date.now() };
    setSetting(SETTING_LICENSE_STATUS, JSON.stringify(status));
    return status;
  } catch (err) {
    // Offline or service down: keep the cached status. Entitlement is enforced
    // server-side at /v1/latest anyway — this cache is informational UI state.
    console.warn(`[catalog-sync] license check unreachable: ${err instanceof Error ? err.message : err}`);
    return getCachedLicenseStatus();
  }
}

export function getCachedLicenseStatus(): LicenseStatus | null {
  const raw = getSetting(SETTING_LICENSE_STATUS);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as LicenseStatus;
  } catch {
    return null;
  }
}

export interface CatalogSyncState {
  baseUrl: string;
  source: string;
  appliedVersion: string | null;
  appliedTier: string | null;
  lastSyncMs: number | null;
  lastError: string | null;
}

export function getSyncState(): CatalogSyncState {
  return {
    baseUrl: catalogBaseUrl(),
    source: getSetting(SETTING_CATALOG_SOURCE) || SOURCE_DEFAULT,
    appliedVersion: getSetting(SETTING_APPLIED_VERSION) ?? null,
    appliedTier: getSetting(SETTING_APPLIED_TIER) ?? null,
    lastSyncMs: Number(getSetting(SETTING_LAST_SYNC_MS)) || null,
    lastError: getSetting(SETTING_LAST_ERROR) || null,
  };
}

/**
 * Re-apply the cached (already signature-verified) catalog after boot.
 *
 * Migrations run on every boot and re-assert the bundled baseline — they
 * INSERT OR IGNORE baseline models the catalog may have deleted and re-run
 * the family-rule resets — while the boot-time network sync 304s on an
 * unchanged version and so would NOT re-apply. Without this step every
 * restart drifts the DB back toward the baseline until the next catalog
 * version bump. Re-applying from the local cache is synchronous, needs no
 * network, and keeps the catalog authoritative even offline.
 *
 * Legacy upgrade path: installs that applied a catalog before the cache
 * existed have an applied-version setting but no cached document. Clearing
 * the applied version makes the next poll fetch the full catalog (no `since`
 * short-circuit), which re-applies it and populates the cache.
 */
export function reapplyCachedCatalog(): { reapplied: boolean; version?: string } {
  try {
    const raw = getSetting(SETTING_APPLIED_JSON);
    if (!raw) {
      if (getSetting(SETTING_APPLIED_VERSION)) {
        getDb().prepare('DELETE FROM settings WHERE key = ?').run(SETTING_APPLIED_VERSION);
      }
      return { reapplied: false };
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isCatalog(parsed) || parsed.version < MIN_CATALOG_VERSION) return { reapplied: false };
    applyCatalog(getDb(), parsed);
    console.log(`[catalog-sync] re-applied cached ${parsed.tier} v${parsed.version} after boot`);
    return { reapplied: true, version: parsed.version };
  } catch (err) {
    console.warn(`[catalog-sync] cached catalog re-apply failed: ${err instanceof Error ? err.message : err}`);
    return { reapplied: false };
  }
}

let cancelBootTimer: (() => void) | null = null;
let cancelInterval: (() => void) | null = null;
let savedScheduler: Scheduler | null = null;

export function startCatalogSync(scheduler: Scheduler): void {
  savedScheduler = scheduler;
  if (cancelInterval) return;
  if (process.env.CATALOG_SYNC_DISABLED === '1') {
    console.log('[catalog-sync] disabled via CATALOG_SYNC_DISABLED=1');
    return;
  }
  reapplyCachedCatalog();
  const run = () => {
    void refreshLicenseStatus();
    void syncCatalog();
  };
  
  const intervalMs = getSyncIntervalMs();
  cancelBootTimer = scheduler.after(BOOT_DELAY_MS, run);
  cancelInterval = scheduler.every(intervalMs, run);
  console.log(`[catalog-sync] polling ${catalogBaseUrl()} every ${intervalMs / 3600000}h`);
}

export function stopCatalogSync(): void {
  if (cancelBootTimer) {
    cancelBootTimer();
    cancelBootTimer = null;
  }
  if (cancelInterval) {
    cancelInterval();
    cancelInterval = null;
  }
}

export function rescheduleCatalogSync(): void {
  if (!savedScheduler) return;
  stopCatalogSync();
  startCatalogSync(savedScheduler);
}

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
import { normalizeGroupKey } from './model-groups.js';

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
export const SETTING_CATALOG_SOURCES = 'catalog_sources';
export const SETTING_CATALOG_SOURCE = 'catalog_source'; // legacy
export const SETTING_CATALOG_FALLBACK_SOURCES = 'catalog_fallback_sources'; // legacy
export const SETTING_CATALOG_SYNC_INTERVAL = 'catalog_sync_interval';

export function getCatalogSources(): string[] {
  const json = getSetting(SETTING_CATALOG_SOURCES);
  if (json) {
    try {
      const parsed = JSON.parse(json);
      if (Array.isArray(parsed)) return parsed;
    } catch {}
  }
  // Migration fallback
  const primary = getSetting(SETTING_CATALOG_SOURCE) || SOURCE_DEFAULT;
  const fallbacksStr = getSetting(SETTING_CATALOG_FALLBACK_SOURCES) || '';
  const fallbacks = fallbacksStr.split(',').map(s => s.trim()).filter(Boolean);
  const unique = Array.from(new Set([primary, ...fallbacks]));
  return unique;
}

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
    'aion-labs': 'aion',
    'glhf-chat': 'glhf',
    'chutes-ai': 'chutes',
    'grok-(xai)': 'grok',
    'deepseek': 'deepseek',
    'nscale': 'nscale',
    'nebius': 'nebius',
    'alibaba-cloud-model-studio': 'alibaba',
    'ai21-labs': 'ai21'
  };

  const trRegex = /<tr[^>]*?class="[^"]*?model-row[^"]*?"([^>]*?)>/g;
  let match;
  const models: CatalogModel[] = [];
  const modelProviderSlugs: string[] = [];

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
    
    // Process modalities
    const modStr = (attrs.modality || '').toLowerCase();
    if (modStr.includes('embedding') || modStr.includes('rerank')) {
      // Embedding models are handled by embedding_models table, not the chat/media catalog
      continue;
    }
    
    const isImage = modStr.includes('image') || modStr.includes('video');
    const isAudio = modStr.includes('audio');
    const modality = isImage ? 'image' : (isAudio ? 'audio' : 'text');
    const supportsVision = modStr.includes('vision');

    // Extract size label (e.g. "70B", "1.5B") from the name if present, else fallback to "Free"
    const sizeMatch = attrs.name.match(/(?<![a-zA-Z])(\d+(?:\.\d+)?(?:B|M|T|Trillion|Billion))(?![a-zA-Z])/i);
    const sizeLabel = sizeMatch ? sizeMatch[1].toUpperCase() : 'Free';

    models.push({
      platform,
      modelId,
      displayName: attrs.name,
      intelligenceRank: attrs.score ? parseInt(attrs.score, 10) : 50,
      speedRank: 0,
      sizeLabel,
      limits: { rpm, rpd, tpm, tpd },
      monthlyTokenBudget: '',
      contextWindow,
      enabled: attrs.free === '1',
      supportsVision,
      supportsTools: true,
      modality
    });
    modelProviderSlugs.push(providerSlug);
  }

  // --- Comprehensive Provider Scraping (Limits, Credits & Missing Models) ---
  console.log(`[Sync] Fetching all providers to extract limits and missing models...`);
  const provRes = await fetch('https://freellm.net/providers', { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const allProviders = new Set<string>();
  if (provRes.ok) {
    const provHtml = await provRes.text();
    const regex = /href="\/providers\/([^"]+)"/g;
    let match;
    while ((match = regex.exec(provHtml)) !== null) {
      if (!match[1].includes('#')) allProviders.add(match[1]);
    }
  }

  // Ensure we also check any provider we found from the models table
  for (const slug of modelProviderSlugs) {
    if (slug) allProviders.add(slug);
  }

  const defaultLimitsBySlug: Record<string, { rpm: number | null, rpd: number | null, tpm: number | null, tpd: number | null }> = {};
  const modelsByProvider: Record<string, string[]> = {};

  if (allProviders.size > 0) {
    const promises = Array.from(allProviders).map(async slug => {
      try {
        const res = await fetch(`https://freellm.net/providers/${slug}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
        if (!res.ok) return;
        const html = await res.text();
        const text = html.replace(/<[^>]+>/g, ' ');
        const rpmMatch = text.match(/(\d+(?:,\d+)?)\s*RPM/i);
        const rpdMatch = text.match(/(\d+(?:,\d+)?)\s*(?:RPD|req\/day|requests? per day)/i);
        const tpmMatch = text.match(/(\d+(?:,\d+)?)\s*TPM/i);
        const tpdMatch = text.match(/(\d+(?:,\d+)?)\s*TPD/i);
        const neuronsMatch = text.match(/(\d+(?:,\d+)?)\s*Neurons\/day/i);
        
        let tpd = tpdMatch ? parseInt(tpdMatch[1].replace(/,/g, ''), 10) : null;
        if (neuronsMatch) {
          // Cloudflare: 10,000 Neurons is ~300 requests. If each request is ~1k tokens, 10,000 neurons = 300,000 tokens.
          // Map Neurons * 30 to TPD.
          tpd = parseInt(neuronsMatch[1].replace(/,/g, ''), 10) * 30;
        }

        let rpm = rpmMatch ? parseInt(rpmMatch[1].replace(/,/g, ''), 10) : null;
        let rpd = rpdMatch ? parseInt(rpdMatch[1].replace(/,/g, ''), 10) : null;

        if (slug === 'openrouter') {
          const highTier = getSetting('openrouter_high_tier') === 'true';
          rpd = highTier ? 1000 : 50;
          rpm = 20;
        }

        defaultLimitsBySlug[slug] = {
          rpm,
          rpd,
          tpm: tpmMatch ? parseInt(tpmMatch[1].replace(/,/g, ''), 10) : null,
          tpd: tpd,
        };

        const providerModels: string[] = [];
        const modelRegex = /href="\/models\/[^/"]+\/([^/"]+)"/g;
        let mMatch;
        while ((mMatch = modelRegex.exec(html)) !== null) {
          if (!providerModels.includes(mMatch[1])) {
            providerModels.push(mMatch[1]);
          }
        }
        modelsByProvider[slug] = providerModels;
      } catch (err) {
        console.warn(`[Sync] Failed to fetch data for provider ${slug}: ${err}`);
      }
    });
    await Promise.allSettled(promises);
  }

  // Add missing models found on provider pages that weren't in the main models table
  for (const [slug, providerModels] of Object.entries(modelsByProvider)) {
    const platform = platformMap[slug];
    if (!platform) continue;
    
    for (const mSlug of providerModels) {
      // Look up API Model ID
      let apiModelId = pgLookup[`${slug}:${mSlug}`];
      if (!apiModelId) {
        if (platform === 'openrouter') {
          apiModelId = mSlug.replace('-', '/');
          if (!apiModelId.endsWith(':free')) apiModelId += ':free';
        } else if (platform === 'cloudflare') {
          apiModelId = mSlug.startsWith('cf-') ? '@cf/' + mSlug.substring(3).replace('-', '/') : mSlug;
        } else {
          apiModelId = mSlug;
        }
      }

      const existingIndex = models.findIndex(m => m.platform === platform && (m.modelId === apiModelId || m.modelId === mSlug));
      if (existingIndex === -1) {
        models.push({
          platform,
          modelId: apiModelId,
          displayName: mSlug,
          intelligenceRank: 50,
          speedRank: 0,
          sizeLabel: 'Free',
          limits: { rpm: null, rpd: null, tpm: null, tpd: null },
          monthlyTokenBudget: '',
          contextWindow: null,
          enabled: true,
          supportsVision: false,
          supportsTools: true,
          modality: 'text'
        });
        modelProviderSlugs.push(slug);
      }
    }
  }

  // Apply default limits and credits to all models
  for (let i = 0; i < models.length; i++) {
    const lim = models[i].limits;
    const def = defaultLimitsBySlug[modelProviderSlugs[i]];
    if (def) {
      if (lim && lim.rpm === null && lim.rpd === null && lim.tpm === null && lim.tpd === null) {
        models[i].limits = { rpm: def.rpm, rpd: def.rpd, tpm: def.tpm, tpd: def.tpd };
      }
    }
  }

  return models;
}

export async function fetchDefaultCatalog(force = false): Promise<{ catalog: Catalog | null, isNotModified: boolean, rawBytes?: Buffer, error?: Error }> {
  const key = getSetting(SETTING_LICENSE_KEY);
  const applied = getSetting(SETTING_APPLIED_VERSION);
  const tier = getSetting(SETTING_APPLIED_TIER);
  try {
    const headers: Record<string, string> = {};
    if (key) headers.Authorization = `Bearer ${key}`;
    const url = new URL(`${catalogBaseUrl()}/v1/latest`);
    if (applied && !force) url.searchParams.set('since', applied);

    const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

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

export async function fetchSource(source: string, force: boolean): Promise<{ catalog: Catalog | null, isNotModified: boolean, rawBytes?: Buffer, error?: Error }> {
  if (source === SOURCE_FREELLM) {
    try {
      const models = await fetchFreellmModels();
      const d = new Date();
      const versionStr = `${d.getUTCFullYear()}.${String(d.getUTCMonth() + 1).padStart(2, '0')}.${String(d.getUTCDate()).padStart(2, '0')}`;
      return {
        catalog: { version: versionStr, generatedAt: d.toISOString(), tier: 'live', models, quirks: [] },
        isNotModified: false
      };
    } catch (err) {
      return { catalog: null, isNotModified: false, error: err instanceof Error ? err : new Error(String(err)) };
    }
  } else if (source === SOURCE_DEFAULT) {
    return fetchDefaultCatalog(force);
  } else if (source.startsWith('http://') || source.startsWith('https://')) {
    try {
      const res = await fetch(source, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (!isCatalog(body)) throw new Error('catalog payload has unexpected shape');
      return { catalog: body, isNotModified: false };
    } catch (err) {
      return { catalog: null, isNotModified: false, error: err instanceof Error ? err : new Error(String(err)) };
    }
  }
  return { catalog: null, isNotModified: false, error: new Error(`Unknown source: ${source}`) };
}

function mergeFields(existing: CatalogModel, m: CatalogModel) {
  if (existing.intelligenceRank === 50 && m.intelligenceRank !== 50) existing.intelligenceRank = m.intelligenceRank;
  if (existing.speedRank === 50 && m.speedRank !== 50) existing.speedRank = m.speedRank;
  if (existing.sizeLabel === 'Free' && m.sizeLabel !== 'Free') existing.sizeLabel = m.sizeLabel;
  if (!existing.limits) existing.limits = { rpm: null, rpd: null, tpm: null, tpd: null };
  if (m.limits) {
    if (existing.limits.rpm === null && m.limits.rpm !== null) existing.limits.rpm = m.limits.rpm;
    if (existing.limits.rpd === null && m.limits.rpd !== null) existing.limits.rpd = m.limits.rpd;
    if (existing.limits.tpm === null && m.limits.tpm !== null) existing.limits.tpm = m.limits.tpm;
    if (existing.limits.tpd === null && m.limits.tpd !== null) existing.limits.tpd = m.limits.tpd;
  }
  if (existing.contextWindow === null && m.contextWindow !== null) existing.contextWindow = m.contextWindow;
  if (!existing.monthlyTokenBudget && m.monthlyTokenBudget) existing.monthlyTokenBudget = m.monthlyTokenBudget;
  if ((!existing.modality || existing.modality === 'text') && m.modality) existing.modality = m.modality;
  if (!existing.mediaNote && m.mediaNote) existing.mediaNote = m.mediaNote;
}

export async function syncCatalog(force = false): Promise<SyncResult> {
  const db = getDb();
  const sources = getCatalogSources();

  let appliedVersion: string | undefined = getSetting(SETTING_APPLIED_VERSION);
  let appliedTier: string | undefined = getSetting(SETTING_APPLIED_TIER);
  let rawDefaultBytes: Buffer | null = null;

  const finalModels = new Map<string, CatalogModel>();
  const firstModelIdForGroup = new Map<string, string>();
  const mergedQuirks: Catalog['quirks'] = [];

  let hadError = false;
  let lastErrMsg = '';

  for (const source of sources) {
    const isPrimary = source === sources[0];
    const isDefault = source === SOURCE_DEFAULT;

    // Only skip via 304 if this is the ONLY source and it's default
    const shouldForce = (isPrimary && isDefault && sources.length === 1) ? force : true;
    
    const result = await fetchSource(source, shouldForce);
    
    if (result.error) {
      console.warn(`[catalog-sync] fetch failed for ${source}:`, result.error.message);
      hadError = true;
      lastErrMsg = result.error.message;
      continue;
    }

    if (isPrimary && isDefault) {
      if (result.isNotModified && !force && sources.length === 1) {
        return { ok: true, action: 'up_to_date', version: getSetting(SETTING_APPLIED_VERSION) ?? undefined };
      }
      if (result.catalog && result.catalog.version < MIN_CATALOG_VERSION && sources.length === 1) {
        return { ok: true, action: 'skipped_older', version: result.catalog.version, tier: result.catalog.tier };
      }
      if (result.catalog) {
        appliedVersion = result.catalog.version;
        appliedTier = result.catalog.tier;
        rawDefaultBytes = result.rawBytes || null;
      } else {
        // The fallback_config rows inserted by 000000_legacy_baseline migration
        // have an applied tier of 'legacy'. This is a sentinel value that means
        // the app just booted fresh. If we haven't synced yet, this is our only
        // chance to insert the bundled JSON models into the chat router.
        console.warn(`[catalog-sync] fresh boot: applying bundled baseline catalog`);
        const result = await fetchDefaultCatalog(true);
        if (result.catalog) {
           applyCatalog(db, result.catalog);
        }
      }
    } else if (isPrimary && source === SOURCE_FREELLM) {
      if (result.catalog) {
        appliedVersion = result.catalog.version;
        appliedTier = result.catalog.tier;
      }
    }

    if (!result.catalog) continue;

    for (const q of result.catalog.quirks) {
      if (!mergedQuirks.find(existing => existing.slug === q.slug)) {
        mergedQuirks.push(q);
      }
    }

    for (const m of result.catalog.models) {
      const exactKey = `${m.platform}:${m.modelId}`;
      const groupKey = `${m.platform}:${normalizeGroupKey(m.displayName)}`;

      if (finalModels.has(exactKey)) {
        mergeFields(finalModels.get(exactKey)!, m);
      } else {
        if (firstModelIdForGroup.has(groupKey)) {
          const primaryModelId = firstModelIdForGroup.get(groupKey)!;
          const primaryExactKey = `${m.platform}:${primaryModelId}`;
          const existing = finalModels.get(primaryExactKey);
          if (existing) mergeFields(existing, m);
        } else {
          finalModels.set(exactKey, m);
          if (!firstModelIdForGroup.has(groupKey)) {
            firstModelIdForGroup.set(groupKey, m.modelId);
          }
        }
      }
    }
  }

  if (finalModels.size === 0 && hadError) {
    setSetting(SETTING_LAST_ERROR, lastErrMsg);
    return { ok: false, action: 'error', detail: lastErrMsg };
  }

  const finalCatalog: Catalog = {
    version: appliedVersion || '1.0.0',
    tier: (appliedTier as 'live' | 'monthly') || 'live',
    generatedAt: new Date().toISOString(),
    models: Array.from(finalModels.values()),
    quirks: mergedQuirks
  };

  try {
    const counts = applyCatalog(db, finalCatalog);
    
    // Manage Settings
    if (sources[0] === SOURCE_DEFAULT) {
      setSetting(SETTING_APPLIED_VERSION, finalCatalog.version);
      setSetting(SETTING_APPLIED_TIER, finalCatalog.tier);
      if (rawDefaultBytes) {
        setSetting(SETTING_APPLIED_JSON, rawDefaultBytes.toString('utf8'));
      }
    } else {
      setSetting(SETTING_APPLIED_VERSION, finalCatalog.version);
      setSetting(SETTING_APPLIED_TIER, finalCatalog.tier);
      db.prepare('DELETE FROM settings WHERE key = ?').run(SETTING_APPLIED_JSON);
    }

    console.log(
      `[catalog-sync] applied ${finalCatalog.tier} v${finalCatalog.version}: ` +
        `${counts.updated} updated, ${counts.inserted} new, ${counts.removed} removed, ` +
        `${counts.quirks} quirks` +
        (counts.skippedUnknownPlatform ? `, ${counts.skippedUnknownPlatform} skipped (unknown platform)` : ''),
    );
    
    setSetting(SETTING_LAST_SYNC_MS, String(Date.now()));
    setSetting(SETTING_LAST_ERROR, '');
    return { ok: true, action: 'applied', version: finalCatalog.version, tier: finalCatalog.tier, counts };
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

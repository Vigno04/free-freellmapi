/**
 * Model grouping — "unify" the same logical model that several providers serve
 * into ONE item. The `models` table keeps one row per (platform, model_id); a
 * model offered by N providers is N rows. This module computes a logical group
 * for those rows at runtime (NO schema change) from the curated `display_name`,
 * plus operator overrides stored as JSON in the existing `settings` table.
 *
 * Pure by design: the core functions (normalizeGroupKey / groupRows /
 * resolveRequestedIdToMembers) take rows as arguments and touch no globals, so
 * they're trivially unit-testable. Only the settings getters/setters and the
 * getModelGroups() convenience touch the DB.
 *
 * Gated by the `unify_models_enabled` setting (default ON). When OFF, callers
 * keep their pre-unification behavior.
 */
import { z } from 'zod';
import { getDb, getSetting, setSetting } from '../db/index.js';

// ── Settings keys ────────────────────────────────────────────────────────────
export const UNIFY_ENABLED_KEY = 'unify_models_enabled';
export const UNIFY_OVERRIDES_KEY = 'model_unify_overrides';

export const unifyOverridesSchema = z.object({
  // Coalesce several grouping tokens into one group keyed by `into`. Each key is
  // a normalized display-name OR an exact "platform:model_id" member id.
  merges: z.array(z.object({
    into: z.string().min(1),
    keys: z.array(z.string().min(1)).min(1),
  })).default([]),
  // Force a specific "platform:model_id" row out of its computed group into a
  // singleton (or into an explicit groupKey).
  splits: z.array(z.object({
    member: z.string().min(1),
    groupKey: z.string().optional(),
  })).default([]),
}).default({ merges: [], splits: [] });

export type UnifyOverrides = z.infer<typeof unifyOverridesSchema>;

const EMPTY_OVERRIDES: UnifyOverrides = { merges: [], splits: [] };

// ── Types ────────────────────────────────────────────────────────────────────
// The minimal row shape grouping needs. Catalog queries select more columns;
// extra fields are ignored here and preserved on `members`.
export interface GroupableRow {
  model_db_id: number;
  platform: string;
  model_id: string;
  display_name: string;
  intelligence_rank?: number;
  base_model_id?: number | null;
  base_model_canonical_id?: string | null;
  base_model_group_label?: string | null;
}

export interface ModelGroup {
  groupKey: string;        // base_models.canonical_id or normalized display name
  canonicalId: string;     // stable slug advertised on /v1/models
  groupLabel: string;      // base_models.group_label or representative member's stripped name
  baseModelId?: number;    // ID of the base_model (if applicable)
  members: GroupableRow[]; // all rows in the group (any enabled state)
}

// ── Settings accessors ───────────────────────────────────────────────────────
// Unification is now always on: a model served by several providers is always
// shown as one logical model that fails over across its providers. The on/off
// toggle was removed from the UI, so a user who previously turned it off is
// still unified. (setUnifyEnabled + the stored setting remain only so the
// settings endpoint stays backward-compatible; the value is ignored here.)
export function isUnifyEnabled(): boolean {
  return true;
}

export function setUnifyEnabled(on: boolean): void {
  setSetting(UNIFY_ENABLED_KEY, on ? '1' : '0');
}

export function getUnifyOverrides(): UnifyOverrides {
  const raw = getSetting(UNIFY_OVERRIDES_KEY);
  if (!raw) return EMPTY_OVERRIDES;
  try {
    const parsed = unifyOverridesSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch { /* corrupt JSON → safe default */ }
  return EMPTY_OVERRIDES;
}

export function setUnifyOverrides(input: unknown): UnifyOverrides {
  const norm = unifyOverridesSchema.parse(input);
  setSetting(UNIFY_OVERRIDES_KEY, JSON.stringify(norm));
  return norm;
}

// ── Normalization ────────────────────────────────────────────────────────────
// Catalog display names tag the provider/variant in a trailing parenthetical:
// "GPT-OSS 120B (Groq)", "Llama 3.3 70B (HF)", "... (free)". Strip ONE trailing
// "(...)" (no nested parens) to recover the logical name. Genuine variants like
// "Llama 3.3 70B fp8-fast (CF)" strip to "Llama 3.3 70B fp8-fast" — a DISTINCT
// name that only merges into "Llama 3.3 70B" via an override (by design).
export function stripProviderSuffix(displayName: string): string {
  let s = (displayName ?? '').trim();
  // Iteratively drop trailing markers: a "(...)" provider/variant parenthetical,
  // or a standalone "free" word. "Free" is a pricing tier, not a different model
  // — "DeepSeek V4 Flash Free" is the same model as "DeepSeek V4 Flash" — so it's
  // normalized away so the two group together. (A model literally named just
  // "Free" is left alone: the regex needs a word before it.)
  let prev: string;
  do {
    prev = s;
    s = s.replace(/\s*\([^()]*\)\s*$/, '').trim();
    s = s.replace(/\s+free$/i, '').trim();
  } while (s !== prev);
  return s;
}

const ORG_PREFIXES = [
  'deepseek-ai', 'deepseek', 'meta-llama', 'meta', 'google', 'openai', 'anthropic', 
  'cohere', 'mistralai', 'mistral', 'qwen', 'nvidia', 'microsoft', 'x-ai', 'xai', 
  'minimax', 'minimaxai', '01-ai', 'z-ai', 'zhipuai', 'alibaba', 'tencent', 
  'moonshotai', 'moonshot', 'stepfun', 'liquid', 'poolside', 'cognitivecomputations', 
  'nousresearch', 'databricks', 'upstage', 'perplexity', 'fireworks', 'together'
];
const ORG_REGEX = new RegExp(`^(?:@cf\\/|accounts\\/[^/]+\\/models\\/|(?:${ORG_PREFIXES.join('|')})\\/)`);

// The grouping identity: suffix-stripped, lowercased, with hyphens/underscores/
// whitespace all treated as one separator — so catalog spelling differences like
// "Qwen3 Coder" vs "Qwen3-Coder" group together. Meaningful characters such as
// '+' are kept, so "Command R" and "Command R+" stay distinct.
export function normalizeGroupKey(displayName: string): string {
  let name = stripProviderSuffix(displayName).toLowerCase();
  
  // Strip common org prefixes so "deepseek-ai/deepseek-v4-flash" groups with "deepseek-v4-flash"
  name = name.replace(/^@cf\//, ''); // Cloudflare prefix
  name = name.replace(ORG_REGEX, '');

  return name.replace(/[\s\-_]+/g, ' ').trim();
}

// A stable, human-friendly slug for the API. Keeps digits and dots ("3.3").
export function slugifyGroupLabel(label: string): string {
  const slug = (label ?? '').toLowerCase()
    .replace(/[^a-z0-9.\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'model';
}

// ── Grouping ─────────────────────────────────────────────────────────────────
function memberId(row: GroupableRow): string {
  return `${row.platform}:${row.model_id}`;
}

// The grouping token for a row, after applying overrides. Split wins first
// (forces a singleton/explicit key); then a merge redirects to its target;
// otherwise the normalized display name.
function tokenForRow(row: GroupableRow, ov: UnifyOverrides): string {
  const mid = memberId(row);

  const split = ov.splits.find(s => s.member === mid);
  if (split) return split.groupKey ? normalizeGroupKey(split.groupKey) : `__split__:${mid}`;

  const base = row.base_model_canonical_id || normalizeGroupKey(row.display_name);
  const merge = ov.merges.find(mg => mg.keys.some(k => k === mid || normalizeGroupKey(k) === base));
  return merge ? normalizeGroupKey(merge.into) : base;
}

// Assign a unique canonicalId to each group. Deterministic: groups sorted by
// groupKey, slug collisions disambiguated with "-2", "-3", …
function assignCanonicalIds(groups: ModelGroup[]): void {
  const used = new Set<string>();
  for (const g of [...groups].sort((a, b) => a.groupKey.localeCompare(b.groupKey))) {
    const base = slugifyGroupLabel(g.groupLabel);
    let cand = base;
    let n = 2;
    while (used.has(cand)) cand = `${base}-${n++}`;
    used.add(cand);
    g.canonicalId = cand;
  }
}

/**
 * Group catalog rows into logical models. Pure — pass overrides explicitly in
 * tests; defaults to the persisted overrides.
 */
export function groupRows(rows: GroupableRow[], ov: UnifyOverrides): ModelGroup[] {
  const map = new Map<string, ModelGroup>();
  for (const row of rows) {
    const key = tokenForRow(row, ov);
    let g = map.get(key);
    if (!g) {
      g = { 
        groupKey: key, 
        canonicalId: '', 
        groupLabel: row.base_model_group_label || stripProviderSuffix(row.display_name), 
        baseModelId: row.base_model_id || undefined,
        members: [] 
      };
      map.set(key, g);
    }
    g.members.push(row);
  }

  // Representative label = the best (lowest intelligence_rank) member, tiebroken
  // by shortest stripped name then model_db_id, so the label is deterministic.
  for (const g of map.values()) {
    if (!g.groupLabel || !g.baseModelId) {
      const rep = [...g.members].sort((a, b) =>
        (a.intelligence_rank ?? Number.MAX_SAFE_INTEGER) - (b.intelligence_rank ?? Number.MAX_SAFE_INTEGER)
        || stripProviderSuffix(a.display_name).length - stripProviderSuffix(b.display_name).length
        || a.model_db_id - b.model_db_id)[0];
      g.groupLabel = rep.base_model_group_label || stripProviderSuffix(rep.display_name);
    }
  }

  const groups = [...map.values()];
  assignCanonicalIds(groups);
  return groups;
}

/**
 * Resolve a requested model id to the db ids of its group members, or null.
 * Accepts the canonical slug OR any member's `model_id`/"platform:model_id"
 * (back-compat: an old per-provider id resolves to the whole group). Member
 * order here is incidental — the router re-orders by the active strategy.
 */
export function resolveRequestedIdToMembers(requested: string, groups: ModelGroup[]): number[] | null {
  if (!requested) return null;

  const byCanonical = groups.find(g => g.canonicalId === requested);
  if (byCanonical) return byCanonical.members.map(m => m.model_db_id);

  for (const g of groups) {
    if (g.members.some(m => m.model_id === requested || memberId(m) === requested)) {
      return g.members.map(m => m.model_db_id);
    }
  }
  return null;
}

// ── DB convenience ───────────────────────────────────────────────────────────
/**
 * Group the whole catalog (enabled + disabled rows so availability can be shown
 * and resolution is complete), applying the persisted overrides.
 */
export function getModelGroups(): ModelGroup[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT 
      m.id as model_db_id, m.platform, m.model_id, m.display_name, m.intelligence_rank,
      m.base_model_id, b.canonical_id as base_model_canonical_id, b.group_label as base_model_group_label
    FROM models m
    LEFT JOIN base_models b ON m.base_model_id = b.id
  `).all() as GroupableRow[];
  
  return groupRows(rows, getUnifyOverrides());
}

/**
 * Ensure every model has a corresponding base_model row.
 * Newly synced models from the catalog initially have base_model_id = NULL.
 */
export function ensureBaseModels(db: any): void {
  const models = db.prepare('SELECT id, display_name FROM models WHERE base_model_id IS NULL').all() as { id: number, display_name: string }[];
  if (models.length === 0) return;

  const insertBase = db.prepare(`
    INSERT OR IGNORE INTO base_models (canonical_id, group_label)
    VALUES (?, ?)
  `);
  const getBaseId = db.prepare('SELECT id FROM base_models WHERE canonical_id = ?');
  const updateModel = db.prepare('UPDATE models SET base_model_id = ? WHERE id = ?');

  const baseModelsCache = new Map<string, number>();

  for (const model of models) {
    const strippedLabel = stripProviderSuffix(model.display_name);
    const canonicalId = slugifyGroupLabel(strippedLabel);
    
    let baseModelId = baseModelsCache.get(canonicalId);
    if (!baseModelId) {
      insertBase.run(canonicalId, strippedLabel);
      const row = getBaseId.get(canonicalId) as { id: number };
      baseModelId = row.id;
      baseModelsCache.set(canonicalId, baseModelId);
    }
    updateModel.run(baseModelId, model.id);
  }
}

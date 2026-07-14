import type { Db } from '../types.js';
import { normalizeGroupKey, stripProviderSuffix, slugifyGroupLabel } from '../../services/model-groups.js';

export function up(db: Db): void {
  // 1. Create base_models table
  db.exec(`
    CREATE TABLE IF NOT EXISTS base_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      canonical_id TEXT NOT NULL UNIQUE,
      group_label TEXT NOT NULL,
      aa_id TEXT,
      aa_slug TEXT,
      creator TEXT NOT NULL DEFAULT '',
      coding_score REAL,
      agentic_score REAL,
      intelligence_score REAL,
      speed_score REAL,
      release_date TEXT,
      pricing_json TEXT,
      benchmarks_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // 2. Add base_model_id to models
  const columns = db.prepare('PRAGMA table_info(models)').all() as { name: string }[];
  if (!columns.some(col => col.name === 'base_model_id')) {
    db.prepare('ALTER TABLE models ADD COLUMN base_model_id INTEGER REFERENCES base_models(id)').run();
  }

  // 3. Migrate data
  const models = db.prepare('SELECT id, platform, model_id, display_name FROM models ORDER BY id').all() as any[];
  
  // We'll read model_overrides to see if any have AA data
  const overrides = db.prepare('SELECT platform, model_id, overrides_json FROM model_overrides').all() as any[];
  const overridesMap = new Map<string, any>();
  for (const row of overrides) {
    if (row.overrides_json) {
      try {
        overridesMap.set(`${row.platform}:${row.model_id}`, JSON.parse(row.overrides_json));
      } catch { /* ignore */ }
    }
  }

  const insertBase = db.prepare(`
    INSERT OR IGNORE INTO base_models (canonical_id, group_label, aa_id, aa_slug, creator, coding_score, agentic_score, intelligence_score, speed_score, release_date, pricing_json, benchmarks_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const updateModel = db.prepare('UPDATE models SET base_model_id = ? WHERE id = ?');
  
  const baseModelsCache = new Map<string, number>();
  const usedCanonicalIds = new Set<string>();
  
  db.transaction(() => {
    for (const model of models) {
      const groupKey = normalizeGroupKey(model.display_name);
      
      let baseModelId = baseModelsCache.get(groupKey);
      if (!baseModelId) {
        const strippedLabel = stripProviderSuffix(model.display_name);
        let canonicalId = slugifyGroupLabel(strippedLabel);
        let n = 2;
        while (usedCanonicalIds.has(canonicalId)) {
          canonicalId = `${slugifyGroupLabel(strippedLabel)}-${n++}`;
        }
        usedCanonicalIds.add(canonicalId);
        
        // Find best override to initialize AA data if available
        const override = overridesMap.get(`${model.platform}:${model.model_id}`) || {};
        
        const info = insertBase.run(
          canonicalId,
          strippedLabel,
          override.aa_id || null,
          override.aa_slug || null,
          override.creator || '',
          override.codingScore !== undefined ? override.codingScore : null,
          override.agenticScore !== undefined ? override.agenticScore : null,
          override.intelligenceRank !== undefined ? override.intelligenceRank : null,
          override.speedRank !== undefined ? override.speedRank : null,
          override.releaseDate || null,
          override.aaPricing ? JSON.stringify(override.aaPricing) : null,
          override.aaBenchmarks ? JSON.stringify(override.aaBenchmarks) : null
        );
        baseModelId = info.lastInsertRowid as number;
        baseModelsCache.set(groupKey, baseModelId);
      }
      
      updateModel.run(baseModelId, model.id);
    }
  })();

  // 4. Clean up columns that might exist from an intermediate development migration
  const modelsTableColumns = db.prepare('PRAGMA table_info(models)').all() as { name: string }[];
  if (modelsTableColumns.some(col => col.name === 'creator')) {
    try { db.exec('ALTER TABLE models DROP COLUMN creator;'); } catch { /* ignore */ }
  }
  if (modelsTableColumns.some(col => col.name === 'coding_score')) {
    try { db.exec('ALTER TABLE models DROP COLUMN coding_score;'); } catch { /* ignore */ }
  }
  if (modelsTableColumns.some(col => col.name === 'agentic_score')) {
    try { db.exec('ALTER TABLE models DROP COLUMN agentic_score;'); } catch { /* ignore */ }
  }
  
  // 5. Clean up model_overrides
  db.transaction(() => {
    const updateOverride = db.prepare('UPDATE model_overrides SET overrides_json = ? WHERE platform = ? AND model_id = ?');
    for (const [key, val] of overridesMap.entries()) {
      delete val.aa_id;
      delete val.aa_slug;
      delete val.aaPricing;
      delete val.aaBenchmarks;
      delete val.codingScore;
      delete val.agenticScore;
      delete val.intelligenceRank;
      delete val.speedRank;
      delete val.creator;
      delete val.releaseDate;
      
      const firstColonIdx = key.indexOf(':');
      const plat = key.substring(0, firstColonIdx);
      const mId = key.substring(firstColonIdx + 1);
      updateOverride.run(JSON.stringify(val), plat, mId);
    }
  })();
}

export function down(db: Db): void {
  try { db.exec('ALTER TABLE models DROP COLUMN base_model_id;'); } catch { /* ignore */ }
  try { db.exec('DROP TABLE IF EXISTS base_models;'); } catch { /* ignore */ }
}

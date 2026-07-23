import type { Db } from '../types.js';

export function up(db: Db) {
  // Add modalities column
  const modelsColumns = db.pragma('table_info(models)') as { name: string }[];
  if (!modelsColumns.some(col => col.name === 'modalities')) {
    db.prepare("ALTER TABLE models ADD COLUMN modalities TEXT NOT NULL DEFAULT '[\"text\"]'").run();
  }

  const baseModelsColumns = db.pragma('table_info(base_models)') as { name: string }[];
  if (!baseModelsColumns.some(col => col.name === 'modalities')) {
    db.prepare("ALTER TABLE base_models ADD COLUMN modalities TEXT NOT NULL DEFAULT '[\"text\"]'").run();
  }

  // Backfill modalities based on existing supports_vision and supports_tools
  if (modelsColumns.some(col => col.name === 'supports_vision')) {
    db.prepare(`
      UPDATE models SET modalities = (
        CASE 
          WHEN supports_vision = 1 AND supports_tools = 1 THEN '["text","vision","tools"]'
          WHEN supports_vision = 1 AND supports_tools = 0 THEN '["text","vision"]'
          WHEN supports_vision = 0 AND supports_tools = 1 THEN '["text","tools"]'
          ELSE '["text"]'
        END
      )
    `).run();
    db.prepare('ALTER TABLE models DROP COLUMN supports_vision').run();
  }
  
  if (modelsColumns.some(col => col.name === 'supports_tools')) {
    db.prepare('ALTER TABLE models DROP COLUMN supports_tools').run();
  }
}

export function down(db: Db) {
  const modelsColumns = db.pragma('table_info(models)') as { name: string }[];
  
  if (!modelsColumns.some(col => col.name === 'supports_vision')) {
    db.prepare('ALTER TABLE models ADD COLUMN supports_vision INTEGER NOT NULL DEFAULT 0').run();
  }
  if (!modelsColumns.some(col => col.name === 'supports_tools')) {
    db.prepare('ALTER TABLE models ADD COLUMN supports_tools INTEGER NOT NULL DEFAULT 0').run();
  }

  if (modelsColumns.some(col => col.name === 'modalities')) {
    db.prepare(`
      UPDATE models SET 
        supports_vision = CASE WHEN modalities LIKE '%"vision"%' THEN 1 ELSE 0 END,
        supports_tools = CASE WHEN modalities LIKE '%"tools"%' THEN 1 ELSE 0 END
    `).run();
    db.prepare('ALTER TABLE models DROP COLUMN modalities').run();
  }

  const baseModelsColumns = db.pragma('table_info(base_models)') as { name: string }[];
  if (baseModelsColumns.some(col => col.name === 'modalities')) {
    db.prepare('ALTER TABLE base_models DROP COLUMN modalities').run();
  }
}

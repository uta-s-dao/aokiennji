import type {
  ImportPreview,
  ImportResult,
  ParsedSource,
  Product,
  Source,
  SourceRun,
} from '../contracts';
import { fetchSource, mapRows, parseUpload, suggestMapping } from './connectors';
import {
  db,
  lockResource,
  byId,
  list,
  save,
  audit,
  now,
  uid,
  normalize,
  productIdentity,
  demoMode,
} from './db';
import { prepareProductMetadata } from './product-metadata';
import { ApiError } from './auth';
import { productSchema } from './validation';
import { importSupplierKnowledge, parseSupplierWorkbook } from './supplier-knowledge';
export async function sourceById(id: string) {
  const s = await byId<Source>('sources', id);
  if (!s) throw new ApiError(404, 'not_found', '情報源が見つかりません');
  return s;
}
export async function previewUpload(
  sourceId: string,
  name: string,
  buffer: Buffer,
): Promise<ImportPreview> {
  const source = await sourceById(sourceId);
  let parsed: ParsedSource;
  try {
    parsed =
      source.kind === 'supplier_catalog'
        ? await parseSupplierWorkbook(name, buffer)
        : await parseUpload(name, buffer);
  } catch (error) {
    throw new ApiError(
      400,
      'parse_failed',
      error instanceof Error ? error.message.slice(0, 300) : 'ファイルを解析できません',
    );
  }
  if (!parsed.rows.length && !parsed.documents.length && !parsed.supplierRows?.length)
    throw new ApiError(400, 'empty_file', '取り込めるデータがありません');
  const preview: ImportPreview = {
    ...parsed,
    previewId: uid(),
    sourceId,
    fileName: name,
    totalRows: parsed.supplierRows?.length ?? parsed.rows.length,
    suggestedMapping: suggestMapping(parsed.headers),
  };
  await db().prepare('DELETE FROM import_previews WHERE expires_at < ?').run(Date.now());
  await db()
    .prepare('INSERT INTO import_previews(id,source_id,expires_at,json) VALUES(?,?,?,?)')
    .run(preview.previewId, sourceId, Date.now() + 3600000, JSON.stringify(preview));
  return {
    ...preview,
    rows: preview.rows.slice(0, 20),
    documents: preview.documents.map((d) => ({ ...d, content: d.content.slice(0, 2000) })),
  };
}
async function ingest(
  source: Source,
  parsed: ParsedSource,
  mapping: Record<string, string>,
  approved: boolean,
): Promise<ImportResult> {
  const mapped = mapRows(parsed.rows, mapping);
  const result: ImportResult = {
    imported: 0,
    updated: 0,
    documents: 0,
    errors: mapped.errors,
    warnings: parsed.warnings,
  };
  await db().transaction(async () => {
    await lockResource(`source:${source.id}`);
    for (const input of mapped.products) {
      const valid = productSchema.safeParse(input);
      if (!valid.success) {
        result.errors.push({ row: 0, message: `${input.model}: 商品情報の形式が不正です` });
        continue;
      }
      const old = (await list<Product>('products')).find(
        (p) => p.sourceId === source.id && productIdentity(p) === productIdentity(input),
      );
      const p: Product = prepareProductMetadata({
        ...valid.data,
        approved: approved && !!input.verifiedAt && source.trust !== 'discovery',
        id: old?.id || uid(),
        sourceId: source.id,
        supplierId: old?.supplierId || null,
        isDemo: old?.isDemo ?? demoMode(),
        createdAt: old?.createdAt || now(),
        updatedAt: now(),
      }, old);
      await save('products', p, {
        source_id: source.id,
        supplier_id: p.supplierId,
        model_key: productIdentity(p),
      });
      if (old) result.updated++;
      else result.imported++;
    }
    if (parsed.documents.length) {
      await db().prepare('DELETE FROM documents WHERE source_id=?').run(source.id);
      for (const d of parsed.documents) {
        const doc = {
          id: uid(),
          sourceId: source.id,
          title: d.title,
          url: d.url || '',
          content: d.content,
          createdAt: now(),
        };
        await save('documents', doc, { source_id: source.id, content: doc.content });
        result.documents++;
      }
    }
    const count =
      (await list<Product>('products')).filter((p) => p.sourceId === source.id).length +
      (await list<{ sourceId: string }>('documents')).filter((p) => p.sourceId === source.id)
        .length;
    await save('sources', {
      ...source,
      config: { ...source.config, mapping },
      lastSyncedAt: now(),
      lastError: null,
      recordCount: count,
    });
    const run: SourceRun = {
      id: uid(),
      sourceId: source.id,
      status: 'success',
      count: result.imported + result.updated + result.documents,
      message: `取込 ${result.imported}件 / 更新 ${result.updated}件 / 文書 ${result.documents}件 / エラー ${result.errors.length}件`,
      createdAt: now(),
    };
    await save('source_runs', run, { source_id: source.id });
    await audit('source.imported', source.id, run.message);
  })();
  return result;
}
export async function commitPreview(
  id: string,
  mapping: Record<string, string>,
  approved: boolean,
) {
  return await db().transaction(async () => {
    await lockResource(`import-preview:${id}`);
    const row = (await db()
      .prepare('SELECT json,expires_at FROM import_previews WHERE id=?')
      .get(id)) as { json: string; expires_at: number } | undefined;
    if (!row || row.expires_at < Date.now())
      throw new ApiError(
        410,
        'preview_expired',
        'プレビューの有効期限が切れました。再度アップロードしてください',
      );
    const preview = JSON.parse(row.json) as ImportPreview;
    const source = await sourceById(preview.sourceId);
    if (!source.enabled) throw new ApiError(409, 'source_disabled', '情報源が無効です');
    if ((source.kind === 'supplier_catalog') !== !!preview.supplierRows)
      throw new ApiError(
        409,
        'source_changed',
        '情報源の種類が変わりました。再度アップロードしてください',
      );
    if (preview.rows.length && (!mapping.name || !mapping.model))
      throw new ApiError(400, 'mapping_required', '商品名と型番の列を指定してください');
    for (const column of Object.values(mapping))
      if (column && !preview.headers.includes(column))
        throw new ApiError(400, 'invalid_mapping', '列の対応付けを確認してください');
    return await db().transaction(async () => {
      const result = preview.supplierRows
        ? await importSupplierKnowledge(source, preview.supplierRows, approved)
        : await ingest(source, preview, mapping, approved);
      if (preview.supplierRows) result.warnings = preview.warnings;
      await db().prepare('DELETE FROM import_previews WHERE id=?').run(id);
      return result;
    })();
  })();
}
export async function syncSource(id: string) {
  const source = await sourceById(id);
  try {
    const parsed = await fetchSource(source);
    return await ingest(
      source,
      parsed,
      source.config.mapping || suggestMapping(parsed.headers),
      false,
    );
  } catch (e) {
    const message = e instanceof Error ? e.message : '同期に失敗しました';
    await save('sources', { ...source, lastError: message });
    await save(
      'source_runs',
      { id: uid(), sourceId: id, status: 'failed', count: 0, message, createdAt: now() },
      { source_id: id },
    );
    throw new ApiError(400, 'sync_failed', message);
  }
}

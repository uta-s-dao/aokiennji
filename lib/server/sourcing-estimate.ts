import { createHash } from 'node:crypto';
import type { AppSettings, ProcurementOffer, ProductSourcing } from '../contracts';
import { calculateSourcingEstimate, type EstimateResult } from '../sourcing-estimate';
import { audit, now, save } from './db';
import { ApiError } from './auth';
import { researchNotes } from './research';
import { procurementOfferSchema } from './validation';

const identity = (s: string) =>
  s
    .normalize('NFKC')
    .toUpperCase()
    .replace(/[\s_‐‑–—−-]/g, '');
export function sourcingEstimate(
  conversationId: string,
  source: ProductSourcing,
  quantity: number | undefined,
  destination: string | undefined,
  settings: AppSettings,
): EstimateResult & { revision: string } {
  const note = researchNotes(conversationId).find(
    (n) =>
      n.sourcing?.checkedAt === source.checkedAt && identity(n.subject) === identity(source.model),
  );
  const revision = createHash('sha256')
    .update(
      JSON.stringify([
        settings.sourcingEstimate,
        settings.flags.showPrice,
        settings.flags.showLeadTime,
        source,
        note?.offers,
      ]),
    )
    .digest('hex');
  if (
    !settings.sourcingEstimate.enabled ||
    !settings.flags.showPrice ||
    !settings.flags.showLeadTime
  )
    return { missing: ['販売条件の設定'], revision };
  const missing = [!quantity ? '必要数量' : '', !destination ? 'お届け先の都道府県' : ''].filter(
    Boolean,
  );
  if (missing.length) return { missing, revision };
  if (source.status !== 'candidate' || !note?.offers?.length)
    return { missing: ['調達先の条件の確認'], revision };
  const results = note.offers.map((offer) =>
    calculateSourcingEstimate(settings.sourcingEstimate, offer, quantity!, destination!),
  );
  const complete = results
    .filter((r) => r.estimate)
    .sort((a, b) => a.estimate!.total - b.estimate!.total)[0];
  return {
    ...(complete || results.sort((a, b) => a.missing.length - b.missing.length)[0]),
    revision,
  };
}

export function updateProcurementOffer(
  conversationId: string,
  noteId: string,
  offerId: string,
  input: unknown,
): ProcurementOffer {
  const note = researchNotes(conversationId).find((n) => n.id === noteId);
  const offer = note?.offers?.find((o) => o.id === offerId);
  if (!note || note.conversationId !== conversationId || !note.sourcing || !offer)
    throw new ApiError(404, 'not_found', '調達候補が見つかりません');
  const fields = procurementOfferSchema.parse(input);
  // This is an explicit staff confirmation of the source and all edited facts.
  const updated = { ...offer, ...fields, confirmedAt: fields.approved ? now() : null };
  note.offers = note.offers!.map((o) => (o.id === offerId ? updated : o));
  save('research_notes', note, {
    conversation_id: note.conversationId,
    created_at: note.createdAt,
  });
  audit(
    'procurement.confirmed',
    noteId,
    `${note.subject}の調達条件を${fields.approved ? '確認' : '更新'}しました`,
  );
  return updated;
}

// Contextual summaries must also expire when procurement or selling terms change.
export function sourcingContextRevision(conversationId: string, settings: AppSettings) {
  const offers = researchNotes(conversationId).flatMap((n) => n.offers || []);
  if (!offers.length) return undefined;
  return createHash('sha256')
    .update(
      JSON.stringify([
        settings.sourcingEstimate,
        offers.map((o) => [
          o,
          !!o.confirmedAt &&
            Date.now() - Date.parse(o.confirmedAt) <
              settings.sourcingEstimate.validityHours * 3600000,
        ]),
      ]),
    )
    .digest('hex');
}

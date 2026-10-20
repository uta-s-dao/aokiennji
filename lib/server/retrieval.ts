import type { Evidence, QueryIntent, Source } from '../contracts';
import { byId, list, normalize } from './db';
import { containsPrivateSupplierIdentity, privateSupplierQuestion } from './supplier-knowledge';

// Search bounded passages locally before the network calls. The model receives
// public excerpts or generic markers, never private filenames or supplier rows.
export async function documentCandidates(
  message: string,
  intent: QueryIntent,
): Promise<{ evidence: Evidence; matched: boolean }[]> {
  const words = [
    ...intent.terms,
    ...(message.match(/[\p{Script=Han}\p{Script=Katakana}ー]{2,}/gu) || []),
  ]
    .map(normalize)
    .filter((w) => w.length > 1);
  const candidates: { evidence: Evidence; matched: boolean; score: number }[] = [];
  for (const doc of (await list<{
    id: string;
    sourceId: string;
    title: string;
    content: string;
    url: string;
    createdAt: string;
  }>('documents')).slice(0, 100)) {
    const source = (await byId<Source>('sources', doc.sourceId));
    if (!source?.enabled) continue;
    const text = normalize(doc.content);
    const matchedWords = words.filter((w) => text.includes(w));
    if (source.visibility !== 'public') {
      if (matchedWords.length)
        candidates.push({
          matched: true,
          score: matchedWords.length,
          evidence: {
            id: doc.id,
            sourceId: source.id,
            title: '社内資料の関連情報',
            excerpt: '関連する社内資料があります。詳細は担当者が確認します。',
            retrievedAt: doc.createdAt,
            visibility: 'public',
            trust: source.trust,
          },
        });
      continue;
    }
    let best = doc.content.slice(0, 650),
      bestScore = 0;
    for (let offset = 0; offset < Math.min(doc.content.length, 60000); offset += 500) {
      const passage = doc.content.slice(offset, offset + 650);
      const score = words.filter((w) => normalize(passage).includes(w)).length;
      if (score > bestScore) {
        bestScore = score;
        best = passage;
      }
    }
    if (
      (await privateSupplierQuestion([doc.title, best].join(' '))) ||
      (await containsPrivateSupplierIdentity(doc.url || ''))
    )
      continue;
    candidates.push({
      matched: bestScore > 0,
      score: bestScore,
      evidence: {
        id: doc.id,
        sourceId: source.id,
        title: doc.title,
        url: doc.url || undefined,
        excerpt: best,
        retrievedAt: doc.createdAt,
        visibility: 'public',
        trust: source.trust,
      },
    });
  }
  return candidates.sort((a, b) => b.score - a.score).slice(0, 8);
}

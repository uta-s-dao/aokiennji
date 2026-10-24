import { z } from 'zod';
import type { SiteContent } from './site-content';

const localImage = z
  .string()
  .max(220)
  .regex(
    /^\/(?:images\/[a-zA-Z0-9_/-]+\.(?:jpg|jpeg|png|webp)|api\/site-content\/images\/[a-f0-9-]{36})$/,
  );
const text = (max: number) => z.string().trim().min(1).max(max);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === s;
  }, '日付を確認してください');
export const siteContentSchema = z
  .object({
    home: z
      .object({
        title: text(100),
        subtitle: text(100),
        lead: text(600),
        introduction: text(1000),
        slides: z.array(z.object({ image: localImage, label: text(100) }).strict()).length(3),
      })
      .strict(),
    news: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            title: text(120),
            date,
            body: text(3000),
            published: z.boolean(),
          })
          .strict(),
      )
      .max(100),
    projects: z
      .array(
        z
          .object({
            id: text(100).regex(/^[a-zA-Z0-9-]+$/),
            name: text(120),
            category: text(60),
            image: localImage,
            description: text(1500),
            published: z.boolean(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict()
  .superRefine((c, ctx) => {
    for (const key of ['news', 'projects'] as const) {
      if (new Set(c[key].map((p) => p.id)).size !== c[key].length)
        ctx.addIssue({ code: 'custom', path: [key], message: '重複した項目があります' });
    }
  });

export type EditorSection = keyof SiteContent;
export type ContentIssue = {
  path: string;
  section: EditorSection;
  itemId?: string;
  label: string;
  message: string;
};
export const sectionLabels = { home: 'トップページ', news: 'お知らせ', projects: '製作実績' };
const fieldLabels: Record<string, string> = {
  title: 'タイトル',
  subtitle: '見出しの強調部分',
  lead: '冒頭の紹介文',
  introduction: '事業の紹介文',
  name: '実績名',
  category: 'カテゴリ',
  description: '実績の説明',
  body: '本文',
  date: '掲載日',
  image: '写真',
  label: '写真の説明',
  published: '公開対象',
};
export function contentIssues(content: SiteContent): ContentIssue[] {
  const result = siteContentSchema.safeParse(content);
  if (result.success) return [];
  return result.error.issues.map((issue) => {
    const section = issue.path[0] as EditorSection;
    const index = typeof issue.path[1] === 'number' ? issue.path[1] : undefined;
    const item = section !== 'home' && index !== undefined ? content[section]?.[index] : undefined;
    const field = String(issue.path.at(-1));
    const fieldLabel =
      section === 'home' && issue.path[1] === 'slides'
        ? `メイン写真${Number(issue.path[2]) + 1}の${field === 'image' ? '写真' : '説明'}`
        : section === 'home' && field === 'title'
          ? 'メイン見出し'
          : fieldLabels[field] || '内容';
    const label = `${sectionLabels[section] || 'サイト内容'}${index !== undefined ? ` ${index + 1}` : ''}：${fieldLabel}`;
    return {
      path: issue.path.join('.'),
      section,
      itemId: item?.id,
      label,
      message: `${label}：${issue.code === 'too_small' ? '入力してください。' : issue.code === 'too_big' ? '文字数・件数の上限を超えています。' : '形式を確認してください。'}`,
    };
  });
}
export type ContentChange = {
  section: EditorSection;
  label: string;
  before: string;
  after: string;
  image?: boolean;
};
export function contentChanges(before: SiteContent, after: SiteContent): ContentChange[] {
  const changes: ContentChange[] = [];
  const show = (value: unknown) =>
    typeof value === 'boolean' ? (value ? '公開対象' : '非公開') : String(value ?? '');
  for (const key of ['title', 'subtitle', 'lead', 'introduction'] as const) {
    if (before.home[key] !== after.home[key])
      changes.push({
        section: 'home',
        label: key === 'title' ? 'メイン見出し' : fieldLabels[key],
        before: before.home[key],
        after: after.home[key],
      });
  }
  after.home.slides.forEach((slide, i) => {
    for (const key of ['image', 'label'] as const)
      if (before.home.slides[i]?.[key] !== slide[key])
        changes.push({
          section: 'home',
          label: `メイン写真${i + 1}の${key === 'image' ? '差し替え' : '説明'}`,
          before: before.home.slides[i]?.[key] || '',
          after: slide[key],
          image: key === 'image',
        });
  });
  for (const section of ['news', 'projects'] as const) {
    const previous = before[section] as Array<{ id: string; [key: string]: unknown }>;
    const next = after[section] as Array<{ id: string; [key: string]: unknown }>;
    const oldMap = new Map(previous.map((item) => [item.id, item]));
    const nextMap = new Map(next.map((item) => [item.id, item]));
    for (const item of next) {
      const old = oldMap.get(item.id);
      const name = String(item.name || item.title || '名称未入力');
      if (!old) {
        changes.push({
          section,
          label: `${name}を追加`,
          before: '未登録',
          after: `${name}（${show(item.published)}）`,
        });
        for (const key of Object.keys(item).filter(
          (key) => !['id', 'name', 'title', 'published'].includes(key),
        )) {
          changes.push({
            section,
            label: `${name}：${fieldLabels[key] || key}`,
            before: '',
            after: show(item[key]),
            image: key === 'image',
          });
        }
      } else
        for (const key of Object.keys(item).filter((key) => key !== 'id')) {
          if (old[key] !== item[key])
            changes.push({
              section,
              label: `${name}：${fieldLabels[key] || key}`,
              before: show(old[key]),
              after: show(item[key]),
              image: key === 'image',
            });
        }
    }
    for (const item of previous)
      if (!nextMap.has(item.id))
        changes.push({
          section,
          label: `${item.name || item.title}を削除`,
          before: String(item.name || item.title),
          after: '削除',
        });
    if (section === 'projects') {
      const commonBefore = previous.filter((item) => nextMap.has(item.id)).map((item) => item.id);
      const commonAfter = next.filter((item) => oldMap.has(item.id)).map((item) => item.id);
      if (JSON.stringify(commonBefore) !== JSON.stringify(commonAfter))
        changes.push({
          section,
          label: '表示順の変更',
          before: previous.map((item) => item.name).join(' → '),
          after: next.map((item) => item.name).join(' → '),
        });
    }
  }
  return changes;
}

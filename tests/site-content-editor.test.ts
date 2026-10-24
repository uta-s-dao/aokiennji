import { expect, it } from 'vitest';
import { DEFAULT_SITE_CONTENT } from '../lib/site-content';
import { contentChanges, contentIssues } from '../lib/site-content-editor';

it('locates incomplete fields across hidden tabs and identifies the item to open', () => {
  const content = structuredClone(DEFAULT_SITE_CONTENT);
  content.news.push({
    id: crypto.randomUUID(),
    title: '',
    body: '',
    date: '2026-02-30',
    published: true,
  });
  content.projects[1].name = ' ';
  const issues = contentIssues(content);
  expect(issues.map((issue) => issue.path)).toEqual(
    expect.arrayContaining(['news.0.title', 'news.0.body', 'news.0.date', 'projects.1.name']),
  );
  expect(issues.find((issue) => issue.path === 'projects.1.name')).toMatchObject({
    section: 'projects',
    itemId: content.projects[1].id,
  });
  expect(issues[0].message).toContain('お知らせ 1');
});
it('summarizes edits, additions, removals, photos, visibility and project order across tabs', () => {
  const before = structuredClone(DEFAULT_SITE_CONTENT);
  const after = structuredClone(before);
  after.home.title = '新しい見出し';
  after.home.slides[0].image = '/images/tank.jpg';
  after.news.push({
    id: crypto.randomUUID(),
    title: '新しいお知らせ',
    body: '本文',
    date: '2026-10-24',
    published: true,
  });
  after.projects[0].published = false;
  const deleted = after.projects.pop()!;
  [after.projects[0], after.projects[1]] = [after.projects[1], after.projects[0]];
  const changes = contentChanges(before, after);
  expect(changes).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        section: 'home',
        label: 'メイン見出し',
        before: before.home.title,
        after: '新しい見出し',
      }),
      expect.objectContaining({ label: 'メイン写真1の差し替え' }),
      expect.objectContaining({ label: '新しいお知らせを追加' }),
      expect.objectContaining({ label: `${deleted.name}を削除` }),
      expect.objectContaining({
        label: `${before.projects[0].name}：公開対象`,
        before: '公開対象',
        after: '非公開',
      }),
      expect.objectContaining({ label: '表示順の変更' }),
    ]),
  );
  expect(contentChanges(after, after)).toEqual([]);
});

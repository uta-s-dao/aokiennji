import { projects } from './company';

export type SiteProject = (typeof projects)[number] & { published: boolean };
export type SiteNews = {
  id: string;
  title: string;
  date: string;
  body: string;
  published: boolean;
};
export type SiteContent = {
  home: {
    title: string;
    subtitle: string;
    lead: string;
    introduction: string;
    slides: { image: string; label: string }[];
  };
  news: SiteNews[];
  projects: SiteProject[];
};
export type SiteEditorState = {
  revision: number;
  draft: SiteContent;
  publishedAt: string | null;
  hasUnpublishedChanges: boolean;
};
export const DEFAULT_SITE_CONTENT: SiteContent = {
  home: {
    title: '鋼構造物・機械装置の',
    subtitle: '設計・製作・据付',
    lead: '北九州・福岡の製作・工事のご相談に。\n長年の経験と技術で、幅広いご要望に対応いたします。',
    introduction:
      '耐火物製品製造の受注から出荷までの全行程を一括管理。\n長年の経験で培ったノウハウを駆使し、様々な製品・構造物に対応いたします。',
    slides: [
      { image: '/images/legacy/hero-01.jpg', label: '耐火物製品の製作実績' },
      { image: '/images/legacy/hero-02.jpg', label: '大型タンクの積込み作業' },
      { image: '/images/legacy/hero-03.jpg', label: '太陽光発電設備の施工実績' },
    ],
  },
  news: [],
  projects: projects.map((p) => ({ ...p, published: true })),
};

export function visibleSiteContent(content: SiteContent): SiteContent {
  return {
    ...content,
    news: content.news.filter((n) => n.published).sort((a, b) => b.date.localeCompare(a.date)),
    projects: content.projects.filter((p) => p.published),
  };
}

export function siteImageReferences(content: SiteContent): string[] {
  return [...content.home.slides.map((s) => s.image), ...content.projects.map((p) => p.image)];
}

export function previewSiteContent(content: SiteContent): SiteContent {
  const image = (url: string) =>
    url.replace('/api/site-content/images/', '/api/admin/site-content/images/');
  const visible = visibleSiteContent(content);
  return {
    ...visible,
    home: {
      ...visible.home,
      slides: visible.home.slides.map((s) => ({ ...s, image: image(s.image) })),
    },
    projects: visible.projects.map((p) => ({ ...p, image: image(p.image) })),
  };
}

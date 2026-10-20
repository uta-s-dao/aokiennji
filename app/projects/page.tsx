import ProjectsPage from '@/components/ProjectsPage';
import { getPublishedSiteContent } from '@/lib/server/site-content';
import { pageMetadata } from '@/lib/seo';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const metadata = pageMetadata(
  '鋼構造物・機械装置の製作実績',
  'アオキエンジのサイロ、屋外タンク、排ガスダクト、搬送台車、熱交換器、工業炉の耐火材施工の実績をご紹介します。',
  '/projects',
);
export default async function Page() {
  return <ProjectsPage projects={(await getPublishedSiteContent()).projects} />;
}

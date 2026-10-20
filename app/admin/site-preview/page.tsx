import { headers } from 'next/headers';
import { NextRequest } from 'next/server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { ApiError, requireAdmin } from '@/lib/server/auth';
import { getSiteEditor } from '@/lib/server/site-content';
import { previewSiteContent } from '@/lib/site-content';
import HomePageView from '@/components/HomePageView';
import ProjectsPage from '@/components/ProjectsPage';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export default async function SitePreview({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  try {
    (await requireAdmin(
      new NextRequest('http://localhost/admin/site-preview', { headers: await headers() }),
    ));
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) redirect('/admin/login');
    throw error;
  }
  const content = previewSiteContent((await getSiteEditor()).draft);
  const view = (await searchParams).view;
  return (
    <>
      <div className="cms-preview-banner">
        下書きプレビュー（管理者のみ）
        <Link href="/admin/site-preview?view=home">トップページ</Link>
        <Link href="/admin/site-preview?view=projects">製作実績</Link>
      </div>
      {view === 'projects' ? (
        <ProjectsPage projects={content.projects} />
      ) : (
        <HomePageView content={content} />
      )}
    </>
  );
}

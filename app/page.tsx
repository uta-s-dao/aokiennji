import HomePageView from '@/components/HomePageView';
import { getPublishedSiteContent } from '@/lib/server/site-content';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export default function Home() {
  return <HomePageView content={getPublishedSiteContent()} />;
}

import HomePageView from '@/components/HomePageView';
import { getPublishedSiteContent } from '@/lib/server/site-content';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export default async function Home() {
  return <HomePageView content={(await getPublishedSiteContent())} />;
}

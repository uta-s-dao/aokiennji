import type { Metadata } from 'next';
import { privateRobots } from '@/lib/seo';
export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: '管理画面',
  robots: privateRobots,
  alternates: { canonical: null },
  openGraph: { url: null },
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}

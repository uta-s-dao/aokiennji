import type { NextRequest } from 'next/server';
import { siteImageResponse } from '@/lib/server/site-content-http';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  return (await siteImageResponse(req, (await context.params).id, false));
}

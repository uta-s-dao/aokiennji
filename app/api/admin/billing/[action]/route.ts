import type { NextRequest } from 'next/server';
import { billingRequest } from '@/lib/server/billing-http';
export const runtime = 'nodejs';
export async function POST(req: NextRequest, context: { params: Promise<{ action: string }> }) {
  return billingRequest(req, (await context.params).action);
}

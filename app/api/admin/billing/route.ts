import { billingRequest } from '@/lib/server/billing-http';
import type { NextRequest } from 'next/server';
export const runtime = 'nodejs';
export const GET = (req: NextRequest) => billingRequest(req);
export const PATCH = (req: NextRequest) => billingRequest(req);

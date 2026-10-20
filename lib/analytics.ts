import { publicPaths } from '@/lib/service-content';
export function analyticsPath(path: string): string | null {
  if (publicPaths.includes(path)) return path;
  return /^\/products\/[^/]+$/.test(path) ? '/products/item' : null;
}
export type ConversionName = 'generate_lead' | 'chat_open';
export function trackConversion(name: ConversionName, leadType: 'inquiry' | 'quote' | 'chat') {
  window.dispatchEvent(new CustomEvent('aoki:conversion', { detail: { name, leadType } }));
}

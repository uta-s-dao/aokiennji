// Generate the test catalog without credentials or network requests.
// Execute the output only in the intended, verified Stripe test account.
export function billingFixture() {
  const metadata = { app: 'aokiennji', purpose: 'uta9-test-only' };
  const price = (name, amount) => ({
    name,
    path: '/v1/prices',
    method: 'post',
    params: {
      product: '${product_' + name + ':id}',
      currency: 'jpy',
      unit_amount: amount,
      tax_behavior: 'inclusive',
      recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' },
      metadata,
    },
  });
  return {
    _meta: { template_version: 0 },
    fixtures: [
      ...['basic', 'standard', 'plus'].map((plan, i) => ({
        name: `product_${plan}`,
        path: '/v1/products',
        method: 'post',
        params: {
          name: `アオキエンジ・${['ベーシック', 'スタンダード', 'プラス'][i]}（決済テスト用）`,
          metadata,
        },
      })),
      price('basic', 5000),
      price('standard', 10000),
      price('plus', 20000),
      {
        name: 'customer',
        path: '/v1/customers',
        method: 'post',
        params: { name: 'アオキエンジ・架空決済テスト担当', metadata },
      },
      {
        name: 'portal',
        path: '/v1/billing_portal/configurations',
        method: 'post',
        params: {
          name: 'アオキエンジ・契約変更テスト',
          metadata,
          features: {
            customer_update: { enabled: false },
            invoice_history: { enabled: true },
            payment_method_update: { enabled: true },
            subscription_cancel: { enabled: true, mode: 'at_period_end' },
            subscription_update: {
              enabled: true,
              default_allowed_updates: ['price'],
              proration_behavior: 'always_invoice',
              billing_cycle_anchor: 'unchanged',
              schedule_at_period_end: { conditions: [{ type: 'decreasing_item_amount' }] },
              products: ['basic', 'standard', 'plus'].map((plan) => ({
                product: '${product_' + plan + ':id}',
                prices: ['${' + plan + ':id}'],
                adjustable_quantity: { enabled: false },
              })),
            },
          },
        },
      },
    ],
  };
}

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.stdout.write(JSON.stringify(billingFixture(), null, 2) + '\n');
}

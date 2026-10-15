'use client';
import type { SourcingEstimatePolicy } from '@/lib/contracts';
import { PREFECTURES } from '@/lib/sourcing-estimate';

export default function AdminEstimatePolicy({
  value,
  onChange,
}: {
  value: SourcingEstimatePolicy;
  onChange: (patch: Partial<SourcingEstimatePolicy>) => void;
}) {
  const set = onChange;
  const number = (
    key: 'markupPercent' | 'minimumProfitYen' | 'handlingFeeYen' | 'extraBusinessDays',
    label: string,
    max: number,
    step = 1,
  ) => (
    <label key={key}>
      {label}
      <input
        type="number"
        min="0"
        max={max}
        step={step}
        value={value[key] ?? ''}
        placeholder="未設定"
        onInput={(e) =>
          set({ [key]: e.currentTarget.value === '' ? null : Number(e.currentTarget.value) })
        }
      />
    </label>
  );
  return (
    <section className="admin-card">
      <h2>未登録商品の販売概算</h2>
      <p className="muted">
        確認済みの調達条件と以下の販売ルールから、チャットで単価・送料・税込合計・納期目安を提示します。正式見積と注文は現在の受付手順で確定します。
      </p>
      <div className="check-grid">
        <label>
          <input
            type="checkbox"
            checked={value.enabled}
            onChange={(e) => set({ enabled: e.target.checked })}
          />
          チャットで販売概算を案内する
        </label>
      </div>
      <div className="form-grid">
        {number('markupPercent', '原価への上乗せ率（%・粗利率ではありません）', 1000, 0.01)}
        {number('minimumProfitYen', '1案件あたりの最低利益（税抜・円）', 1000000000)}
        {number('handlingFeeYen', '1案件あたりの手配料（税抜・円）', 1000000000)}
        <label>
          単価の切り上げ単位
          <select
            value={value.roundingYen}
            onChange={(e) => set({ roundingYen: Number(e.target.value) as 1 | 10 | 100 })}
          >
            {[1, 10, 100].map((v) => (
              <option key={v} value={v}>
                {v}円
              </option>
            ))}
          </select>
        </label>
        <label>
          配送方法
          <select
            value={value.fulfillment}
            onChange={(e) =>
              set({ fulfillment: e.target.value as SourcingEstimatePolicy['fulfillment'] })
            }
          >
            <option value="direct">仕入先からお客様へ直送</option>
            <option value="via_company">当社を経由してお届け</option>
          </select>
        </label>
        {number('extraBusinessDays', '確認済みの配送日数に加える営業日数', 365)}
        <label>
          販売時の税率
          <select
            value={value.taxRate}
            onChange={(e) => set({ taxRate: Number(e.target.value) as 0 | 8 | 10 })}
          >
            {[0, 8, 10].map((v) => (
              <option key={v} value={v}>
                {v}%
              </option>
            ))}
          </select>
        </label>
        <label>
          調達条件・概算の有効時間
          <input
            type="number"
            min="1"
            max="168"
            value={value.validityHours}
            onInput={(e) => set({ validityHours: Number(e.currentTarget.value) })}
          />
        </label>
      </div>
      <p className="muted">
        商品原価に上乗せした金額と「原価＋最低利益」の大きい方に手配料を加え、数量で割って単価を切り上げます。当社経由の場合は仕入先から当社までの送料も原価に含めます。数量が入数の倍数でない場合は数量を確認します。設定しない数値は空欄、不要と決めた費用は0を入力してください。
      </p>
      <h3>都道府県別の請求送料（税抜）</h3>
      <p className="muted">
        登録がない地域は、調達候補で確認したお客様向け送料を使います。空欄を無料とは扱いません。離島・特殊配送は個別確認です。
      </p>
      {value.shippingRates.map((r, i) => (
        <div className="form-grid" key={i}>
          <label>
            お届け先
            <select
              value={r.destination}
              onChange={(e) =>
                set({
                  shippingRates: value.shippingRates.map((row, j) =>
                    j === i ? { ...row, destination: e.target.value } : row,
                  ),
                })
              }
            >
              {PREFECTURES.map((p) => (
                <option key={p}>{p}</option>
              ))}
            </select>
          </label>
          <label>
            送料（円）
            <input
              type="number"
              min="0"
              max="1000000000"
              required
              value={Number.isFinite(r.shippingNet) ? r.shippingNet : ''}
              onInput={(e) =>
                set({
                  shippingRates: value.shippingRates.map((row, j) =>
                    j === i
                      ? {
                          ...row,
                          shippingNet:
                            e.currentTarget.value === '' ? NaN : Number(e.currentTarget.value),
                        }
                      : row,
                  ),
                })
              }
            />
          </label>
          <button
            type="button"
            className="button secondary small"
            onClick={() => set({ shippingRates: value.shippingRates.filter((_, j) => j !== i) })}
          >
            送料の行を削除
          </button>
        </div>
      ))}
      <button
        type="button"
        className="button secondary small"
        disabled={value.shippingRates.length >= 47}
        onClick={() =>
          set({
            shippingRates: [
              ...value.shippingRates,
              {
                destination: PREFECTURES.find(
                  (p) => !value.shippingRates.some((r) => r.destination === p),
                )!,
                shippingNet: NaN,
              },
            ],
          })
        }
      >
        地域の送料を追加
      </button>
      <p className="muted">
        調達先の税区分・入数・数量分の調達可否・配送日数は「チャット履歴 → AI調査メモ →
        販売概算用の調達条件」で確認・保存します。
      </p>
    </section>
  );
}

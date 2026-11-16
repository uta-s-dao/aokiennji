import type { Field } from "./model";
export const fields: Record<
  string,
  { label: string; units?: string[]; values?: string[] }
> = {
  manufacturer: { label: "メーカー" },
  model: { label: "型番" },
  product_name: { label: "商品名" },
  purpose: { label: "用途" },
  description: { label: "対象の説明" },
  material: { label: "材質" },
  process: { label: "加工内容" },
  request_scope: {
    label: "依頼範囲",
    values: ["purchase", "processing", "fabrication"],
  },
  material_supply: {
    label: "材料手配",
    values: ["customer_supplied", "company_sourced", "mixed"],
  },
  work_scope: { label: "依頼する部位・作業" },
  excluded_work: { label: "製作除外" },
  supplied_parts: { label: "支給品" },
  drawing_number: { label: "図番" },
  drawing_revision: { label: "図面版" },
  coating: { label: "塗装" },
  outer_diameter: { label: "外径", units: ["mm", "cm", "m"] },
  inner_diameter: { label: "内径", units: ["mm", "cm", "m"] },
  opening_diameter: { label: "見える穴の径", units: ["mm", "cm", "m"] },
  width: { label: "幅", units: ["mm", "cm", "m"] },
  height: { label: "高さ", units: ["mm", "cm", "m"] },
  depth: { label: "奥行", units: ["mm", "cm", "m"] },
  thickness: { label: "厚さ", units: ["mm", "cm", "m"] },
  normal_temperature: { label: "通常温度", units: ["℃", "°C"] },
  peak_temperature: { label: "最高温度", units: ["℃", "°C"] },
  peak_duration: { label: "最高温度の継続時間", units: ["秒", "分", "時間"] },
  peak_frequency: { label: "最高温度の頻度" },
  pressure: { label: "使用圧力", units: ["Pa", "kPa", "MPa"] },
  fluid: { label: "流体" },
  mounting: { label: "取付方法" },
  quantity: { label: "数量", units: ["個", "枚", "組", "台", "本", "m", "kg"] },
  required_date: { label: "希望日" },
  destination: { label: "納入先" },
};
export const labels: Record<string, string> = {
  purchase: "商品・材料の購入",
  processing: "加工",
  fabrication: "製作",
  customer_supplied: "客先支給",
  company_sourced: "当社調達",
  mixed: "一部支給",
};
export const present = (f: Field) =>
  f.value
    ? (labels[f.value.text] ?? f.value.text)
    : {
        unknown: "分からない",
        skipped: "未回答（スキップ）",
        not_applicable: "該当なし",
        conflict: "条件が競合しています",
        not_asked: "未確認",
        known: "",
      }[f.status];
export function normalized(n: number, unit: string) {
  const map: Record<string, [string, number]> = {
    mm: ["length", 1],
    cm: ["length", 10],
    m: ["length", 1000],
    "℃": ["temperature", 1],
    "°C": ["temperature", 1],
    Pa: ["pressure", 1],
    kPa: ["pressure", 1000],
    MPa: ["pressure", 1000000],
    秒: ["time", 1],
    分: ["time", 60],
    時間: ["time", 3600],
  };
  const [dimension, factor] = map[unit] ?? [unit, 1];
  return { dimension, value: n * factor };
}

import { applyInput, newItem } from "../domain/intake";
import {
  id,
  type Snapshot,
  type Question,
  type Change,
  type InputEvent,
  type Item,
} from "../domain/model";
import { capacityCues, capacityNumberPattern, fields, flexibleCondition, parseCapacity, requiredDateIsHard } from "../domain/fields";
import { resolveDimensionAnswer, resolveDimensionDesignation, dimensionKeys, dimensionAliases } from "../domain/dimensions";
import { explicitHoleLayout, isTentative } from "../domain/grounding";

const names =
  /(?:SUS\d{3}|ステンレス|アルミ|鉄)(?:の)?(?:板|パイプ|丸棒|角材)|耐熱金物|交換部品|リング材|リング|ガラス|パッキン|カバー|ネック|架台|部品[A-Za-z0-9]+|部品|[A-Z]{1,10}-\d+[A-Z0-9-]*/g;
const vague =
  /^(?:はい|いいえ|それで|たぶん|多分|まあ|そうです|同じです|おまかせ)[。！!\s]*$/;
const unknown =
  /分か(?:ら|りません|ん)|わか(?:ら|りません|ん)|不明|知ら|読めない|読めません|判読でき|未定|後で決め|まだ決め|決まっていない|決めていない|まだ測|まだ確認|指定(?:は|が)?なし|指定(?:は|が)?ありません/;
const scope = (text: string) =>
  /購入|買い|買う|探して|注文|AX-100/.test(text)
    ? "purchase"
    : /製作|作って|作り/.test(text)
      ? "fabrication"
      : /加工|穴を開け/.test(text)
        ? "processing"
        : null;

function segmentsOf(text: string): string[] {
  const parts: string[] = [];
  for (const line of text.split(/\n+/).filter((v) => v.trim())) {
    const matches = [...line.matchAll(names)].filter(
      (m) =>
        m.index === 0 ||
        /[、。,と\s]|それと|あと$/.test(
          line.slice(Math.max(0, m.index! - 3), m.index),
        ),
    );
    const starts = matches.slice(1).map((m) => m.index!);
    let at = 0;
    for (const end of [...starts, line.length]) {
      parts.push(line.slice(at, end).trim());
      at = end;
    }
  }
  return parts.filter(Boolean);
}

function numeric(segment: string, pattern: RegExp) {
  // Old values are often repeated without their unit: 外径は100ではなく120mm.
  const normalized = segment.replace(
    /(\d+(?:\.\d+)?)\s*(?:mm|cm|m|℃|°C|個|枚|組|台|本|kg)?\s*(?:ではなく(?:て)?|じゃなく(?:て)?|でなく)\s*(\d+(?:\.\d+)?)\s*(mm|cm|m|℃|°C|個|枚|組|台|本|kg)/g,
    "$2$3",
  );
  const m = pattern.exec(normalized);
  if (!m) return null;
  let text = m[1] + m[2],
    n = Number(m[1]),
    unit = m[2];
  const rest = normalized.slice(m.index + m[0].length);
  const correction =
    /^(?:\s|[、,])*(?:ではなく(?:て)?|じゃなく(?:て)?|でなく|から)(?:\s|[、,])*(\d+(?:\.\d+)?)\s*(mm|cm|m|℃|°C|MPa|kPa|Pa|秒|分|時間|個|枚|組|台|本|kg)/.exec(
      rest,
    );
  if (correction) {
    n = Number(correction[1]);
    unit = correction[2];
    text = correction[1] + unit;
  }
  // The stored attribute quote is the actual numeric token, including its unit.
  const token = segment
    .match(
      new RegExp(
        `${String(n).replace(".", "\\.")}\\s*${unit.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
        "g",
      ),
    )
    ?.at(-1);
  return { text, n, unit, quote: token ?? m[0] };
}

/** Deterministic local-only extraction. Never invents manufacturer specifications or a verdict. */
export function extractDemoDialogue(
  s: Snapshot,
  text: string,
  q: Question | null = null,
): Snapshot {
  const resolved = resolveDimensionAnswer(s, text, q);
  if (resolved) return resolved;
  const event: InputEvent = { id: id(), text, type: "customer_text" };
  let state = resolveDimensionDesignation(s, text, q) ?? structuredClone(s);
  state.extractionFailed = false;
  const segments = segmentsOf(text);
  const additions: Item[] = [],
    changes: Change[] = [];
  const explicitScopes = [...new Set(segments.map(scope).filter(Boolean))];
  const sharedScope = explicitScopes.length === 1 ? explicitScopes[0] : null;
  // Preserve the existing explicit split flow for four genuinely separate items.
  if (
    !s.brief.items.length &&
    segments.length > 3 &&
    new Set(segments.map((t) => t.match(names)?.[0] ?? t)).size > 3
  ) {
    state.overflow.push(text);
    state.inputs.push(event);
    return state;
  }
  for (const segment of segments) {
    const all = [...state.brief.items, ...additions];
    const named = segment.match(names)?.[0];
    let item = named
      ? all.find(
          (i) =>
            i.label === named ||
            (i.label.includes(named) &&
              (named !== "部品" || /部品/.test(i.label))),
        )
      : q?.itemId
        ? all.find((i) => i.id === q.itemId)
        : all.length === 1
          ? all[0]
          : undefined;
    if (!item && named && /^[A-Z]{1,10}-\d/.test(named) &&
      (q?.fieldKey === "model" || /型番|訂正|変更|ではなく/.test(segment)))
      item = all.find((i) => i.id === q?.itemId) ?? (all.length === 1 ? all[0] : undefined);
    if (
      !item &&
      all.length === 1 &&
      named &&
      /^[A-Z]+-\d/.test(named) &&
      isTentative(segment) &&
      all[0].fields.some((f) => f.key === "model")
    )
      item = all[0];
    if (!item && !named && all.length > 1) {
      state.extractionFailed = true;
      continue;
    }
    if (!item) {
      if (all.length >= 3) {
        state.overflow.push(segment);
        continue;
      }
      const label = named ?? segment.match(/SUS\d{3}|ステンレス|アルミ|鉄|ゴム/)?.[0] ?? segment.split(/[、。\s]/)[0].slice(0, 60);
      const requested =
        scope(segment) ?? (all.length === 0 ? sharedScope : null);
      const profile =
        /架台|図面/.test(segment) || requested === "fabrication"
          ? "fabrication"
          : /[A-Z]+-\d+/.test(label)
            ? "known_model"
            : /交換|パッキン|ガラス|写真|部品/.test(segment)
              ? "replacement"
              : "unknown";
      item = newItem(
        label,
        profile,
        /AX-100/.test(segment)
          ? "demo_switch"
          : /架台/.test(segment)
            ? "demo_frame"
            : /リング/.test(segment)
              ? "demo_ring"
              : null,
      );
      additions.push(item);
    }
    const add = (
      key: string,
      value: string,
      quote = value,
      number: number | null = null,
      unit: string | null = null,
    ) => {
      const clause = segment.split(/[、,。！？!?\n]/).find((c) => c.includes(quote)) ?? quote;
      const flexible = flexibleCondition.test(clause);
      changes.push({ itemId: item!.id, key, text: value,
        quote: flexible || (key === "required_date" && requiredDateIsHard(clause)) ? clause : quote,
        number, unit,
        ...(key === "required_date" ? { hardConstraint: requiredDateIsHard(clause) } : flexible ? { hardConstraint: false } : {}),
      });
    };
    const setUnknown = (key: string, quote: string) =>
      changes.push({ itemId: item!.id, key, status: "unknown", quote });
    if (!item.fields.length && !changes.some((c) => c.itemId === item!.id))
      add("description", item.label, segment.slice(0, 500));
    const model = segment.match(/型番[は：: ]*([A-Za-z0-9][A-Za-z0-9_./-]*)/)?.slice(1) ?? segment.match(/[A-Z]{1,10}-\d+[A-Z0-9-]*/);
    if (model)
      add(
        "model",
        model[0],
        isTentative(segment) &&
          item.fields.some(
            (f) => f.key === "model" && f.value?.text !== model[0],
          )
          ? segment.slice(0, 500)
          : model[0],
      );
    if (/型番.{0,12}(?:分から|わから|不明)|名前も型番も分か/.test(segment))
      setUnknown("model", segment.slice(0, 500));
    const maker = segment.match(/メーカー[：:は ]+([^、。\s]+)/);
    if (maker && !unknown.test(maker[1])) add("manufacturer", maker[1]);
    for (const [key, cue] of [
      ["manufacturer", /メーカー/],
      ["model", /型番/],
      ["material", /材質/],
      ["normal_temperature", /(?<!最高|ピーク)温度|通常|普通/],
      ["peak_temperature", /最高|ピーク/],
      ["coating", /塗装/],
      ["quantity", /数量|枚数|個数/],
      ["mounting", /取付|取り付け/],
      ["marking", /刻印|表示|文字/],
      ["width", /幅/],
      ["height", /高さ/],
      ["depth", /奥行/],
      ["overall_length", /全長|長さ/],
      ["outer_diameter", /外径/],
      ["thickness", /厚さ|板厚/],
      ["inner_diameter", /内径/],
      ["hole_diameter", /穴径|穴の直径|穴の径/],
      ["hole_count", /穴数|穴/],
      ["hole_layout", /穴(?:の)?(?:位置|配置|ピッチ)|穴間隔|ピッチ|PCD/i],
      ["capacity", /容量|容積|内容量/],
      ["material_supply", /材料|支給|調達/],
      ["drawing_available", /図面/],
      ["tolerance", /公差|精度/],
      ["destination", /配送先|納入先|届け先/],
      ["required_date", /希望日|必要な日|必要日|納期/],
    ] as const) {
      const clause = segment
        .split(/[。！？!?\n]/)
        .find((c) => cue.test(c) && unknown.test(c));
      if (
        clause &&
        !changes.some(
          (c) =>
            c.itemId === item!.id && c.key === key && c.status !== "unknown",
        )
      )
        setUnknown(key, clause);
    }
    const requested =
      scope(segment) ?? (!item.fields.length ? sharedScope : null);
    if (requested) add("request_scope", requested, segment.slice(0, 500));
    if (
      /材料も|材料(?:の|を)?調達|御社(?:で)?調達|当社調達|(?:そちら|御社|会社).{0,6}(?:用意|調達)/.test(
        segment,
      )
    )
      add("material_supply", "company_sourced", segment.slice(0, 500));
    else if (/一部支給/.test(segment))
      add("material_supply", "mixed", "一部支給");
    else if (
      /(?:材料|リング材|リング|支給材).{0,8}支給|支給材|(?:こちら|当方).{0,6}用意/.test(
        segment,
      ) &&
      !(/塗料/.test(segment) && !/材料|リング|支給材/.test(segment))
    )
      add("material_supply", "customer_supplied", segment.slice(0, 500));
    const mat = segment.match(/SUS\d{3}|ステンレス|アルミ|鉄|ゴム/);
    if (mat)
      add(
        "material",
        mat[0],
        isTentative(segment) ? segment.slice(0, 500) : mat[0],
      );
    for (const [key, def] of Object.entries(fields)) {
      if (!def.units || key === "quantity" || key === "capacity") continue;
      if (key === "hole_diameter" && /見える穴/.test(segment)) continue;
      const alias =
        key === "normal_temperature"
          ? "通常(?:温度)?|普通(?:の温度)?|使用温度|使う温度|使う場所の温度|(?<!最高|ピーク)温度"
          : key === "peak_temperature"
            ? "最高(?:温度)?|ピーク(?:温度)?"
            : key === "overall_length" ? "全長|長さ"
            : key === "hole_diameter" ? "穴径|穴の直径|穴の径|直径(?=\\d+(?:\\.\\d+)?\\s*(?:mm|cm|m)の穴)"
            : key === "hole_count" ? "穴数|穴[はを]?"
            : key === "thickness" ? "厚さ|板厚"
            : key === "width" ? "幅|横(?:の長さ)?"
            : key === "height" ? "高さ|縦(?:の長さ)?" : def.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pattern = new RegExp(
        `(?:${alias})[はをもが：: ]*(?:測り直して|測ったら|確認したら)?[は：: ]*(\\d+(?:\\.\\d+)?)\\s*(mm|cm|m|℃|°C|MPa|kPa|Pa|秒|分|時間|か所|箇所|穴|個)`,
      );
      const first = pattern.exec(segment);
      if (
        key === "normal_temperature" &&
        first &&
        /最高|ピーク$/.test(
          segment.slice(Math.max(0, first.index - 3), first.index),
        )
      )
        continue;
      const value = numeric(segment, pattern);
      if (value) add(key, value.text, value.quote, value.n, value.unit);
    }
    const clauses = segment.split(/[、,。！？!?\n]/).map((clause) => clause.trim()).filter(Boolean);
    const directsCapacity = q?.itemId === item.id && q.fieldKey === "capacity";
    const capacityPrefix = `(?:(?:${capacityCues.join("|")})[はが:： ]*)`;
    const capacityPhrase = new RegExp(
      `^${capacityPrefix}${directsCapacity ? "?" : ""}${capacityNumberPattern}(?:です|でお願いします)?$`,
      "u",
    );
    const volume = clauses.find((clause) => capacityPhrase.test(clause));
    const token = volume?.match(new RegExp(capacityNumberPattern, "u"))?.[0];
    const capacity = token ? parseCapacity(token) : null;
    if (volume && capacity) add("capacity", capacity.text, volume, capacity.number, capacity.unit);
    const layout = clauses.map((clause) =>
      explicitHoleLayout(clause, q?.itemId === item.id && q.fieldKey === "hole_layout"),
    ).find((clause) => clause !== null);
    if (layout) add("hole_layout", layout);
    const processes = [...segment.matchAll(/旋盤加工|フライス加工|マシニング加工|切削加工|研削加工|板金加工|溶接|穴加工|曲げ加工|切断|穴を開け/g)];
    if (processes.length) {
      const first = processes[0], last = processes.at(-1)!;
      const process = segment.slice(first.index!, last.index! + last[0].length);
      if (process.length <= 300) add("process", process);
    }
    const quantity = numeric(segment, /(?:数量|個数|枚数)[はをが：: ]*(\d+(?:\.\d+)?)\s*(個|枚|組|台|本|kg|m)/)
      ?? (q?.itemId === item.id && q.fieldKey === "quantity" ? numeric(segment, /^(\d+(?:\.\d+)?)\s*(個|枚|組|台|本|kg|m)/) : null);
    if (quantity) add("quantity", quantity.text, quantity.quote, quantity.n, quantity.unit);
    const bareDimensions = [...segment.matchAll(/(\d+(?:\.\d+)?)\s*(mm|cm|m)(?![A-Za-z])/g)].filter((m) =>
      !changes.some((c) => c.itemId === item!.id && (dimensionKeys.includes(c.key) || c.key === "quantity") && c.number === Number(m[1]) && c.unit === m[2]) &&
      !clauses.some((clause) => clause.includes(m[0]) && explicitHoleLayout(clause, q?.itemId === item.id && q.fieldKey === "hole_layout")) &&
      !dimensionKeys.some((key) => dimensionAliases(key).some((label) => segment.slice(Math.max(0, m.index! - 15), m.index).includes(label)))
    );
    if (bareDimensions.length > 1) state.extractionFailed = true;
    if (bareDimensions.length === 1 && !isTentative(segment) && !/ではなく|訂正|変更|じゃなく/.test(segment)) {
      const m = bareDimensions[0];
      // A bare number in an explicit dimension question is already attributable.
      const direct = q?.itemId === item.id && dimensionKeys.includes(q.fieldKey) ? q.fieldKey : "dimension_unspecified";
      add(direct, Number(m[1]) + m[2], m[0], Number(m[1]), m[2]);
    }
    const holeCount = numeric(segment, /穴(?:[はをが：: ]*)(\d+(?:\.\d+)?)\s*(か所|箇所|個|穴)/);
    if (holeCount) add("hole_count", holeCount.text, holeCount.quote, holeCount.n, holeCount.unit);
    const qty = numeric(segment.replace(/穴(?:[はをが：: ]*)\d+(?:\.\d+)?\s*(?:か所|箇所|個|穴)/g, ""), /(\d+(?:\.\d+)?)\s*(個|枚|組|台|本|kg)/);
    if (qty) add("quantity", qty.text, qty.quote, qty.n, qty.unit);
    const coating = segment.match(
      /塗装(?:は|が)?(?:不要|なし|無し|しない|しません)|(?:グレー|灰色|黒|白|赤)(?:の|で)?塗装|外装塗装/,
    );
    if (coating) add("coating", coating[0]);
    const date = segment.match(
      /来月上旬|来月中旬|来月下旬|今月末|来月末|今週中|来週(?:中|末)?|再来週|明日|明後日|\d{4}-\d{2}-\d{2}|\d+月\d+日/,
    );
    if (date) add("required_date", date[0]);
    else {
      const declaredDate = segment.match(/(?:希望納期|希望納入日|希望日|納期)[はが：: ]*([^、。\n]+)/);
      if (declaredDate && !unknown.test(declaredDate[0]) && !isTentative(declaredDate[0]))
        add("required_date", declaredDate[1], declaredDate[0]);
    }
    const drawing = segment.match(/図面(?:は|が|も)?(?:あり(?:ます)?|ある|なし|無い|ありません)/);
    if (drawing) add("drawing_available", drawing[0]);
    const tolerance = segment.match(/(?:公差|精度)[は：: ]*[^、。]{1,60}/);
    if (tolerance && !unknown.test(tolerance[0])) add("tolerance", tolerance[0]);
    const product = segment.match(/(?:品名|商品名|対象)[は：: ]+([^、。]+)/);
    if (product && !unknown.test(product[1])) add("product_name", product[1]);
    const supplied = segment.match(/塗料[^、。]{0,20}支給[^、。]*/);
    if (supplied) add("supplied_parts", supplied[0]);
    const excluded = segment.match(/(?:脚|リブ).{0,3}(?:不要|除外|作らな)/);
    if (excluded) add("excluded_work", excluded[0]);
    const destination =
      segment.match(/(?:配送先|納入先)[は：: ]+([^、。\n]+)/) ??
      segment.match(
        /(?:^|[。、\s])([^、。\s]{1,20}(?:工場|倉庫|営業所|事業所))(?:へ|に)/,
      );
    if (destination) add("destination", destination[1], destination[0]);
    const marking = segment.match(
      /(?:刻印|文字の表示|表示)[はもが：: ]*([^、。]+)/,
    );
    if (marking && !unknown.test(marking[1])) add("marking", marking[0]);
    const initialPurpose = segment.match(
      /([^、。]{1,100}(?:に使(?:う|います)|の漏れ止め|の保護用|の交換用|を載せる|を固定する))/,
    );
    if (initialPurpose) add("purpose", initialPurpose[1]);
    const holeWork = segment
      .split(/[。！？!?\n]/)
      .find((c) => /穴/.test(c) && /直径|穴径/.test(c));
    if (holeWork && !isTentative(holeWork))
      add("process", holeWork.slice(0, 300));
    const revision = segment.match(
      /(?:図面(?:の)?(?:版|改訂)?|改訂)[は：: ]*([A-Z](?:\d+)?)(?=$|です|でした|[、。\s版])/,
    );
    if (revision) add("drawing_revision", revision[1]);
    const mounting = segment.match(
      /(?:取付方法|取り付け方法)[は：: ]+([^、。]+)/,
    );
    if (mounting && !unknown.test(mounting[1])) add("mounting", mounting[1]);
    const purpose = segment.match(/用途[：:は ]+([^、。]+)/);
    if (purpose && !unknown.test(purpose[1])) add("purpose", purpose[1]);
    if (
      q?.itemId === item.id &&
      fields[q.fieldKey] &&
      !changes.some((c) => c.itemId === item!.id && c.key === q.fieldKey)
    ) {
      const clauses = segment
        .split(/[。！？!?\n]/)
        .map((v) => v.trim())
        .filter(Boolean);
      const def = fields[q.fieldKey];
      const first = clauses[0] ?? "";
      const namedUnknown = clauses.find(
        (c) =>
          unknown.test(c) &&
          (c.includes(def.label) ||
            (q.fieldKey === "mounting" && /取り付|取付/.test(c)) ||
            (q.fieldKey === "purpose" && /用途/.test(c)) ||
            (clauses.length === 1 &&
              !Object.values(fields).some((d) => c.includes(d.label)))),
      );
      if (namedUnknown) setUnknown(q.fieldKey, namedUnknown);
      else if (!vague.test(first) && !isTentative(first)) {
        if (def.units) {
          const value = numeric(
            segment,
            /(\d+(?:\.\d+)?)\s*(mm|cm|m|℃|°C|か所|箇所|穴|個|枚|組|台|本|kg)/,
          );
          if (
            value &&
            def.units.includes(value.unit) &&
            !changes.some((c) => c.itemId === item!.id && fields[c.key]?.units)
          )
            add(q.fieldKey, value.text, value.quote, value.n, value.unit);
        } else if (!def.values && q.fieldKey !== "hole_layout") {
          const cue =
            q.fieldKey === "purpose"
              ? /用途|窓|使|使用|固定|用です|ため|載せ|支え|点検|交換用/
              : q.fieldKey === "work_scope"
                ? /部分|フレーム|脚|全体|だけ|のみ|範囲|穴|製作|加工|除外/
                : q.fieldKey === "mounting"
                  ? /枠|はめ|挟|固定|ボルト|ネジ|ねじ|取付|取り付|接着|溶接/
                  : null;
          const answer = cue
            ? clauses.find(
                (c) =>
                  cue.test(c) &&
                  !(
                    q.fieldKey === "purpose" &&
                    /外径|温度|数量/.test(c) &&
                    !/に使|ため|用途/.test(c)
                  ),
              )
            : clauses.find(
                (c) =>
                  !/\d\s*(?:mm|cm|℃|°C|個|枚|組|台|本)/.test(c) &&
                  !Object.entries(fields).some(
                    ([key, field]) =>
                      key !== q.fieldKey && c.includes(field.label),
                  ),
              );
          if (answer && !unknown.test(answer) && !vague.test(answer))
            add(q.fieldKey, answer.slice(0, 300));
        }
      }
    }
  }
  const dedup = [
    ...new Map(changes.map((c) => [c.itemId + ":" + c.key, c])).values(),
  ];
  const pending = dedup.filter(
    (c) =>
      isTentative(c.quote) &&
      s.brief.items.some(
        (i) =>
          i.id === c.itemId &&
          i.fields.some((f) => f.key === c.key && f.value?.text !== c.text),
      ),
  );
  state = applyInput(
    state,
    event,
    dedup.filter((c) => !pending.includes(c)),
    additions,
  );
  state.unresolvedInputs = (state.unresolvedInputs ?? []).filter(
    (e) => e.text !== text,
  );
  if (
    pending.length ||
    (isTentative(text) &&
      /SUS|材質|材料|調達/.test(text) &&
      s.brief.items.length)
  ) {
    state.unresolvedInputs.push(event);
    state.pendingChanges = [
      ...(state.pendingChanges ?? []),
      ...(pending.length
        ? pending.map((p) => ({
            eventId: event.id,
            itemId: p.itemId,
            key: p.key,
          }))
        : s.brief.items.flatMap((i) =>
            (/材料|調達/.test(text) ? ["material_supply"] : ["material"]).map(
              (key) => ({ eventId: event.id, itemId: i.id, key }),
            ),
          )),
    ];
    state.recoveryOffered = false;
  }
  return state;
}

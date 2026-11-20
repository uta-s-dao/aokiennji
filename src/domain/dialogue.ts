import type {
  Snapshot, Item, Question, CapabilityRule, IntakeAxes,
} from "./model";
import { fields, labels } from "./fields";
import { customerCylinderQuestion, customerItemName, customerQuestion } from "./customer-copy";
import { resolveCategories } from "./category";
import { dimensionKeys } from "./dimensions";
import { isTentative } from "./grounding";
import { purchaseProductFamily } from "./product-family";

const known = (item: Item, key: string) =>
  item.fields.find((f) => f.key === key && f.status === "known")?.value?.text;

function cylinderWork(item: Item): boolean {
  const request = known(item, "request_scope");
  if (request
    ? request !== "fabrication" && request !== "processing"
    : item.profile !== "fabrication") return false;
  return [item.label, known(item, "description"), known(item, "work_scope")]
    .some((text) => /円筒/.test(text ?? ""));
}

const cylinderDimensions = ["inner_diameter", "outer_diameter", "overall_length"];

export function unresolvedKeys(text: string): string[] {
  const keys = Object.entries(fields)
    .filter(([key, def]) => key !== "description" && text.includes(def.label))
    .map(([key]) => key);
  if (/温度/.test(text) && !keys.some((k) => k.includes("temperature")))
    keys.push("normal_temperature");
  if (/調達|支給/.test(text)) keys.push("material_supply");
  return [...new Set(keys)];
}

function question(s: Snapshot, item: Item, key: string): Question {
  const qid = `${item.id}:${key}`;
  const retry = (s.questionAttempts?.[qid] ?? 0) > 0;
  if (key === "inner_diameter" && cylinderWork(item)) {
    const description = known(item, "description") ?? "";
    const hollow = known(item, "body_structure") === "hollow" || /^(?:中(?:は|が)\s*)?(?:空洞|中空)(?:です|になっています)?[。！!]?$/u.test(description.trim());
    return {
      id: qid,
      itemId: item.id,
      fieldKey: key,
      text: customerCylinderQuestion(item, hollow, retry),
      inputType: "text",
      options: hollow ? [] : [{ id: "not_applicable", label: "無垢（中は詰まっている）" }],
      allowUnknown: true,
      allowSkip: true,
    };
  }
  const opts = fields[key].values ?? [];
  return {
    id: qid,
    itemId: item.id,
    fieldKey: key,
    text: retry
      ? `${customerItemName(item)}の${fields[key].label}を確認できませんでした。${fields[key].units ? `例：10${fields[key].units![0]}のように教えてください。` : "具体的に教えてください。不明でも進めます。"}`
      : customerQuestion(item, key),
    inputType: opts.length ? "select" : fields[key].units ? "number" : "text",
    options: opts.map((v) => ({ id: v, label: labels[v] ?? v })),
    allowUnknown: true,
    allowSkip: true,
  };
}

const blanketDimensions = ["thickness", "width", "overall_length"];
const frameDimensions = ["width", "height", "depth"];
const holeDimensions = ["hole_diameter", "hole_count"];
const modelSpecification = (key: string) =>
  dimensionKeys.includes(key) ||
  ["material", "manufacturer", "marking", "process", "capacity", "hole_layout"].includes(key);

function workRequest(item: Item): boolean {
  const requested = known(item, "request_scope");
  return requested ? ["processing", "fabrication"].includes(requested) : item.profile === "fabrication";
}

function productTexts(item: Item): string[] {
  const name = item.fields.find((field) => field.key === "product_name" && field.status === "known");
  const description = item.fields.find((field) => field.key === "description" && field.status === "known");
  const correctedName = name && name.eventId !== description?.eventId &&
    (name.source === "field_edit" || /訂正|ではなく|じゃなく|変更|正しく/u.test(name.quote ?? ""));
  return [name?.value?.text ?? item.label, correctedName ? "" : (description?.value?.text ?? "")]
    .flatMap((text) => text.split(/[。！？、，,\n]/))
    .map((text) => text.trim())
    .filter((text) => text && !/^(?:用途|使用箇所|使用目的)(?:は|が|[:：])/u.test(text));
}

function isRing(product: string[]): boolean {
  return !product.some((text) =>
    /リング(?:材)?(?:用|向け|の(?:工具|治具)|(?:の|を|加工)[^、。]{0,16}(?:する|使う|用の?)(?:工具|治具))/.test(text),
  ) &&
    product.some((text) => /リング(?:材)?/.test(text));
}

function isFrame(product: string[]): boolean {
  return !product.some((text) =>
    /架台(?:用|向け|の(?:塗料|工具|治具|部品)|に(?:塗る|使う)(?:塗料|工具|治具))/.test(text),
  ) &&
    product.some((text) => /架台/.test(text));
}

function isInsulationBlanket(product: string[]): boolean {
  return product.some((text) =>
    /(?:ブランケット|blanket)(?!用|向け)/i.test(text) &&
    purchaseProductFamily(text) === "断熱材",
  );
}

function isGlassContainer(item: Item, product: string[]): boolean {
  if (product.some((text) => /(?:容器|ボトル|瓶|ビーカー)(?:用|向け|の(?:蓋|ふた|工具|治具))/.test(text)))
    return false;
  const glass = /ガラス|硝子/;
  const glassMaterial = glass.test(known(item, "material") ?? "") ||
    product.some((text) => /^(?:耐熱)?(?:ガラス|硝子)製(?:です)?$/.test(text));
  return product.some((text) => /容器|ボトル|瓶|びん|ビーカー/.test(text) &&
    (glassMaterial || glass.test(text)));
}

function machiningHoles(item: Item, product: string[]): boolean {
  const process = known(item, "process") ?? "";
  const excludesHoles = /(?:穴(?:加工|あけ|開け)?|孔加工|ドリル加工)(?:は|が)?(?:不要|なし|無し|しない)/;
  if ([process, ...product].some((text) => excludesHoles.test(text))) return false;
  return /穴|孔|ドリル/.test(process) ||
    product.some((text) => /穴加工|穴あけ|穴開け|孔加工|ドリル加工/.test(text));
}

export function supplierInquiryGeometry(item: Item): string[] {
  const requested = known(item, "request_scope");
  const product = productTexts(item);
  if (!workRequest(item) && isInsulationBlanket(product)) return [...blanketDimensions];
  if (requested === "fabrication" && isFrame(product)) return [...frameDimensions];
  if (workRequest(item) && isRing(product) && machiningHoles(item, product))
    return [...holeDimensions, "hole_layout"];
  if (requested === "purchase" && !known(item, "model") && isGlassContainer(item, product))
    return ["capacity"];
  return [];
}

/** Intake before supplier research must leave an actionable enquiry, even without a rule match. */
export function partnerIntakeKeys(item: Item, s: Snapshot): string[] {
  const requested = known(item, "request_scope");
  const work = workRequest(item);
  const model = known(item, "model");
  const product = productTexts(item);
  const geometry = supplierInquiryGeometry(item);
  if (!work && model) return ["request_scope", ...geometry, "quantity", "required_date"];

  const context = [item.label, ...item.fields.filter((f) => f.status === "known").map((f) => f.value?.text ?? "")].join(" ");
  const process = known(item, "process") ?? "";
  const plate = product.some((text) => /板|プレート|板金|カバー/.test(text));
  const round = isRing(product) || product.some((text) => /丸|棒|パッキン|パイプ/.test(text));
  const holes = work && machiningHoles(item, product);
  const cylinder = cylinderWork(item);
  let dimensions: string[] = [];
  if (/旋盤/.test(process)) dimensions = ["outer_diameter", "overall_length"];
  else if (plate) dimensions = ["thickness", "width", "height"];
  else if (round) dimensions = ["outer_diameter", ...(product.some((text) => /棒|パイプ/.test(text)) ? ["overall_length"] : ["inner_diameter", "thickness"])];
  else if (work && /フライス|マシニング|切削|切断/.test(process)) dimensions = frameDimensions;

  const genericTarget = /^(?:部品[A-Za-z0-9]*|加工品|製作品|材料|SUS\d{3}|ステンレス|アルミ|鉄|この品目)$/.test(item.label);
  const frame = requested === "fabrication" && geometry.includes("depth");
  const cylinderFabrication = requested === "fabrication" && cylinder;
  const workQuestions = frame ? ["work_scope"] : cylinderFabrication ? [] : [
    ...(holes && !process ? [] : ["process"]),
    ...(genericTarget || requested === "fabrication" ? ["work_scope"] : []),
  ];
  return [
    "request_scope",
    ...(work ? geometry : []),
    ...(cylinder && !frame ? cylinderDimensions : []),
    ...(work ? workQuestions : ["model", "purpose"]),
    "material",
    ...(work ? [] : geometry),
    ...(cylinder || geometry.includes("depth") || geometry.includes("overall_length") ? [] : dimensions),
    ...(holes && !geometry.includes("hole_layout") ? holeDimensions : []),
    "quantity", "required_date",
    ...(work ? ["material_supply"] : []),
    ...(work && (/図面|図番/.test(context) || s.brief.attachmentRefs.some((a) => !a.itemId || a.itemId === item.id)) ? ["drawing_available"] : []),
    ...(work && /公差|精度|はめあい|嵌合/.test(context) ? ["tolerance"] : []),
  ];
}

// A question count is a usage statistic, not evidence that the consultation is complete.
export function nextDialogueQuestion(
  s: Snapshot,
  rules: CapabilityRule[],
  force = false,
  axes?: IntakeAxes,
  partnerIntake = false,
): Question | null {
  if (force || s.overflow.length) return null;
  const items = resolveCategories(s.brief.items, rules);
  // undefined uses known rule axes; [] explicitly says no matching axis is available.
  for (const item of items) {
    const pending = item.fields.find((f) => f.key === "dimension_unspecified" && f.status === "known");
    const ruleAxes = rules.filter((r) => r.category === item.category && (!partnerIntake || (r.approvalStatus === "approved" && r.validUntil && Date.parse(r.validUntil) > Date.now()))).flatMap((r) => [...r.requiredFields, ...r.predicates.map((p) => p.field)]);
    const suppliedAxes = axes?.filter((a) => a.itemId === item.id).flatMap((a) => a.fieldKeys) ?? [];
    const relevant = partnerIntake
      ? [
          ...partnerIntakeKeys(item, s),
          ...[...ruleAxes, ...suppliedAxes].filter((key) =>
            !(known(item, "model") && !workRequest(item) && modelSpecification(key)),
          ),
        ]
      : axes === undefined ? ruleAxes : suppliedAxes;
    if (!pending || !relevant.some((key) => dimensionKeys.includes(key))) continue;
    const qid = `${item.id}:dimension_unspecified`;
    if (s.deferredQuestions?.includes(qid)) continue;
    const candidates = [...new Set(relevant.filter((key) => dimensionKeys.includes(key)))];
    return {
      ...question(s, item, "dimension_unspecified"),
      text: `${customerItemName(item)}の${pending.value!.text}は、${candidates.map((key) => fields[key].label).join("・")}の${candidates.length === 1 ? "寸法でしょうか、それとも別の寸法ですか" : "どの寸法ですか"}？`,
      inputType: "text",
    };
  }
  const unsettled = (s.unresolvedInputs ?? []).filter(
    (e) => !isTentative(e.text),
  );
  for (const event of unsettled) {
    if (!event.partialFor) continue;
    const { itemId, fieldKey } = event.partialFor;
    const item = items.find((item) => item.id === itemId);
    const id = `clarify:${event.id}:${fieldKey}`;
    if (!item || !fields[fieldKey] ||
        (s.questionAttempts?.[id] ?? 0) >= 2 || s.deferredQuestions?.includes(id))
      continue;
    return {
      ...question(s, item, fieldKey),
      id,
      text: `「${event.text.slice(0, 100)}」について、分かる範囲で詳しく教えてください。`,
      inputType: "text",
      options: [],
    };
  }
  for (const event of unsettled) {
    if (event.partialFor) continue;
    const targets = (s.pendingChanges ?? []).filter(
      (p) => p.eventId === event.id,
    );
    const item =
      items.find((i) => targets.some((t) => t.itemId === i.id)) ??
      (items.length === 1 ? items[0] : undefined);
    const keys = targets.length
      ? targets.map((t) => t.key)
      : unresolvedKeys(event.text);
    if (item && keys.length) {
      for (const key of keys) {
        if (!fields[key]) continue;
        const id = `clarify:${event.id}:${key}`;
        if (
          (s.questionAttempts?.[id] ?? 0) >= 2 ||
          s.deferredQuestions?.includes(id)
        )
          continue;
        return {
          ...question(s, item, key),
          id,
          text: `${customerItemName(item)}の${fields[key].label}について、ご希望の内容を確認させてください。${fields[key].units ? `単位付きで教えてください（例：10${fields[key].units![0]}）。` : "変更は未定なら、不明のまま進められます。"}`,
        };
      }
    } else if (!s.recoveryOffered) {
      return {
        id: "input-recovery",
        itemId: item?.id ?? null,
        fieldKey: "description",
        text: s.extractionError === "MODEL_TIMEOUT"
          ? "回答の処理に時間がかかりました。入力は保存しています。品物を特定する手掛かりをもう一つ教えてください。"
          : "このご相談を読み取れませんでした。品目と、分かる条件を一つずつ教えてください。",
        inputType: "text",
        options: [],
        allowUnknown: true,
        allowSkip: true,
      };
    }
  }
  if (!items.length) {
    if (s.recoveryOffered) return null;
    return {
      id: "initial",
      itemId: null,
      fieldKey: "description",
      text: "名称・用途・写真のいずれかを教えてください。",
      inputType: "text",
      options: [],
      allowUnknown: true,
      allowSkip: true,
    };
  }
  for (const item of items) {
    const applicable = rules.filter(
      (r) =>
        r.approvalStatus === "approved" &&
        r.validUntil &&
        Date.parse(r.validUntil) > Date.now() &&
        r.category === item.category,
    );
    const requested = known(item, "request_scope");
    const completeModel =
      item.profile === "known_model" &&
      known(item, "model") &&
      applicable.some((r) => r.assessmentScope === "request");
    const glass = /ガラス/.test(item.label);
    const round =
      glass ||
      /リング|パッキン|丸|外径/.test(
        item.label +
          " " +
          (item.fields.find((f) => f.key === "description")?.quote ?? ""),
      );
    const work =
      requested === "fabrication" ||
      requested === "processing" ||
      item.profile === "fabrication";
    const cylinder = cylinderWork(item);
    const profileKeys = partnerIntake
      ? partnerIntakeKeys(item, s)
      : completeModel
      ? []
      : [
          ...(work && !(cylinder && requested === "fabrication") ? ["work_scope"] : []),
          "purpose",
          "request_scope",
          ...(work ? ["material_supply"] : []),
          ...(!glass && !work ? ["model", "manufacturer", "marking"] : []),
          "material",
          ...(glass ? ["normal_temperature"] : []),
          ...(cylinder
            ? []
            : round
            ? ["outer_diameter", "thickness"]
            : ["width", "height", ...(work ? ["depth"] : [])]),
          ...(glass
            ? ["mounting"]
            : requested === "processing"
              ? ["process"]
              : []),
          "quantity",
          "coating",
          "destination",
          "required_date",
          ...(work && s.brief.attachmentRefs.length
            ? ["drawing_revision"]
            : []),
        ];
    const ruleKeys = applicable.flatMap((r) => [
      ...r.requiredFields, ...r.predicates.map((p) => p.field),
    ]);
    const suppliedKeys = axes?.filter((a) => a.itemId === item.id).flatMap((a) => a.fieldKeys) ?? [];
    const extraKeys = [...ruleKeys, ...suppliedKeys].filter((key) =>
      !(partnerIntake && known(item, "model") && !workRequest(item) && modelSpecification(key)),
    );
    const keys = [...new Set([
      ...item.fields.filter((f) => f.status === "conflict").map((f) => f.key),
      ...(!partnerIntake && !completeModel && cylinder ? cylinderDimensions : []),
      ...(partnerIntake ? [...profileKeys, ...extraKeys] : [...extraKeys, ...profileKeys]),
    ])];
    for (const key of keys) {
      const f = item.fields.find((f) => f.key === key);
      if (!fields[key] || (f && !["not_asked", "conflict"].includes(f.status)))
        continue;
      const id = `${item.id}:${key}`;
      if (s.deferredQuestions?.includes(id)) continue;
      return question(s, item, key);
    }
  }
  return null;
}

export function recordDialogueAnswer(
  before: Snapshot,
  after: Snapshot,
  q: Question | null,
  type: string,
  text = "",
) {
  if (!q) return;
  const item = after.brief.items.find((i) => i.id === q.itemId);
  const field = item?.fields.find((f) => f.key === q.fieldKey);
  const priorField = before.brief.items
    .find((i) => i.id === q.itemId)
    ?.fields.find((f) => f.key === q.fieldKey);
  const targetChanged = JSON.stringify(priorField) !== JSON.stringify(field);
  const settled = field && !["not_asked", "conflict"].includes(field.status);
  const changed =
    JSON.stringify(before.brief.items) !== JSON.stringify(after.brief.items);
  if (q.id === "input-recovery") {
    after.recoveryOffered = true;
    const old = new Set((before.unresolvedInputs ?? []).map((e) => e.id));
    const partial = after.unresolvedInputs?.some((e) => e.partialFor && !old.has(e.id));
    if (
      type === "text" &&
      !after.extractionFailed &&
      !partial &&
      changed &&
      !isTentative(text)
    ) {
      after.unresolvedInputs = (after.unresolvedInputs ?? []).filter(
        (e) => e.partialFor || !old.has(e.id),
      );
    }
    return;
  }
  if (q.id.startsWith("clarify:")) {
    after.questionAttempts = {
      ...after.questionAttempts,
      [q.id]: (before.questionAttempts?.[q.id] ?? 0) + 1,
    };
    if (type !== "text")
      after.deferredQuestions = [
        ...new Set([...(after.deferredQuestions ?? []), q.id]),
      ];
    if (
      type === "text" &&
      settled &&
      !after.extractionFailed &&
      targetChanged
    ) {
      const eventId = q.id.slice(8, q.id.lastIndexOf(":"));
      after.pendingChanges = (after.pendingChanges ?? []).filter(
        (p) => !(p.eventId === eventId && p.key === q.fieldKey),
      );
      if (!after.pendingChanges.some((p) => p.eventId === eventId))
        after.unresolvedInputs = (after.unresolvedInputs ?? []).filter(
          (e) => e.id !== eventId,
        );
    }
    return;
  }
  if (type !== "text" || settled || changed) return;
  const count = (before.questionAttempts?.[q.id] ?? 0) + 1;
  after.questionAttempts = { ...after.questionAttempts, [q.id]: count };
  if (count >= 2) {
    after.deferredQuestions = [
      ...new Set([...(after.deferredQuestions ?? []), q.id]),
    ];
    const event = after.inputs.at(-1);
    if (
      event &&
      !(after.unresolvedInputs ?? []).some((e) => e.id === event.id)
    ) {
      after.unresolvedInputs = [...(after.unresolvedInputs ?? []), event];
      after.pendingChanges = [
        ...(after.pendingChanges ?? []),
        { eventId: event.id, itemId: q.itemId!, key: q.fieldKey },
      ];
      after.deferredQuestions.push(`clarify:${event.id}:${q.fieldKey}`);
    }
  }
}

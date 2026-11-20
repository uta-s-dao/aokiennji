import type { Item, ItemResult, Snapshot } from "./model";
import { fields, present } from "./fields";

export function customerItemName(item: { label: string }): string {
  const name = item.label;
  if (/です|ます|したい|して|用意/.test(name)) {
    const noun = name.match(
      /交換部品|リング材|リング|断熱ブランケット|ブランケット|ガラス(?:製の?)?(?:容器|ボトル|瓶)?|パッキン|カバー|ネック|架台|部品/,
    );
    if (noun) return noun[0];
  }
  return name.length <= 24 ? name : "この品目";
}

// These sentences describe committed values, never a model's proposed changes.
// Callers return them only after the corresponding database commit succeeds.
export function savedReply(before: Snapshot, after: Snapshot): string {
  const latest = after.inputs.at(-1)?.text ?? "";
  if (
    !after.extractionFailed &&
    /材料|材質/.test(latest) &&
    /今|現在|伝わ|ここまで/.test(latest) &&
    /[？?]|ますか|でしょうか|教えて/.test(latest)
  ) {
    return after.brief.items
      .map((item) => {
        const material = item.fields.find(
          (f) => f.key === "material" && f.status === "known",
        );
        const supply = item.fields.find(
          (f) => f.key === "material_supply" && f.status === "known",
        );
        const pending = after.pendingChanges?.some(
          (p) =>
            p.itemId === item.id &&
            ["material", "material_supply"].includes(p.key),
        );
        const materialText = material
          ? present(material).slice(0, 32)
          : "材質は未確認";
        const supplyText = supply ? `、材料手配は${present(supply)}` : "";
        return `${after.brief.items.length > 1 ? customerItemName(item) + "：" : ""}${pending ? "変更前の条件は" : "伺っている条件は"}${materialText}${supplyText}です。${pending ? "材質変更・材料調達はまだ未確定です。変更を決めずに、両案を相談文に残せます。" : ""}`;
      })
      .join("\n");
  }
  // Recovery and overflow each have their own visible guidance. Do not repeat it
  // as a save notification; the original inputs remain in the snapshot.
  if (
    after.extractionFailed ||
    after.unresolvedInputs?.length ||
    after.overflow.length
  )
    return "";
  if (
    /写真|画像/.test(latest) &&
    /名前|名称|特定|絞|判別/.test(latest) &&
    /[？?]|ますか|でしょうか/.test(latest)
  )
    return "写真は添付できますが、この画面では写真から部品名を自動で特定できません。担当者に写真を見てもらう場合は、メールにも添付してください。";
  const sentences: string[] = [];
  const editing = after.inputs.at(-1)?.type === "field_edit";
  for (const item of after.brief.items) {
    const old = before.brief.items.find((i) => i.id === item.id);
    for (const f of item.fields) {
      const prev = old?.fields.find((v) => v.key === f.key);
      if (
        JSON.stringify([prev?.status, prev?.value]) ===
        JSON.stringify([f.status, f.value])
      )
        continue;
      const name = `${after.brief.items.length > 1 ? customerItemName(item) + "の" : ""}${fields[f.key]?.label ?? f.label}`;
      const value = fields[f.key]?.units ? present(f) : `「${present(f)}」`;
      if (f.status === "conflict")
        sentences.push(`${name}が食い違っています。内容をご確認ください。`);
      else if (f.status === "known" && (prev?.status === "known" || editing))
        sentences.push(
          value.length <= 48
            ? `${name}を${value}に変更しました。`
            : `${name}を変更しました。`,
        );
    }
  }
  const suffix = "変更した条件は「入力内容を確認・修正」で確認できます。";
  let reply = "";
  for (let n = 0; n < sentences.length; n++) {
    const tail = n < sentences.length - 1 ? suffix : "";
    if ((reply + sentences[n] + tail).length > 160)
      return reply ? reply + suffix : suffix;
    reply += sentences[n];
  }
  return reply;
}

export function customerCylinderQuestion(item: Item, hollow: boolean, retry: boolean): string {
  const name = customerItemName(item);
  if (hollow) {
    return retry
      ? `${name}の内径を確認できませんでした。分かれば「30mm」のように単位を付けて教えてください。`
      : customerQuestion(item, "inner_diameter");
  }
  return retry
    ? `${name}の中の形状を確認できませんでした。空洞の場合は「内径30mm」のように、無垢の場合は「無垢です」と教えてください。`
    : `${name}の中は空洞ですか、それとも無垢ですか？ 空洞なら、分かる範囲で内径も教えてください。`;
}

export function customerQuestion(item: Item, key: string): string {
  const name = customerItemName(item);
  const questions: Record<string, string> = {
    manufacturer: `${name}のメーカー名は分かりますか？`,
    model: `${name}の型番は分かりますか？`,
    purpose: `${name}は何に使いますか？`,
    description: "どのようなものをお探しですか？",
    request_scope: `${name}は購入・加工・製作のどれをご希望ですか？`,
    material_supply: `${name}の材料は、お客様が用意しますか？ 当社での調達をご希望ですか？`,
    work_scope: `${name}のどの部分を、どこまで製作・加工してほしいですか？`,
    mounting: `${name}はどのように取り付けますか？`,
    required_date: `${name}はいつまでに必要ですか？`,
    destination: `${name}のお届け先の地域を教えてください。`,
    quantity: `${name}は、いくつ必要ですか？ 単位も教えてください。`,
    coating: `${name}の塗装は必要ですか？ 不要なら「塗装なし」、必要なら色などを教えてください。`,
    material: `${name}の材質は分かりますか？`,
    normal_temperature: `${name}を使う温度は何℃ですか？`,
    overall_length: `${name}の全長は分かりますか？ mmなど単位も教えてください。`,
    outer_diameter: `${name}の外径は分かりますか？ mmなど単位も教えてください。`,
    thickness: `${name}の厚さは分かりますか？ mmなど単位も教えてください。`,
    inner_diameter: `${name}の内径は分かりますか？ mmなど単位も教えてください。`,
    width: `${name}の幅（横の長さ）は分かりますか？ mmなど単位も教えてください。`,
    height: `${name}の高さ（縦の長さ）は分かりますか？ mmなど単位も教えてください。`,
    depth: `${name}の奥行は分かりますか？ mmなど単位も教えてください。`,
    hole_diameter: `${name}に開ける穴の直径は何mmですか？`,
    hole_count: `${name}に穴は何か所必要ですか？`,
    hole_layout: `${name}の穴の位置を教えてください。分かる範囲で、穴の中心間の距離（ピッチ）や配置も教えてください。`,
    capacity: `${name}の容量は分かりますか？ mLやLなどの単位も教えてください。`,
    drawing_available: `${name}の図面はありますか？`,
    tolerance: `${name}の寸法公差や必要な精度の指定を教えてください。指定なしでも進められます。`,
    process: `${name}に、どのような加工が必要ですか？ 穴の大きさや数など、分かる範囲で教えてください。`,
    marking: `${name}に刻印や文字の表示はありますか？ 分かる範囲で教えてください。`,
  };
  return (
    questions[key] ?? `${name}の${fields[key]?.label ?? key}は分かりますか？`
  );
}

export function customerReason(
  item: Item,
  code: ItemResult["reasonCode"],
  missing: string[],
  pending: boolean,
): string {
  if (code === "RESEARCH_INCOMPLETE")
    return "調査を完了できなかったため、対応できるかはまだ判断していません。入力内容は残っています。";
  if (pending)
    return "追加のご相談をまだ条件として確定できていません。以前の条件で対応できるとは判断せず、最新の原文を担当者へ伝える形で相談できます。";
  if (code === "CONFLICTING_EVIDENCE")
    return "条件や確認資料に食い違いがあるため、対応可否を確定できませんでした。担当者が内容を確認します。";
  if (code === "EXPIRED_EVIDENCE")
    return "確認に使える資料の期限が切れているため、現在の取扱状況を担当者が確認する必要があります。";
  if (code === "APPROVED_SCOPE_MATCH")
    return "お伝えいただいた条件は、当社の取扱範囲に合っています。";
  const unknown = missing
    .map((k) => fields[k]?.label)
    .filter(Boolean)
    .slice(0, 3);
  const conditions = item.fields
    .filter(
      (f) =>
        f.hardConstraint &&
        f.status === "known" &&
        f.value &&
        ![
          "request_scope",
          "manufacturer",
          "model",
          "product_name",
          "description",
        ].includes(f.key),
    )
    .slice(0, 3)
    .map((f) =>
      present(f).length <= 32
        ? `${fields[f.key]?.label ?? f.label}（${present(f)}）`
        : (fields[f.key]?.label ?? f.label),
    );
  const supplied = conditions.length
    ? `${conditions.join("・")}への対応は、登録資料だけでは確認できませんでした。`
    : "このご依頼への対応は、当社の登録資料だけでは確認できませんでした。";
  const reason = unknown.length
    ? `${unknown.join("・")}がまだ分かっていません。${supplied}`
    : supplied;
  return reason.length <= 300
    ? reason
    : "ご希望の条件への対応は、当社の登録資料だけでは確認できませんでした。担当者が内容を確認する必要があります。";
}

export function customerNextStep(item: ItemResult): string {
  if (item.reasonCode === "RESEARCH_INCOMPLETE")
    return "再調査するか、このままメールで相談できます。";
  if (item.verdict === "can_handle")
    return "価格・在庫・納期は、メールでご相談ください。";
  if (item.verdict === "out_of_scope")
    return "条件を変えて再確認するか、メールで別の方法をご相談ください。";
  return item.missingFields.length
    ? "分かる条件を追記するか、このままメールで相談できます。"
    : "このままメールで担当者に相談できます。";
}

import {
  AppError,
  id,
  type Snapshot,
  type Change,
  type InputEvent,
  type CapabilityRule,
  type Source,
  type Attachment,
} from "../domain/model";
import {
  makeSnapshot,
  applyInput,
  chooseNextQuestion,
  makeResearchBrief,
  newItem,
  hasClue,
} from "../domain/intake";
import { fields } from "../domain/fields";
import { resolveCategories } from "../domain/category";
import { makeMailDraft } from "../domain/mail";
import { checkRule } from "../domain/decision";
import { extractDemo } from "../adapters/extraction";
import { configuredIntake } from "../adapters/intake-service";
import { intakeProvider } from "../adapters/openai-intake";
import {
  type Env,
  type CaseRow,
  type JobRow,
  stmt,
  owned,
  prior,
  commit,
  eventPayload,
  knowledge,
  rules,
  sources,
  currentResult,
  limit,
  audit,
} from "../adapters/store";
import { flushOutbox, expireJobs, maintenance } from "../research-worker";
import fixture from "../../fixtures/demo/knowledge.json";
import { validateIntakeResponse } from "../generated/validators.js";
export const json = (
  v: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(v), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
const hash = async (s: string) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)),
    ),
  )
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
export const local = (req: Request, e: Env) =>
  e.APP_MODE === "local-demo" &&
  ["127.0.0.1", "localhost", "[::1]"].includes(new URL(req.url).hostname);
async function session(req: Request) {
  const cookie = req.headers
    .get("Cookie")
    ?.match(/(?:^|;\s*)av2_session=([A-Za-z0-9-]{36})/)?.[1];
  if (!cookie) throw new AppError("NOT_OWNER", 401);
  return { owner: await hash(cookie), csrf: await hash("csrf:" + cookie) };
}
async function body(req: Request): Promise<Record<string, unknown>> {
  if (Number(req.headers.get("Content-Length") ?? 0) > 20000)
    throw new AppError("INVALID_INPUT", 413);
  const raw = await req.text();
  if (raw.length > 20000) throw new AppError("INVALID_INPUT", 413);
  try {
    const b = JSON.parse(raw);
    if (!b || typeof b !== "object" || Array.isArray(b)) throw 0;
    return b;
  } catch {
    throw new AppError("INVALID_INPUT");
  }
}
function text(v: unknown, max = 2000) {
  if (typeof v !== "string" || !v.trim() || v.length > max)
    throw new AppError("INVALID_INPUT");
  return v.trim();
}
function revision(b: Record<string, unknown>, c: CaseRow) {
  if (
    !Number.isInteger(b.expectedRevision) ||
    b.expectedRevision !== c.revision
  )
    throw new AppError("REVISION_CONFLICT", 409);
}
function snapshot(c: CaseRow) {
  return c.snapshot ? (JSON.parse(c.snapshot) as Snapshot) : makeSnapshot(c.id);
}
async function responseFor(e: Env, c: CaseRow, s: Snapshot, force = false) {
  const rs = await rules(e);
  s.brief.items = resolveCategories(s.brief.items, rs);
  const q = chooseNextQuestion(s, rs, force);
  const k = await knowledge(e);
  s.brief.knowledgeRevision = k;
  const can = hasClue(s) && !s.overflow.length;
  let job: JobRow | null = null;
  if (!q && can) {
    const jid = id();
    const b = makeResearchBrief(s, c.revision + 1, k);
    s.brief = b;
    const count = (await stmt(
      e,
      "SELECT COUNT(*) AS n FROM research_jobs WHERE case_id=?",
      c.id,
    ).first<{ n: number }>())!.n;
    if (count >= 10) throw new AppError("RATE_LIMITED", 429);
    job = {
      id: jid,
      case_id: c.id,
      input_revision: c.revision + 1,
      knowledge_revision: k,
      attempt: count + 1,
      status: "queued",
      stage: "登録情報を確認中",
      deadline: Date.now() + 60000,
      lease_token: null,
      lease_until: null,
      snapshot: JSON.stringify(b),
      usage: "{}",
    };
  }
  return {
    job,
    response: {
      kind: "intake_response",
      caseId: c.id,
      revision: c.revision + 1,
      action: job ? "research_started" : q ? "ask" : "contact_only",
      question: q,
      jobId: job?.id ?? null,
      canResearch: can,
      notice: s.overflow.length
        ? "4品目以上の入力を保持しました。未処理内容を別案件へ分割してください。"
        : s.extractionFailed
          ? "自由文の確認を完了できませんでした。入力を保持しています。再入力・修正またはメール相談できます。"
          : s.unresolvedInputs?.length
            ? "変更候補・確認待ちの相談を保持しています。内容を確定して入力するか、メールで相談できます。"
            : null,
    },
  };
}
export async function api(
  req: Request,
  e: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const u = new URL(req.url),
    path = u.pathname,
    method = req.method;
  if (!local(req, e)) throw new AppError("CONFIG_MISSING", 503); // This deliverable must not run as a public service.
  if (path === "/api/v2/session" && method === "GET") {
    const existing = req.headers
      .get("Cookie")
      ?.match(/(?:^|;\s*)av2_session=([A-Za-z0-9-]{36})/)?.[1];
    const token = existing ?? id();
    return json(
      {
        csrf: await hash("csrf:" + token),
        mode: "local-demo",
        extraction: intakeProvider(e),
        externalEnabled:
          intakeProvider(e) === "openai" && e.EXTERNAL_ENABLED === "true",
      },
      200,
      {
        "Set-Cookie": `av2_session=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000`,
      },
    );
  }
  const ss = await session(req);
  if (!["GET", "HEAD"].includes(method)) {
    if (
      req.headers.get("Origin") !== u.origin ||
      req.headers.get("X-CSRF-Token") !== ss.csrf
    )
      throw new AppError("NOT_OWNER", 403);
    await limit(e, "session:" + ss.owner);
    await limit(e, "global", 1000);
  }
  if (path.startsWith("/api/v2/admin/")) return admin(req, e, ss.owner);
  if (path === "/api/v2/cases" && method === "POST") {
    const key = text(req.headers.get("Idempotency-Key"), 128);
    const existing = await stmt(
      e,
      "SELECT id FROM cases WHERE owner=? AND create_key=? AND deleted=0",
      ss.owner,
      key,
    ).first<{ id: string }>();
    if (existing) return json({ caseId: existing.id, revision: 0 });
    const caseId = id();
    try {
      await stmt(
        e,
        "INSERT INTO cases(id,owner,create_key,created_at,expires_at) VALUES(?,?,?,?,?)",
        caseId,
        ss.owner,
        key,
        Date.now(),
        Date.now() + 30 * 86400000,
      ).run();
    } catch (err) {
      const r = await stmt(
        e,
        "SELECT id FROM cases WHERE owner=? AND create_key=?",
        ss.owner,
        key,
      ).first<{ id: string }>();
      if (r) return json({ caseId: r.id, revision: 0 });
      throw err;
    }
    return json({ caseId, revision: 0 }, 201);
  }
  const match = path.match(/^\/api\/v2\/cases\/([^/]+)(?:\/(.*))?$/);
  if (!match) throw new AppError("NOT_FOUND", 404);
  const c = await owned(e, match[1], ss.owner),
    route = match[2] ?? "";
  if (route === "" && method === "GET") {
    await expireJobs(e);
    ctx.waitUntil(flushOutbox(e));
    const s = snapshot(c);
    const attachments = (
      await stmt(
        e,
        "SELECT id,name,mime,byte_size,analysis,supersedes FROM attachments WHERE case_id=?",
        c.id,
      ).all()
    ).results;
    const j = await stmt(
      e,
      "SELECT id,status,stage,deadline FROM research_jobs WHERE case_id=? AND input_revision=? ORDER BY attempt DESC LIMIT 1",
      c.id,
      c.revision,
    ).first();
    return json({
      caseId: c.id,
      revision: c.revision,
      phase: c.phase,
      items: s.brief.items,
      overflow: s.overflow,
      question:
        c.phase === "collecting" ? chooseNextQuestion(s, await rules(e)) : null,
      canResearch: hasClue(s) && !s.overflow.length,
      attachments,
      job: j,
      result: await currentResult(e, c),
      questionsAsked: s.brief.questionsAsked,
      unresolvedInputs: (s.unresolvedInputs ?? []).map((e) => e.text),
    });
  }
  if (route === "" && method === "DELETE") {
    await stmt(
      e,
      "UPDATE cases SET deleted=1,snapshot=NULL WHERE id=?",
      c.id,
    ).run();
    await stmt(
      e,
      "UPDATE research_jobs SET status='superseded' WHERE case_id=?",
      c.id,
    ).run();
    ctx.waitUntil(maintenance(e));
    return json({ deleted: true });
  }
  if (
    ["answers", "fields", "research", "split"].includes(route) &&
    ["POST", "PATCH"].includes(method)
  ) {
    const b = await body(req),
      mutationId = text(b.mutationId, 128);
    const old = await prior(e, c.id, mutationId);
    if (old) return json(old);
    revision(b, c);
    let s = snapshot(c);
    if (route === "answers") {
      const q = chooseNextQuestion(s, await rules(e));
      if (c.phase !== "collecting")
        throw new AppError("REVISION_CONFLICT", 409);
      if (q && b.questionId !== q.id) throw new AppError("INVALID_INPUT");
      const answer = b.answer as {
        type: string;
        text?: string;
        optionId?: string;
      };
      if (
        !answer ||
        !["text", "option", "unknown", "skip"].includes(answer.type)
      )
        throw new AppError("INVALID_INPUT");
      if (answer.type === "text") {
        s = await configuredIntake(e, c, mutationId, s, text(answer.text), q);
        if (s.extractionFailed)
          await audit(e, c.id, "EXTRACTION_FALLBACK", {
            code: s.extractionError ?? "UNKNOWN",
          });
      } else {
        if (!q?.itemId) throw new AppError("INVALID_INPUT");
        const value =
          answer.type === "option"
            ? q.options.find((o) => o.id === answer.optionId)
            : null;
        if (answer.type === "option" && !value)
          throw new AppError("INVALID_INPUT");
        const event: InputEvent = {
          id: id(),
          text:
            value?.label ??
            (answer.type === "unknown" ? "分からない" : "スキップ"),
          type: "selection",
        };
        if (q.id === "input-recovery") {
          s.inputs.push(event);
          s.recoveryOffered = true;
        } else
          s = applyInput(s, event, [
            {
              itemId: q.itemId,
              key: q.fieldKey,
              text: value?.id,
              quote: event.text,
              status:
                answer.type === "unknown"
                  ? "unknown"
                  : answer.type === "skip"
                    ? "skipped"
                    : "known",
            },
          ]);
      }
      if (q?.id === "input-recovery") s.recoveryOffered = true;
      if (c.revision > 0) {
        s.brief.questionsAsked = Math.min(6, s.brief.questionsAsked + 1);
        s.fallbackCount++;
      }
    } else if (route === "fields") {
      const change = b.change as Change;
      if (!change || !fields[change.key]) throw new AppError("INVALID_INPUT");
      const value = text(b.text, 2000);
      s = applyInput(s, { id: id(), text: value, type: "field_edit" }, [
        { ...change, quote: value },
      ]);
    } else if (route === "split") {
      const index = b.index;
      if (
        !Number.isInteger(index) ||
        typeof index !== "number" ||
        !s.overflow[index]
      )
        throw new AppError("INVALID_INPUT");
      const segments = s.overflow[index]
        .split(/\n+|、(?=(?:ガラス|パッキン|カバー|ネック))/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (segments.length < 1) throw new AppError("INVALID_INPUT");
      const content = segments.slice(0, 3).join("\n"),
        remaining = segments.slice(3).join("\n"),
        caseId = id();
      const child = extractDemo(makeSnapshot(caseId), content);
      if (child.overflow.length) throw new AppError("INVALID_INPUT");
      if (remaining) s.overflow[index] = remaining;
      else s.overflow.splice(index, 1);
      s.brief.revision = c.revision + 1;
      const response = {
          caseId,
          content,
          revision: 1,
          remaining,
          notice:
            "先頭の3品目までを新しい相談へ分割しました。残りの入力は元の相談に保持しています。",
        },
        g = id();
      try {
        await e.DB.batch([
          stmt(
            e,
            "INSERT INTO write_guards VALUES (?,EXISTS(SELECT 1 FROM cases WHERE id=? AND revision=? AND deleted=0 AND expires_at>?))",
            g,
            c.id,
            c.revision,
            Date.now(),
          ),
          stmt(
            e,
            "INSERT INTO cases(id,owner,create_key,created_at,expires_at,snapshot,revision) VALUES(?,?,?,?,?,?,1)",
            caseId,
            ss.owner,
            "split:" + mutationId,
            Date.now(),
            Date.now() + 30 * 86400000,
            JSON.stringify(child),
          ),
          stmt(
            e,
            "UPDATE cases SET snapshot=?,revision=revision+1 WHERE id=?",
            JSON.stringify(s),
            c.id,
          ),
          stmt(
            e,
            "INSERT INTO case_events(id,case_id,mutation_id,revision,response,created_at,event_json) VALUES(?,?,?,?,?,?,?)",
            id(),
            c.id,
            mutationId,
            c.revision + 1,
            JSON.stringify(response),
            Date.now(),
            JSON.stringify(eventPayload(c, s)),
          ),
          stmt(e, "DELETE FROM write_guards WHERE id=?", g),
        ]);
      } catch (err) {
        const previous = await prior(e, c.id, mutationId);
        if (previous) return json(previous);
        if (String(err).includes("CHECK"))
          throw new AppError("REVISION_CONFLICT", 409);
        throw err;
      }
      return json(response);
    }
    const calculated =
      route === "fields"
        ? {
            job: null,
            response: {
              kind: "field_update",
              caseId: c.id,
              revision: c.revision + 1,
              canResearch: hasClue(s) && !s.overflow.length,
              notice:
                "変更を保存しました。「この内容で調べる」で再調査できます。",
            },
          }
        : await responseFor(e, c, s, route === "research");
    if (route !== "fields" && !validateIntakeResponse(calculated.response))
      throw new AppError("INVALID_RESULT", 500);
    const result = await commit(
      e,
      c,
      mutationId,
      s,
      calculated.response,
      calculated.job,
    );
    if (calculated.job) ctx.waitUntil(flushOutbox(e));
    return json(result);
  }
  if (route === "result" && method === "GET") {
    const r = await currentResult(e, c);
    return json({ result: r });
  }
  if (route.startsWith("jobs/") && method === "GET") {
    await expireJobs(e);
    const j = await stmt(
      e,
      "SELECT id,status,stage,deadline FROM research_jobs WHERE id=? AND case_id=?",
      route.slice(5),
      c.id,
    ).first();
    if (!j) throw new AppError("NOT_FOUND", 404);
    return json(j);
  }
  if (route === "mail-draft" && method === "POST") {
    return json(
      makeMailDraft(snapshot(c), await currentResult(e, c), e.CONTACT_EMAIL),
    );
  }
  if (route === "events" && method === "POST") {
    const b = await body(req);
    if (!["mail_opened", "draft_copied"].includes(String(b.code)))
      throw new AppError("INVALID_INPUT");
    await audit(e, c.id, String(b.code));
    return json({ ok: true });
  }
  if (route === "attachments" && method === "POST") return upload(req, e, c);
  if (route.startsWith("attachments/") && method === "GET") {
    const a = await stmt(
      e,
      "SELECT * FROM attachments WHERE id=? AND case_id=? AND expires_at>?",
      route.slice(12),
      c.id,
      Date.now(),
    ).first<Attachment>();
    if (!a) throw new AppError("NOT_FOUND", 404);
    const file = await e.FILES.get(a.object_key);
    if (!file) throw new AppError("NOT_FOUND", 404);
    return new Response(file.body, {
      headers: {
        "Content-Type": a.mime,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; sandbox",
      },
    });
  }
  throw new AppError("NOT_FOUND", 404);
}
async function upload(req: Request, e: Env, c: CaseRow) {
  if (Number(req.headers.get("Content-Length") ?? 0) > 10 * 1024 * 1024 + 20000)
    throw new AppError("INVALID_INPUT", 413);
  const form = await req.formData(),
    file = form.get("file");
  if (!file || typeof file === "string") throw new AppError("INVALID_INPUT");
  const mutationId = text(form.get("mutationId"), 128);
  const prev = await prior(e, c.id, mutationId);
  if (prev) return json(prev);
  if (Number(form.get("expectedRevision")) !== c.revision)
    throw new AppError("REVISION_CONFLICT", 409);
  if (file.size > 10 * 1024 * 1024 || file.size === 0)
    throw new AppError("INVALID_INPUT", 413);
  const data = await file.arrayBuffer(),
    bytes = new Uint8Array(data),
    ascii = new TextDecoder("latin1").decode(bytes.slice(0, 16));
  const mime =
    bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      ? "image/jpeg"
      : bytes[0] === 137 && ascii.slice(1, 4) === "PNG"
        ? "image/png"
        : ascii.startsWith("RIFF") && ascii.slice(8, 12) === "WEBP"
          ? "image/webp"
          : ascii.startsWith("%PDF-")
            ? "application/pdf"
            : null;
  if (!mime || mime !== file.type) throw new AppError("INVALID_INPUT");
  const all = (
    await stmt(
      e,
      "SELECT * FROM attachments WHERE case_id=?",
      c.id,
    ).all<Attachment>()
  ).results;
  const supersedes =
    typeof form.get("supersedes") === "string"
      ? String(form.get("supersedes"))
      : null;
  if (supersedes && !all.some((a) => a.id === supersedes))
    throw new AppError("INVALID_INPUT");
  const active = all.filter((a) => !all.some((b) => b.supersedes === a.id));
  if (active.length >= 3 && !supersedes) throw new AppError("INVALID_INPUT");
  const attachmentId = id(),
    key = `${c.id}/${attachmentId}`;
  let s = snapshot(c);
  if (!s.brief.items.length) s.brief.items.push(newItem("添付の対象"));
  const itemId =
    typeof form.get("itemId") === "string"
      ? String(form.get("itemId"))
      : supersedes
        ? (s.brief.attachmentRefs.find((a) => a.attachmentId === supersedes)
            ?.itemId ?? null)
        : s.brief.items.length === 1
          ? s.brief.items[0].id
          : null;
  if (itemId !== null && !s.brief.items.some((i) => i.id === itemId))
    throw new AppError("INVALID_INPUT");
  s.brief.attachmentRefs = s.brief.attachmentRefs.filter(
    (a) => a.attachmentId !== supersedes,
  );
  s.brief.attachmentRefs.push({ attachmentId, itemId });
  s.attachmentNames = s.attachmentNames.filter(
    (n) => n !== all.find((a) => a.id === supersedes)?.name,
  );
  s.attachmentNames.push(file.name.slice(0, 200));
  if (supersedes && itemId) {
    const item = s.brief.items.find((i) => i.id === itemId)!;
    item.fields = item.fields.filter((f) => f.key !== "drawing_revision");
    s = applyDrawing(s, itemId, file.name);
  }
  await e.FILES.put(key, data, { httpMetadata: { contentType: mime } });
  const g = id(),
    response = {
      attachmentId,
      revision: c.revision + 1,
      analysis: "not_analyzed",
      notice: "ファイルを受領しました。内容解析は未実施です。",
    };
  try {
    await e.DB.batch([
      stmt(
        e,
        "INSERT INTO write_guards VALUES (?,EXISTS(SELECT 1 FROM cases WHERE id=? AND revision=? AND deleted=0 AND expires_at>?))",
        g,
        c.id,
        c.revision,
        Date.now(),
      ),
      stmt(
        e,
        "INSERT INTO attachments VALUES(?,?,?,?,?,?,?,?,?,?)",
        attachmentId,
        c.id,
        mutationId,
        key,
        file.name.slice(0, 200),
        mime,
        file.size,
        "not_analyzed",
        supersedes,
        c.expires_at,
      ),
      stmt(
        e,
        "UPDATE cases SET revision=revision+1,phase='collecting',snapshot=? WHERE id=?",
        JSON.stringify({
          ...s,
          brief: { ...s.brief, revision: c.revision + 1 },
        }),
        c.id,
      ),
      stmt(
        e,
        "UPDATE research_jobs SET status='superseded' WHERE case_id=? AND status IN ('queued','running')",
        c.id,
      ),
      stmt(
        e,
        "INSERT INTO case_events(id,case_id,mutation_id,revision,response,created_at,event_json) VALUES(?,?,?,?,?,?,?)",
        id(),
        c.id,
        mutationId,
        c.revision + 1,
        JSON.stringify(response),
        Date.now(),
        JSON.stringify(eventPayload(c, s)),
      ),
      stmt(e, "DELETE FROM write_guards WHERE id=?", g),
    ]);
  } catch (err) {
    await e.FILES.delete(key);
    const p = await prior(e, c.id, mutationId);
    if (p) return json(p);
    if (String(err).includes("CHECK"))
      throw new AppError("REVISION_CONFLICT", 409);
    throw err;
  }
  return json(response);
}
function applyDrawing(s: Snapshot, itemId: string, name: string) {
  return applyInput(
    s,
    { id: id(), text: `こちらが最新：${name}`, type: "field_edit" },
    [
      {
        itemId,
        key: "drawing_revision",
        text: `こちらが最新：${name}`.slice(0, 300),
        quote: `こちらが最新：${name}`,
      },
    ],
  );
}
async function admin(req: Request, e: Env, owner: string) {
  if (
    req.headers.get("X-Local-Admin-Token") !== e.LOCAL_ADMIN_TOKEN ||
    !e.LOCAL_ADMIN_TOKEN
  )
    throw new AppError("NOT_OWNER", 403);
  const p = new URL(req.url).pathname,
    method = req.method;
  if (p.endsWith("/intake-status") && method === "GET")
    return json({
      provider: intakeProvider(e),
      calls: await stmt(
        e,
        "SELECT calls AS count FROM intake_totals WHERE id=1",
      ).first(),
      control: await stmt(
        e,
        "SELECT blocked_reason FROM intake_controls WHERE id=1",
      ).first(),
    });
  if (p.endsWith("/intake-resume") && method === "POST") {
    await stmt(
      e,
      "UPDATE intake_controls SET blocked_reason=NULL WHERE id=1",
    ).run();
    await audit(e, null, "INTAKE_RESUMED");
    return json({ ok: true });
  }
  const caseMatch = p.match(/^\/api\/v2\/admin\/cases\/([^/]+)$/);
  if (caseMatch && method === "GET") {
    const row = await stmt(
      e,
      "SELECT * FROM cases WHERE id=? AND deleted=0 AND expires_at>?",
      caseMatch[1],
      Date.now(),
    ).first<CaseRow>();
    if (!row) throw new AppError("NOT_FOUND", 404);
    return json({
      caseId: row.id,
      revision: row.revision,
      phase: row.phase,
      items: snapshot(row).brief.items,
      result: await currentResult(e, row),
      attachments: (
        await stmt(
          e,
          "SELECT id,name,analysis FROM attachments WHERE case_id=?",
          row.id,
        ).all()
      ).results,
    });
  }
  if (p.endsWith("/state") && method === "GET")
    return json({
      rules: await rules(e),
      sources: await sources(e),
      knowledgeRevision: await knowledge(e),
      cases: (
        await stmt(
          e,
          "SELECT id,phase,revision,created_at FROM cases WHERE deleted=0 ORDER BY created_at DESC LIMIT 100",
        ).all()
      ).results,
      failures: (
        await stmt(
          e,
          "SELECT code,COUNT(*) AS count FROM audit_events GROUP BY code",
        ).all()
      ).results,
    });
  if (p.endsWith("/demo") && method === "POST") {
    const rs = fixture.rules as CapabilityRule[],
      ss = fixture.sources as Source[];
    for (const r of rs)
      checkRule(
        r,
        ss.find((s) => s.id === r.sourceId),
      );
    await e.DB.batch([
      ...ss.map((s) =>
        stmt(
          e,
          "INSERT OR REPLACE INTO sources VALUES(?,?,?,?,?,?,?,?)",
          s.id,
          s.version,
          s.label,
          s.public_allowed,
          s.ai_allowed,
          s.role,
          s.confirmation_stage,
          s.is_demo,
        ),
      ),
      ...rs.map((r) =>
        stmt(
          e,
          "INSERT OR REPLACE INTO capability_rules VALUES(?,?,?)",
          r.id,
          JSON.stringify(r),
          r.sourceId,
        ),
      ),
      stmt(e, "UPDATE knowledge SET revision=revision+1 WHERE id=1"),
    ]);
    await audit(e, null, "DEMO_IMPORTED");
    return json({ ok: true });
  }
  if (p.endsWith("/rules") && method === "POST") {
    const b = await body(req);
    const r = b.rule as CapabilityRule;
    checkRule(
      r,
      (await sources(e)).find((s) => s.id === r.sourceId),
    );
    if (b.preview === true) return json({ valid: true, rule: r });
    const existing = await stmt(
      e,
      "SELECT json FROM capability_rules WHERE id=?",
      r.id,
    ).first<{ json: string }>();
    if (existing && r.version <= JSON.parse(existing.json).version)
      throw new AppError("REVISION_CONFLICT", 409);
    const g = id();
    await e.DB.batch([
      stmt(
        e,
        "INSERT INTO write_guards VALUES (?,(SELECT revision=? FROM knowledge WHERE id=1))",
        g,
        b.expectedKnowledgeRevision,
      ),
      stmt(
        e,
        "INSERT INTO capability_rules VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json,source_id=excluded.source_id",
        r.id,
        JSON.stringify(r),
        r.sourceId,
      ),
      stmt(e, "UPDATE knowledge SET revision=revision+1 WHERE id=1"),
      stmt(e, "DELETE FROM write_guards WHERE id=?", g),
    ]);
    await audit(e, null, "RULE_UPDATED", {
      ruleId: r.id,
      actor: owner.slice(0, 8),
    });
    return json({ ok: true });
  }
  if (p.endsWith("/sources") && method === "POST") {
    const b = await body(req),
      s = b.source as Source;
    if (
      !s ||
      !s.id ||
      !s.label ||
      !Number.isInteger(s.version) ||
      !["seller", "buyer", "inquirer"].includes(s.role) ||
      !["current_policy", "inquiry", "quotation", "historic"].includes(
        s.confirmation_stage,
      ) ||
      ![0, 1].includes(s.ai_allowed) ||
      ![0, 1].includes(s.public_allowed) ||
      ![0, 1].includes(s.is_demo)
    )
      throw new AppError("INVALID_INPUT");
    await e.DB.batch([
      stmt(
        e,
        "INSERT INTO sources VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,label=excluded.label,public_allowed=excluded.public_allowed,ai_allowed=excluded.ai_allowed,role=excluded.role,confirmation_stage=excluded.confirmation_stage,is_demo=excluded.is_demo",
        s.id,
        s.version,
        s.label,
        s.public_allowed,
        s.ai_allowed,
        s.role,
        s.confirmation_stage,
        s.is_demo,
      ),
      stmt(e, "UPDATE knowledge SET revision=revision+1 WHERE id=1"),
    ]);
    return json({ ok: true });
  }
  if (p.endsWith("/maintenance") && method === "POST") {
    await maintenance(e);
    return json({ ok: true });
  }
  throw new AppError("NOT_FOUND", 404);
}

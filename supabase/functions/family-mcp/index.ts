// 家族MCP サーバー（family-mcp）
// 粧子さん専用の Muse「もち」から、Taskra / Tavera / Flowra を「本人のアカウントとしてだけ」
// 操作させるための remote MCP server。雛形は supabase/functions/mcp-server（Taskra MCP）。
//
// ■ 権限の線（変更するときは HANDOVER.md「家族MCP」節を必ず読むこと）
//   - 操作できる利用者は FAMILY_MCP_USER_EMAIL の1人に固定。ツール引数で利用者・チーム・世帯を
//     指定させる口は作らない（引数に user_id 等が来ても読まない）。
//   - Taskra：その利用者の user_id の行だけ。他人のタスク等は共有の形でも触らない。
//   - Tavera：下の TAVERA_HOUSEHOLD_ID の世帯だけ。実行時に利用者がその世帯のメンバーか確認する。
//   - Flowra：下の FLOWRA_TEAM_ID のチームだけ。実行時に利用者がそのチームのメンバーか確認する。
//     サービスロールは RLS を素通りするため、Flowra の「非公開口座は作成者だけに見える」RLS を
//     このファイル内で再現している（flowraCtx / txVisible）。
//   - 削除ツールは持たせない。
//
// ■ 認証：既存 mcp-server と同じ共有シークレット方式（FAMILY_MCP_SECRET_TOKEN。Taskra MCP とは別の値）。
//   URL末尾 / ?token= / Authorization: Bearer のいずれかで照合し、不一致は 401。

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SB_SERVICE_ROLE_KEY')!;
const MCP_SECRET_TOKEN     = Deno.env.get('FAMILY_MCP_SECRET_TOKEN') || '';
const MCP_USER_EMAIL       = Deno.env.get('FAMILY_MCP_USER_EMAIL') || '';

// Flowra は別プロジェクト。URL は公開情報なので定数、キーは Taskra 側の Edge Function シークレットにだけ置く
const FLOWRA_URL         = Deno.env.get('FLOWRA_URL') || 'https://copyzpsyagscqrvkrwjo.supabase.co';
const FLOWRA_SERVICE_KEY = Deno.env.get('FLOWRA_SERVICE_ROLE_KEY') || '';

// 対象の世帯・チームはサーバー側で固定（2026-11-16 実DBで特定）
// Tavera 本番世帯（メンバー2人の世帯。2026-05-31 作成の重複テスト世帯「わが家」とは別物）
const TAVERA_HOUSEHOLD_ID = 'f826f072-2773-4080-9493-733279c1b969';
// Flowra「我が家」チーム
const FLOWRA_TEAM_ID = 'f0a6e677-b798-4978-949a-42995a98ceb6';

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const fl = FLOWRA_SERVICE_KEY ? createClient(FLOWRA_URL, FLOWRA_SERVICE_KEY, { auth: { persistSession: false } }) : null;

const corsHeaders = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Headers': 'authorization, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function genId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}
function now(): string { return new Date().toISOString(); }
// JST基準の日付（YYYY-MM-DD）。plusDays日後の日付を返す
function jstDate(plusDays = 0): string {
  const d = new Date(Date.now() + 9 * 3600 * 1000 + plusDays * 86400 * 1000);
  return d.toISOString().slice(0, 10);
}
function isDateStr(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

// ── 利用者ID解決（メール→Auth UID。プロジェクトごとに別IDなので別々に解決） ─────
async function findUserIdByEmail(client: any, email: string): Promise<string | null> {
  if (!email) return null;
  let page = 1;
  for (;;) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data) break;
    const found = data.users.find((u: any) => (u.email || '').toLowerCase() === email.toLowerCase());
    if (found) return found.id;
    if (data.users.length < 200) break;
    page++;
  }
  return null;
}

let _taskraUserId: string | null = null;
async function getUserId(): Promise<string | null> {
  if (!_taskraUserId) _taskraUserId = await findUserIdByEmail(sb, MCP_USER_EMAIL);
  return _taskraUserId;
}

let _flowraUserId: string | null = null;
async function getFlowraUserId(): Promise<string | null> {
  if (!fl) return null;
  if (!_flowraUserId) _flowraUserId = await findUserIdByEmail(fl, MCP_USER_EMAIL);
  return _flowraUserId;
}

// ════════════════════════════════════════════════════════════════════
//  Taskra 部（雛形 mcp-server のツールをそのまま流用。delete_task のみ除外）
//  すべて user_id = 利用者 で絞る。
// ════════════════════════════════════════════════════════════════════

// ── タグ名→ID解決（未登録なら自動作成） ──────────────────────────────
async function resolveTagIds(userId: string, tagNames?: string[]): Promise<string[]> {
  if (!tagNames || !tagNames.length) return [];
  const { data: existing } = await sb.from('tags').select('id,name').eq('user_id', userId);
  const list = existing ? [...existing] : [];
  const ids: string[] = [];
  for (const name of tagNames) {
    if (!name) continue;
    let tag = list.find((t: any) => t.name === name);
    if (!tag) {
      const row = { id: genId(), user_id: userId, name, color: '#7c3aed', status: 'active' };
      const { error } = await sb.from('tags').insert(row);
      if (!error) { tag = row; list.push(row); }
    }
    if (tag && !ids.includes(tag.id)) ids.push(tag.id);
  }
  return ids;
}

async function resolveProjectId(userId: string, projectName?: string): Promise<string | null> {
  if (!projectName) return null;
  const { data } = await sb.from('projects').select('id').eq('user_id', userId).eq('name', projectName).maybeSingle();
  return data ? data.id : null;
}

// ── ツール実装 ────────────────────────────────────────────────────
async function listTasks(userId: string, a: any) {
  const status = a.status || 'all_open';
  let q = sb.from('tasks').select('*').eq('user_id', userId);
  q = status === 'all_open' ? q.in('status', ['active', 'inbox']) : q.eq('status', status);
  if (a.due_before) q = q.lte('due_at', a.due_before);
  if (a.due_after) q = q.gte('due_at', a.due_after);
  if (a.completed_after) q = q.gte('completed_at', a.completed_after);
  if (a.keyword) q = q.ilike('title', `%${a.keyword}%`);
  q = q.order('sort_order', { ascending: true }).limit(Math.min(a.limit || 30, 100));
  const { data, error } = await q;
  if (error) throw error;
  let tasks = data || [];

  const [{ data: projects }, { data: tags }] = await Promise.all([
    sb.from('projects').select('id,name').eq('user_id', userId),
    sb.from('tags').select('id,name').eq('user_id', userId),
  ]);
  const projMap = new Map((projects || []).map((p: any) => [p.id, p.name]));
  const tagMap = new Map((tags || []).map((t: any) => [t.id, t.name]));

  if (a.project_name) {
    const pid = (projects || []).find((p: any) => p.name === a.project_name)?.id;
    tasks = tasks.filter((t: any) => t.project_id === pid);
  }
  if (a.tag_name) {
    const tid = (tags || []).find((t: any) => t.name === a.tag_name)?.id;
    tasks = tasks.filter((t: any) => (t.tag_ids || []).includes(tid));
  }

  return tasks.map((t: any) => ({
    id: t.id, title: t.title, status: t.status,
    dueAt: t.due_at, startAt: t.start_at, priority: t.priority, flagged: t.flagged,
    notes: t.notes || null, completedAt: t.completed_at, repeatRule: t.repeat_rule,
    project: projMap.get(t.project_id) || null,
    tags: (t.tag_ids || []).map((id: string) => tagMap.get(id)).filter(Boolean),
  }));
}

async function addTask(userId: string, a: any) {
  if (!a.title) return { error: 'titleが必要です' };
  const projectId = await resolveProjectId(userId, a.project_name);
  const tagIds = await resolveTagIds(userId, a.tag_names);
  const row = {
    id: genId(), user_id: userId, title: a.title,
    status: projectId ? 'active' : 'inbox',
    start_at: jstDate(0), due_at: a.due_at || null,
    priority: a.priority || 4, flagged: !!a.flagged,
    project_id: projectId, tag_ids: tagIds, notes: a.notes || '',
    created_at: now(), updated_at: now(), completed_at: null,
    sort_order: Date.now(),
  };
  const { error } = await sb.from('tasks').insert(row);
  if (error) throw error;
  return { added: { id: row.id, title: row.title } };
}

async function findUpdateTargets(userId: string, a: any) {
  if (a.task_id) {
    const { data } = await sb.from('tasks').select('*').eq('user_id', userId).eq('id', a.task_id).maybeSingle();
    return data ? [data] : [];
  }
  if (a.keyword) {
    const reactivating = a.status !== undefined && a.status !== 'completed';
    let q = sb.from('tasks').select('*').eq('user_id', userId).ilike('title', `%${a.keyword}%`);
    q = reactivating ? q.eq('status', 'completed') : q.neq('status', 'completed');
    const { data } = await q.limit(10);
    return data || [];
  }
  return [];
}

async function updateTask(userId: string, a: any) {
  const targets = await findUpdateTargets(userId, a);
  if (!targets.length) return { error: '対象のタスクが見つかりません' };

  const results = [];
  for (const t of targets) {
    const patch: Record<string, unknown> = { updated_at: now() };
    if (a.new_title) patch.title = a.new_title;
    if (a.due_at !== undefined) patch.due_at = a.due_at;
    if (a.start_at !== undefined) patch.start_at = a.start_at;
    if (a.priority !== undefined) patch.priority = a.priority;
    if (a.flagged !== undefined) patch.flagged = a.flagged;
    if (a.repeat_rule !== undefined) patch.repeat_rule = a.repeat_rule || null;
    if (a.start_time && t.start_at) patch.start_at = String(t.start_at).slice(0, 10) + 'T' + a.start_time + ':00';
    if (a.due_time && t.due_at) patch.due_at = String(t.due_at).slice(0, 10) + 'T' + a.due_time + ':00';
    if (a.append_note) patch.notes = (t.notes ? t.notes + '\n' : '') + a.append_note;

    let newProjectId: string | null | undefined;
    if (a.project_name !== undefined) {
      newProjectId = await resolveProjectId(userId, a.project_name);
      patch.project_id = newProjectId;
      if (newProjectId && t.status === 'inbox') patch.status = 'active';
    }
    if (a.tag_names !== undefined) {
      const newIds = await resolveTagIds(userId, a.tag_names);
      patch.tag_ids = a.append_tags ? [...new Set([...(t.tag_ids || []), ...newIds])] : newIds;
    }
    if (a.status !== undefined) {
      if (a.status === 'completed') {
        patch.status = 'completed'; patch.completed_at = now();
      } else if (a.status === 'archived') {
        patch.status = 'archived';
      } else {
        const effectiveProjectId = newProjectId !== undefined ? newProjectId : t.project_id;
        patch.status = a.status === 'inbox' ? 'inbox' : (effectiveProjectId ? 'active' : 'inbox');
        patch.completed_at = null;
      }
    }
    const { error } = await sb.from('tasks').update(patch).eq('id', t.id);
    if (!error) results.push({ id: t.id, title: (patch.title as string) || t.title });
  }
  return { updated: results };
}

async function listProjects(userId: string) {
  const { data, error } = await sb.from('projects').select('name,color,status').eq('user_id', userId).neq('status', 'archived');
  if (error) throw error;
  return data || [];
}

async function addProject(userId: string, a: any) {
  if (!a.name) return { error: 'nameが必要です' };
  const row = { id: genId(), user_id: userId, name: a.name, type: 'list', color: a.color || '#3b82f6', status: 'active', created_at: now(), updated_at: now() };
  const { error } = await sb.from('projects').insert(row);
  if (error) throw error;
  return { added: row.name };
}

async function listTags(userId: string) {
  const { data, error } = await sb.from('tags').select('name,color').eq('user_id', userId);
  if (error) throw error;
  return data || [];
}

async function addTag(userId: string, a: any) {
  if (!a.name) return { error: 'nameが必要です' };
  const { data: exists } = await sb.from('tags').select('id').eq('user_id', userId).eq('name', a.name).maybeSingle();
  if (exists) return { error: '同名タグが既に存在します' };
  const row = { id: genId(), user_id: userId, name: a.name, color: a.color || '#7c3aed', status: 'active' };
  const { error } = await sb.from('tags').insert(row);
  if (error) throw error;
  return { added: '#' + row.name };
}

async function addNote(userId: string, a: any) {
  if (!a.title) return { error: 'titleが必要です' };
  const tagIds = await resolveTagIds(userId, a.tag_names);
  const row = { id: genId(), user_id: userId, title: a.title, body: a.body || '', tag_ids: tagIds, created_at: now(), updated_at: now() };
  const { error } = await sb.from('notes').insert(row);
  if (error) throw error;
  return { added: row.title };
}

async function addSubtask(userId: string, a: any) {
  if (!a.title) return { error: 'titleが必要です' };
  let parent: any = null;
  if (a.parent_task_id) {
    const { data } = await sb.from('tasks').select('*').eq('user_id', userId).eq('id', a.parent_task_id).maybeSingle();
    parent = data;
  } else if (a.parent_keyword) {
    const { data } = await sb.from('tasks').select('*').eq('user_id', userId).neq('status', 'completed').ilike('title', `%${a.parent_keyword}%`).limit(1).maybeSingle();
    parent = data;
  }
  if (!parent) return { error: '親タスクが見つかりません' };
  const row = {
    id: genId(), user_id: userId, title: a.title,
    parent_task_id: parent.id, project_id: parent.project_id,
    status: parent.status === 'inbox' ? 'inbox' : 'active',
    due_at: a.due_at || parent.due_at, priority: a.priority || parent.priority,
    notes: a.notes || '', start_at: jstDate(0),
    created_at: now(), updated_at: now(), completed_at: null, sort_order: Date.now(),
  };
  const { error } = await sb.from('tasks').insert(row);
  if (error) throw error;
  return { added: a.title + '（' + parent.title + 'のサブタスク）' };
}

// ── 繰り返しの次回期限計算（アプリ版 nextRepeat の移植） ─────────────
// アプリ（index.html）の nextRepeat と同じ結果になること。未知のルールでは null。
function nextRepeatDue(dueAt: string, rule: string): string | null {
  const [dy, dm, dd] = dueAt.split('-').map(Number);
  const d = new Date(Date.UTC(dy, dm - 1, dd));
  if (rule === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else if (rule === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (rule === 'monthly') d.setUTCMonth(d.getUTCMonth() + 1);
  else if (rule === 'yearly') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else if (rule === 'weekdays') { do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6); }
  else if (rule.startsWith('weekly:')) {
    const DAY_MAP: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const days = rule.slice(7).split(',').map((x) => DAY_MAP[x]).filter((x) => x !== undefined).sort((a, b) => a - b);
    if (!days.length) return null;
    d.setUTCDate(d.getUTCDate() + 1);
    for (let i = 0; i < 14; i++) { if (days.includes(d.getUTCDay())) break; d.setUTCDate(d.getUTCDate() + 1); }
  }
  else if (rule.startsWith('monthly:')) {
    // 複数日対応: monthly:12,18,21（アプリ版と同じく末日で丸める）
    const targetDays = rule.slice(8).split(',').map(Number).filter((n) => n >= 1 && n <= 31).sort((a, b) => a - b);
    if (!targetDays.length) return null;
    const curDay = d.getUTCDate();
    const curMonth = d.getUTCMonth();
    const curYear = d.getUTCFullYear();
    let found = false;
    for (let mOffset = 0; mOffset <= 2 && !found; mOffset++) {
      const tryMonth = curMonth + mOffset;
      const tryYear = curYear + Math.floor(tryMonth / 12);
      const tryMonthMod = tryMonth % 12;
      const maxDay = new Date(Date.UTC(tryYear, tryMonthMod + 1, 0)).getUTCDate();
      for (const td of targetDays) {
        const actualDay = Math.min(td, maxDay);
        if (mOffset === 0 && actualDay <= curDay) continue;
        d.setUTCFullYear(tryYear, tryMonthMod, actualDay);
        found = true; break;
      }
    }
    if (!found) return null;
  }
  else return null;
  return d.toISOString().slice(0, 10);
}

function shiftDateStr(dateStr: string, shiftMs: number): string {
  const [y, m, dd] = dateStr.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, dd) + shiftMs).toISOString().slice(0, 10);
}

// タスクを完了し、繰り返しならアプリと同じルールで次回タスクを生成する。
// update_task の status='completed' では次回は作られないため、完了は原則こちらを使う。
async function completeTask(userId: string, a: any) {
  if (!a.task_id) return { error: 'task_idが必要です' };
  const { data: t } = await sb.from('tasks').select('*').eq('user_id', userId).eq('id', a.task_id).maybeSingle();
  if (!t) return { error: '対象のタスクが見つかりません' };
  if (t.status === 'completed') return { completed: t.title, already_completed: true };
  const ts = now();
  const { error: upErr } = await sb.from('tasks').update({ status: 'completed', completed_at: ts, updated_at: ts }).eq('id', t.id);
  if (upErr) throw upErr;
  const out: Record<string, unknown> = { completed: t.title };
  if (t.repeat_rule && t.due_at) {
    const dueDate = String(t.due_at).slice(0, 10);
    const nextDue = nextRepeatDue(dueDate, t.repeat_rule);
    if (nextDue) {
      // 重複チェック（アプリ版 spawnNextRepeat と同じ条件：同タイトル・同ルール・同親・同次回期限で未完了のものがあれば作らない）
      let q = sb.from('tasks').select('id').eq('user_id', userId)
        .eq('title', t.title).eq('repeat_rule', t.repeat_rule).eq('due_at', nextDue)
        .not('status', 'in', '("completed","archived")');
      q = t.parent_task_id ? q.eq('parent_task_id', t.parent_task_id) : q.is('parent_task_id', null);
      const { data: dups } = await q.limit(1);
      if (dups && dups.length) {
        out.next = { due_at: nextDue, already_exists: true };
      } else {
        const [dy, dm, dd] = dueDate.split('-').map(Number);
        const shift = new Date(nextDue + 'T00:00:00Z').getTime() - Date.UTC(dy, dm - 1, dd);
        const row: Record<string, unknown> = {
          ...t, id: genId(), status: 'active', completed_at: null,
          created_at: ts, updated_at: ts, synced_at: ts,
          due_at: nextDue, planned_start_at: jstDate(0),
        };
        if (t.start_at) row.start_at = shiftDateStr(String(t.start_at).slice(0, 10), shift);
        const { error: insErr } = await sb.from('tasks').insert(row);
        if (insErr) throw insErr;
        out.next = { id: row.id, due_at: nextDue };
      }
    }
  }
  return out;
}

// ════════════════════════════════════════════════════════════════════
//  Tavera 部（世帯固定）
//  Tavera では「献立」と「食事記録」は同じ menu_logs テーブル（世帯×日付×食事区分で1件。
//  UNIQUE(household_id, date, meal_type)）。アプリの「今日の献立」も menu_logs の当日分を表示している。
// ════════════════════════════════════════════════════════════════════

const MEAL_TYPES = ['breakfast', 'lunch', 'dinner'] as const;
const MEAL_LABELS: Record<string, string> = { breakfast: '朝', lunch: '昼', dinner: '夜' };
const MEAL_ALIASES: Record<string, string> = {
  breakfast: 'breakfast', '朝': 'breakfast', '朝食': 'breakfast', '朝ごはん': 'breakfast', '朝ご飯': 'breakfast',
  lunch: 'lunch', '昼': 'lunch', '昼食': 'lunch', '昼ごはん': 'lunch', '昼ご飯': 'lunch', 'お昼': 'lunch',
  dinner: 'dinner', '夜': 'dinner', '夕食': 'dinner', '夕飯': 'dinner', '晩ごはん': 'dinner', '晩ご飯': 'dinner',
  '夜ごはん': 'dinner', '夜ご飯': 'dinner', 'ばんごはん': 'dinner', '夕ごはん': 'dinner',
};
function normMealType(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return MEAL_ALIASES[v.trim()] || MEAL_ALIASES[v.trim().toLowerCase()] || null;
}

// 利用者が固定世帯のメンバーであることを確認（外れていたら何もしない）
let _taveraOk = false;
async function assertTaveraMember(userId: string): Promise<string | null> {
  if (_taveraOk) return null;
  const { data, error } = await sb.from('menu_members').select('id')
    .eq('id', userId).eq('household_id', TAVERA_HOUSEHOLD_ID).maybeSingle();
  if (error) throw error;
  if (!data) return 'Tavera の対象世帯に利用者が所属していないため操作できません';
  _taveraOk = true;
  return null;
}

function fmtMeal(l: any, userId: string) {
  return {
    id: l.id, date: l.date, meal_type: l.meal_type, meal_label: MEAL_LABELS[l.meal_type] || l.meal_type,
    dish_name: l.dish_name, memo: l.memo || null, rating: l.rating ?? null,
    ingredients: l.ingredients || [], source: l.source === 'kyushoku' ? '給食（献立表取込）' : '手入力',
    recorded_by_me: l.created_by === userId,
  };
}
const mealOrder = (m: string) => MEAL_TYPES.indexOf(m as any);

async function getTodayMenu(userId: string) {
  const err = await assertTaveraMember(userId); if (err) return { error: err };
  const today = jstDate(0);
  const { data, error } = await sb.from('menu_logs').select('*')
    .eq('household_id', TAVERA_HOUSEHOLD_ID).eq('date', today);
  if (error) throw error;
  const meals = (data || []).sort((a: any, b: any) => mealOrder(a.meal_type) - mealOrder(b.meal_type)).map((l: any) => fmtMeal(l, userId));
  return { date: today, meals, note: meals.length ? undefined : '今日の献立はまだ登録されていません' };
}

async function listMenus(userId: string, a: any) {
  const err = await assertTaveraMember(userId); if (err) return { error: err };
  const from = a.from ?? jstDate(-13);
  const to = a.to ?? jstDate(7);
  if (!isDateStr(from) || !isDateStr(to)) return { error: 'from / to は YYYY-MM-DD で指定してください' };
  if (from > to) return { error: 'from は to 以前の日付にしてください' };
  const limit = Math.max(1, Math.min(Number(a.limit) || 50, 100));
  let q = sb.from('menu_logs').select('*').eq('household_id', TAVERA_HOUSEHOLD_ID).gte('date', from).lte('date', to);
  if (a.meal_type !== undefined) {
    const mt = normMealType(a.meal_type);
    if (!mt) return { error: 'meal_type は breakfast / lunch / dinner（朝・昼・夜）のいずれかです' };
    q = q.eq('meal_type', mt);
  }
  if (a.keyword) q = q.ilike('dish_name', `%${a.keyword}%`);
  const { data, error } = await q.order('date', { ascending: false }).limit(limit);
  if (error) throw error;
  const rows = (data || []).sort((x: any, y: any) => x.date === y.date ? mealOrder(x.meal_type) - mealOrder(y.meal_type) : (x.date < y.date ? 1 : -1));
  return { from, to, count: rows.length, meals: rows.map((l: any) => fmtMeal(l, userId)) };
}

function readMealInput(a: any, requireDate: boolean) {
  const date = a.date ?? (requireDate ? undefined : jstDate(0));
  if (!isDateStr(date)) return { error: 'date は YYYY-MM-DD で指定してください' };
  const mt = a.meal_type === undefined && !requireDate ? 'dinner' : normMealType(a.meal_type);
  if (!mt) return { error: 'meal_type は breakfast / lunch / dinner（朝・昼・夜）のいずれかです' };
  const dish = typeof a.dish_name === 'string' ? a.dish_name.trim() : '';
  if (!dish) return { error: 'dish_name（料理名）が必要です' };
  if (dish.length > 500) return { error: 'dish_name が長すぎます（500文字まで）' };
  let rating: number | null | undefined = undefined;
  if (a.rating !== undefined && a.rating !== null) {
    if (!Number.isInteger(a.rating) || a.rating < 1 || a.rating > 5) return { error: 'rating は 1〜5 の整数です' };
    rating = a.rating;
  }
  let ingredients: string[] | undefined = undefined;
  if (a.ingredients !== undefined) {
    if (!Array.isArray(a.ingredients) || a.ingredients.some((x: unknown) => typeof x !== 'string')) return { error: 'ingredients は文字列の配列です' };
    ingredients = a.ingredients.map((x: string) => x.trim()).filter(Boolean);
  }
  const memo = a.memo === undefined ? undefined : String(a.memo ?? '');
  return { date: date as string, meal_type: mt, dish_name: dish, memo, rating, ingredients };
}

async function findMeal(date: string, mealType: string) {
  const { data, error } = await sb.from('menu_logs').select('*')
    .eq('household_id', TAVERA_HOUSEHOLD_ID).eq('date', date).eq('meal_type', mealType).maybeSingle();
  if (error) throw error;
  return data;
}

// 食事記録を追加する。同じ日・同じ食事区分に既に登録があれば上書きせずに知らせる（上書きは set_menu）
async function addMealRecord(userId: string, a: any) {
  const err = await assertTaveraMember(userId); if (err) return { error: err };
  const v: any = readMealInput(a, false);
  if (v.error) return v;
  const existing = await findMeal(v.date, v.meal_type);
  if (existing) {
    return {
      error: `${v.date} の${MEAL_LABELS[v.meal_type]}ごはんは既に登録されています。書き換える場合は set_menu を使ってください`,
      existing: fmtMeal(existing, userId),
    };
  }
  const row = {
    household_id: TAVERA_HOUSEHOLD_ID, date: v.date, meal_type: v.meal_type, dish_name: v.dish_name,
    memo: v.memo ?? '', rating: v.rating ?? null, ingredients: v.ingredients ?? [],
    created_by: userId, source: 'manual',
  };
  const { data, error } = await sb.from('menu_logs').insert(row).select().single();
  if (error) throw error;
  return { added: fmtMeal(data, userId) };
}

// 献立を登録・変更する（同じ日・食事区分があれば書き換え。アプリの保存と同じ upsert 挙動）
async function setMenu(userId: string, a: any) {
  const err = await assertTaveraMember(userId); if (err) return { error: err };
  const v: any = readMealInput(a, true);
  if (v.error) return v;
  const existing = await findMeal(v.date, v.meal_type);
  if (existing) {
    if (existing.source === 'kyushoku') {
      return { error: 'この枠は給食の献立表から取り込んだものなので、ここからは書き換えません。アプリの給食画面で変更してください', existing: fmtMeal(existing, userId) };
    }
    const patch: Record<string, unknown> = { dish_name: v.dish_name };
    if (v.memo !== undefined) patch.memo = v.memo;
    if (v.rating !== undefined) patch.rating = v.rating;
    if (v.ingredients !== undefined) patch.ingredients = v.ingredients;
    const { data, error } = await sb.from('menu_logs').update(patch).eq('id', existing.id)
      .eq('household_id', TAVERA_HOUSEHOLD_ID).select().single();
    if (error) throw error;
    return { updated: fmtMeal(data, userId), previous: { dish_name: existing.dish_name, memo: existing.memo || null } };
  }
  const row = {
    household_id: TAVERA_HOUSEHOLD_ID, date: v.date, meal_type: v.meal_type, dish_name: v.dish_name,
    memo: v.memo ?? '', rating: v.rating ?? null, ingredients: v.ingredients ?? [],
    created_by: userId, source: 'manual',
  };
  const { data, error } = await sb.from('menu_logs').insert(row).select().single();
  if (error) throw error;
  return { added: fmtMeal(data, userId) };
}

// ════════════════════════════════════════════════════════════════════
//  Flowra 部（我が家チーム固定。別プロジェクトの PostgREST をサービスロールで叩く）
//  - カテゴリはタグ方式（tags / transaction_tags）。存在しないカテゴリ名は作らずエラー
//  - 金額は正の整数のみ。残高は DB トリガー（trg_balance_update）任せで、直接書き換えない
//  - 非公開口座（is_private=true）は作成者本人にしか見せない（Flowra の RLS と同じ規則を再現）
// ════════════════════════════════════════════════════════════════════

type FlowraCtx = { uid: string; accounts: any[]; hidden: Set<string>; tags: any[] };

async function flowraCtx(): Promise<FlowraCtx | { error: string }> {
  if (!fl) return { error: 'Flowra への接続設定（FLOWRA_SERVICE_ROLE_KEY）がありません' };
  const uid = await getFlowraUserId();
  if (!uid) return { error: 'Flowra に利用者のアカウントが見つかりません' };
  const { data: mem, error: mErr } = await fl.from('team_members').select('role')
    .eq('team_id', FLOWRA_TEAM_ID).eq('user_id', uid).maybeSingle();
  if (mErr) throw mErr;
  if (!mem) return { error: 'Flowra の対象チームに利用者が所属していないため操作できません' };
  const [{ data: accts, error: aErr }, { data: tags, error: tErr }] = await Promise.all([
    fl.from('accounts').select('id,name,type,balance,is_private,is_archived,created_by,sort_order').eq('team_id', FLOWRA_TEAM_ID).order('sort_order'),
    fl.from('tags').select('id,name,color,sort_order').eq('team_id', FLOWRA_TEAM_ID).order('sort_order'),
  ]);
  if (aErr) throw aErr;
  if (tErr) throw tErr;
  const hidden = new Set<string>();
  const accounts: any[] = [];
  for (const a of accts || []) {
    if (a.is_private && a.created_by !== uid) hidden.add(a.id);
    else accounts.push(a);
  }
  return { uid, accounts, hidden, tags: tags || [] };
}

function txVisible(ctx: FlowraCtx, tx: any): boolean {
  return !ctx.hidden.has(tx.account_id) && !(tx.to_account_id && ctx.hidden.has(tx.to_account_id));
}
function hiddenFilter(q: any, ctx: FlowraCtx) {
  if (!ctx.hidden.size) return q;
  const ids = `(${[...ctx.hidden].join(',')})`;
  return q.not('account_id', 'in', ids).or(`to_account_id.is.null,to_account_id.not.in.${ids}`);
}

function resolveAccount(ctx: FlowraCtx, name: unknown, label: string): any {
  if (typeof name !== 'string' || !name.trim()) return { error: `${label}（口座名）が必要です` };
  const live = ctx.accounts.filter((a) => !a.is_archived);
  const n = name.trim();
  const exact = live.filter((a) => a.name === n);
  if (exact.length === 1) return exact[0];
  const partial = live.filter((a) => a.name.includes(n));
  if (exact.length === 0 && partial.length === 1) return partial[0];
  return { error: `${label}「${n}」を特定できません`, candidates: (partial.length ? partial : live).map((a) => a.name) };
}

function resolveCategories(ctx: FlowraCtx, a: any): any {
  let names: string[] = [];
  if (a.categories !== undefined) {
    if (!Array.isArray(a.categories) || a.categories.some((x: unknown) => typeof x !== 'string')) return { error: 'categories は文字列の配列です' };
    names = a.categories;
  } else if (a.category !== undefined) {
    if (typeof a.category !== 'string') return { error: 'category は文字列です' };
    names = [a.category];
  } else return { ids: undefined };
  const ids: string[] = [];
  const missing: string[] = [];
  for (const raw of names) {
    const n = raw.trim();
    if (!n) continue;
    const t = ctx.tags.find((x) => x.name === n);
    if (t) { if (!ids.includes(t.id)) ids.push(t.id); } else missing.push(n);
  }
  if (missing.length) return { error: `カテゴリ「${missing.join('、')}」は Flowra にありません（新しくは作りません）`, available: ctx.tags.map((t) => t.name) };
  return { ids };
}

function isPosInt(v: unknown): v is number { return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 1_000_000_000; }

const TX_SELECT = 'id,type,amount,date,memo,account_id,to_account_id,is_unsettled,is_excluded,created_by,created_at,transaction_tags(tag_id)';
function fmtTx(ctx: FlowraCtx, tx: any) {
  const acct = (id: string | null) => (id ? ctx.accounts.find((a) => a.id === id)?.name || null : null);
  const tagName = new Map(ctx.tags.map((t) => [t.id, t.name]));
  return {
    id: tx.id, date: tx.date, type: tx.type,
    type_label: tx.type === 'expense' ? '支出' : tx.type === 'income' ? '収入' : '振替',
    amount: tx.amount, memo: tx.memo || null,
    account: acct(tx.account_id), to_account: acct(tx.to_account_id),
    categories: (tx.transaction_tags || []).map((r: any) => tagName.get(r.tag_id)).filter(Boolean),
    is_unsettled: !!tx.is_unsettled, is_excluded: !!tx.is_excluded,
    recorded_by_me: tx.created_by === ctx.uid,
  };
}

async function listAccounts(_u: string, a: any) {
  const ctx = await flowraCtx(); if ('error' in ctx) return ctx;
  const rows = ctx.accounts.filter((x) => a.include_archived ? true : !x.is_archived);
  return rows.map((x) => ({ name: x.name, type: x.type, balance: x.balance, archived: x.is_archived, private: x.is_private }));
}

async function getBalance(_u: string, a: any) {
  const ctx = await flowraCtx(); if ('error' in ctx) return ctx;
  const live = ctx.accounts.filter((x) => !x.is_archived);
  if (a.account_name) {
    const acc = resolveAccount(ctx, a.account_name, '口座');
    if (acc.error) return acc;
    return { account: acc.name, balance: acc.balance };
  }
  // アプリのホーム画面「総資産」と同じく、アーカイブ以外の口座残高の合計
  return { total: live.reduce((s, x) => s + Number(x.balance || 0), 0), accounts: live.map((x) => ({ name: x.name, balance: x.balance })) };
}

async function listCategories(_u: string) {
  const ctx = await flowraCtx(); if ('error' in ctx) return ctx;
  return ctx.tags.map((t) => ({ name: t.name, color: t.color }));
}

async function listTransactions(_u: string, a: any) {
  const ctx = await flowraCtx(); if ('error' in ctx) return ctx;
  const limit = Math.max(1, Math.min(Number(a.limit) || 30, 100));
  for (const k of ['from', 'to']) if (a[k] !== undefined && !isDateStr(a[k])) return { error: `${k} は YYYY-MM-DD で指定してください` };
  let select = TX_SELECT;
  let tagId: string | null = null;
  if (a.category) {
    const t = ctx.tags.find((x) => x.name === a.category);
    if (!t) return { error: `カテゴリ「${a.category}」は Flowra にありません`, available: ctx.tags.map((x) => x.name) };
    tagId = t.id;
    select += ',ft:transaction_tags!inner(tag_id)';
  }
  let q = fl!.from('transactions').select(select).eq('team_id', FLOWRA_TEAM_ID);
  if (tagId) q = q.eq('ft.tag_id', tagId);
  if (a.from) q = q.gte('date', a.from);
  if (a.to) q = q.lte('date', a.to);
  if (a.type) {
    if (!['income', 'expense', 'transfer'].includes(a.type)) return { error: 'type は income / expense / transfer のいずれかです' };
    q = q.eq('type', a.type);
  }
  if (a.account_name) {
    const acc = resolveAccount(ctx, a.account_name, '口座');
    if (acc.error) return acc;
    q = q.or(`account_id.eq.${acc.id},to_account_id.eq.${acc.id}`);
  }
  if (a.keyword) q = q.ilike('memo', `%${String(a.keyword).replace(/[%_,()]/g, '')}%`);
  q = hiddenFilter(q, ctx).order('date', { ascending: false }).order('created_at', { ascending: false }).limit(limit);
  const { data, error } = await q;
  if (error) throw error;
  const rows = (data || []).filter((tx: any) => txVisible(ctx, tx));
  return { count: rows.length, transactions: rows.map((tx: any) => fmtTx(ctx, tx)) };
}

async function addTransaction(_u: string, a: any) {
  const ctx = await flowraCtx(); if ('error' in ctx) return ctx;
  const type = a.type ?? 'expense';
  if (!['income', 'expense', 'transfer'].includes(type)) return { error: 'type は income（収入）/ expense（支出）/ transfer（振替）のいずれかです' };
  if (!isPosInt(a.amount)) return { error: 'amount は正の整数（円）で指定してください' };
  const date = a.date ?? jstDate(0);
  if (!isDateStr(date)) return { error: 'date は YYYY-MM-DD で指定してください' };
  const acc = resolveAccount(ctx, a.account_name, type === 'transfer' ? '移動元' : '口座');
  if (acc.error) return acc;
  let toAcc: any = null;
  if (type === 'transfer') {
    toAcc = resolveAccount(ctx, a.to_account_name, '移動先');
    if (toAcc.error) return toAcc;
    if (toAcc.id === acc.id) return { error: '移動元と移動先が同じです' };
  }
  const cats = resolveCategories(ctx, a);
  if (cats.error) return cats;
  const row = {
    team_id: FLOWRA_TEAM_ID, type, amount: a.amount, date,
    account_id: acc.id, to_account_id: toAcc ? toAcc.id : null,
    memo: a.memo ? String(a.memo) : null, is_unsettled: !!a.is_unsettled, is_excluded: false,
    created_by: ctx.uid,
  };
  const { data: tx, error } = await fl!.from('transactions').insert(row).select('id').single();
  if (error) throw error;
  if (cats.ids && cats.ids.length) {
    const { error: tagErr } = await fl!.from('transaction_tags').insert(cats.ids.map((tag_id: string) => ({ transaction_id: tx.id, tag_id })));
    if (tagErr) {
      // 中途半端な記録を残さない（残高はトリガーで戻る）
      await fl!.from('transactions').delete().eq('id', tx.id).eq('team_id', FLOWRA_TEAM_ID);
      throw tagErr;
    }
  }
  return { added: await readBackTx(tx.id) };
}

async function readBackTx(id: string) {
  const ctx = await flowraCtx(); if ('error' in ctx) return ctx;
  const { data, error } = await fl!.from('transactions').select(TX_SELECT).eq('id', id).eq('team_id', FLOWRA_TEAM_ID).single();
  if (error) throw error;
  const out: any = fmtTx(ctx, data);
  const bal = (aid: string | null) => (aid ? ctx.accounts.find((x) => x.id === aid)?.balance ?? null : null);
  out.balance_after = { [out.account]: bal(data.account_id) };
  if (data.to_account_id) out.balance_after[out.to_account] = bal(data.to_account_id);
  return out;
}

async function updateTransaction(_u: string, a: any) {
  const ctx = await flowraCtx(); if ('error' in ctx) return ctx;
  if (!a.transaction_id || typeof a.transaction_id !== 'string') return { error: 'transaction_id が必要です（list_transactions で確認できます）' };
  const { data: cur, error: cErr } = await fl!.from('transactions').select(TX_SELECT)
    .eq('id', a.transaction_id).eq('team_id', FLOWRA_TEAM_ID).maybeSingle();
  if (cErr && cErr.code !== '22P02') throw cErr;
  if (!cur || !txVisible(ctx, cur)) return { error: '対象の記録が見つかりません' };

  const patch: Record<string, unknown> = {};
  const type = a.type ?? cur.type;
  if (!['income', 'expense', 'transfer'].includes(type)) return { error: 'type は income / expense / transfer のいずれかです' };
  if (a.type !== undefined) patch.type = type;
  if (a.amount !== undefined) { if (!isPosInt(a.amount)) return { error: 'amount は正の整数（円）で指定してください' }; patch.amount = a.amount; }
  if (a.date !== undefined) { if (!isDateStr(a.date)) return { error: 'date は YYYY-MM-DD で指定してください' }; patch.date = a.date; }
  if (a.memo !== undefined) patch.memo = a.memo ? String(a.memo) : null;
  if (a.is_unsettled !== undefined) patch.is_unsettled = !!a.is_unsettled;
  let accountId = cur.account_id;
  if (a.account_name !== undefined) {
    const acc = resolveAccount(ctx, a.account_name, type === 'transfer' ? '移動元' : '口座');
    if (acc.error) return acc;
    accountId = acc.id; patch.account_id = acc.id;
  }
  let toId: string | null = cur.to_account_id;
  if (type === 'transfer') {
    if (a.to_account_name !== undefined) {
      const t = resolveAccount(ctx, a.to_account_name, '移動先');
      if (t.error) return t;
      toId = t.id; patch.to_account_id = t.id;
    }
    if (!toId) return { error: '振替には移動先（to_account_name）が必要です' };
    if (toId === accountId) return { error: '移動元と移動先が同じです' };
  } else if (cur.to_account_id) {
    patch.to_account_id = null;
  }
  const cats = resolveCategories(ctx, a);
  if (cats.error) return cats;
  if (!Object.keys(patch).length && cats.ids === undefined) return { error: '変更する項目がありません' };

  if (Object.keys(patch).length) {
    patch.updated_by = ctx.uid;
    const { error } = await fl!.from('transactions').update(patch).eq('id', cur.id).eq('team_id', FLOWRA_TEAM_ID);
    if (error) throw error;
  }
  if (cats.ids !== undefined) {
    const { error: dErr } = await fl!.from('transaction_tags').delete().eq('transaction_id', cur.id);
    if (dErr) throw dErr;
    if (cats.ids.length) {
      const { error: iErr } = await fl!.from('transaction_tags').insert(cats.ids.map((tag_id: string) => ({ transaction_id: cur.id, tag_id })));
      if (iErr) throw iErr;
    }
  }
  return { updated: await readBackTx(cur.id), before: fmtTx(ctx, cur) };
}

async function monthlySummary(_u: string, a: any) {
  const ctx = await flowraCtx(); if ('error' in ctx) return ctx;
  const [ty, tm] = jstDate(0).split('-').map(Number);
  const year = a.year !== undefined ? Number(a.year) : ty;
  const month = a.month !== undefined ? Number(a.month) : tm;
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12 || year < 2000 || year > 2100) return { error: 'year / month が不正です' };
  const mm = String(month).padStart(2, '0');
  const from = `${year}-${mm}-01`;
  const to = `${year}-${mm}-${String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0')}`;

  // PostgREST は1回1000行までなのでページングして全件取得
  const rows: any[] = [];
  for (let off = 0; ; off += 1000) {
    const q = hiddenFilter(fl!.from('transactions').select('id,type,amount,account_id,to_account_id,is_excluded,transaction_tags(tag_id)')
      .eq('team_id', FLOWRA_TEAM_ID).gte('date', from).lte('date', to).in('type', ['income', 'expense']), ctx)
      .order('id').range(off, off + 999);
    const { data, error } = await q;
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 1000) break;
  }
  const vis = rows.filter((tx) => txVisible(ctx, tx));
  // ホーム画面と同じ：収入・支出は集計除外フラグに関係なく合計
  const income = vis.filter((t) => t.type === 'income').reduce((s, t) => s + Number(t.amount), 0);
  const expense = vis.filter((t) => t.type === 'expense').reduce((s, t) => s + Number(t.amount), 0);

  // カテゴリ別支出（集計シートと同じく is_excluded は除く。複数カテゴリの記録はそれぞれに計上）
  const { data: budgets, error: bErr } = await fl!.from('budgets').select('tag_id,month,amount')
    .eq('team_id', FLOWRA_TEAM_ID).or(`month.is.null,month.eq.${year}-${mm}`);
  if (bErr) throw bErr;
  const budgetMap = new Map<string, number>();
  for (const b of budgets || []) if (!budgetMap.has(b.tag_id) || b.month !== null) budgetMap.set(b.tag_id, b.amount);
  const byTag = new Map<string, number>();
  let uncategorized = 0;
  for (const t of vis) {
    if (t.type !== 'expense' || t.is_excluded) continue;
    const tags = (t.transaction_tags || []).map((r: any) => r.tag_id);
    if (!tags.length) uncategorized += Number(t.amount);
    for (const id of tags) byTag.set(id, (byTag.get(id) || 0) + Number(t.amount));
  }
  const expense_by_category = ctx.tags
    .filter((t) => byTag.has(t.id) || budgetMap.has(t.id))
    .map((t) => ({ category: t.name, spent: byTag.get(t.id) || 0, budget: budgetMap.get(t.id) ?? null }))
    .sort((x, y) => y.spent - x.spent);
  return {
    month: `${year}-${mm}`, income, expense, net: income - expense, count: vis.length,
    expense_by_category, uncategorized_expense: uncategorized,
    note: 'income/expense はアプリのホーム画面と同じ合計。カテゴリ別は集計除外の記録を除き、複数カテゴリの記録は各カテゴリに計上',
  };
}

// ── MCPツール定義（tools/list用） ───────────────────────────────────
const TOOLS = [
  // ── Taskra（タスク） ──
  {
    name: 'list_tasks',
    description: 'タスクの一覧を取得する。ステータス・期日・プロジェクト・タグ・キーワードで絞り込み可能。statusを省略するとactive+inbox（未完了）のみ',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['active', 'inbox', 'completed', 'archived', 'all_open'] },
        project_name: { type: 'string' },
        tag_name: { type: 'string' },
        due_before: { type: 'string', description: 'YYYY-MM-DD' },
        due_after: { type: 'string', description: 'YYYY-MM-DD' },
        completed_after: { type: 'string', description: 'YYYY-MM-DD。完了タスクのcompletedAtで絞り込み' },
        keyword: { type: 'string', description: 'タイトル部分一致' },
        limit: { type: 'number', description: '最大件数。デフォルト30、最大100' },
      },
    },
  },
  {
    name: 'add_task',
    description: '新しいタスクを追加する',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        due_at: { type: 'string', description: 'YYYY-MM-DD' },
        priority: { type: 'number', description: '1=高 2=中 3=低 4=なし' },
        flagged: { type: 'boolean' },
        project_name: { type: 'string' },
        tag_names: { type: 'array', items: { type: 'string' } },
        notes: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'update_task',
    description: 'タスクを更新する（タイトル変更・期日変更・タグ・完了/未完了/アーカイブの切り替えなど）。task_idまたはkeywordで対象を特定',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        keyword: { type: 'string', description: 'タイトルの一部（task_id不明時）' },
        new_title: { type: 'string' },
        due_at: { type: 'string', description: 'YYYY-MM-DD' },
        start_at: { type: 'string', description: 'YYYY-MM-DD' },
        start_time: { type: 'string', description: 'HH:MM' },
        due_time: { type: 'string', description: 'HH:MM' },
        priority: { type: 'number' },
        flagged: { type: 'boolean' },
        project_name: { type: 'string' },
        tag_names: { type: 'array', items: { type: 'string' } },
        append_tags: { type: 'boolean', description: 'trueなら既存タグに追記、falseなら置換' },
        repeat_rule: { type: 'string' },
        append_note: { type: 'string', description: 'notesへの追記' },
        status: { type: 'string', enum: ['active', 'inbox', 'completed', 'archived'], description: '完了にする場合はcompleted。未完了に戻す場合はactive/inbox。アーカイブはarchived' },
      },
    },
  },
  {
    name: 'complete_task',
    description: 'タスクを完了する。繰り返しタスクの場合はアプリと同じルールで次回タスクを自動生成する（update_taskのstatus=completedでは次回は作られないので、完了にはこちらを使う）。既に完了済みの場合は何もしない',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'add_subtask',
    description: '既存タスクにサブタスクを追加する',
    inputSchema: {
      type: 'object',
      properties: {
        parent_task_id: { type: 'string' },
        parent_keyword: { type: 'string' },
        title: { type: 'string' },
        due_at: { type: 'string' },
        priority: { type: 'number' },
        notes: { type: 'string' },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_projects',
    description: 'アクティブなプロジェクト一覧を取得する',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_project',
    description: '新しいプロジェクトを追加する',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, color: { type: 'string', description: '#xxxxxx' } },
      required: ['name'],
    },
  },
  {
    name: 'list_tags',
    description: 'タグ一覧を取得する',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'add_tag',
    description: '新しいタグを作成する',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, color: { type: 'string', description: '#xxxxxx。省略時は紫' } },
      required: ['name'],
    },
  },
  {
    name: 'add_note',
    description: '新しいノート（メモ帳）を作成する。タスクとは別機能',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
        tag_names: { type: 'array', items: { type: 'string' } },
      },
      required: ['title'],
    },
  },
  // ── Tavera（献立・食事記録） ──
  {
    name: 'get_today_menu',
    description: '【Tavera】今日（日本時間）の献立・食事記録を返す（朝・昼・夜）。アプリの「今日の献立」と同じ内容',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_menus',
    description: '【Tavera】期間を指定して献立・食事記録を取得する。省略時は13日前〜7日後。新しい日付順、最大100件',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD（省略時は13日前）' },
        to: { type: 'string', description: 'YYYY-MM-DD（省略時は7日後）' },
        meal_type: { type: 'string', enum: ['breakfast', 'lunch', 'dinner'], description: '朝・昼・夜で絞り込み' },
        keyword: { type: 'string', description: '料理名の部分一致' },
        limit: { type: 'number', description: 'デフォルト50、最大100' },
      },
    },
  },
  {
    name: 'add_meal_record',
    description: '【Tavera】食べたごはんを記録する（主に夕食の記録）。日付省略時は今日、食事区分省略時は夜。同じ日・同じ区分に既に登録がある場合は上書きせずエラーで既存内容を返す（書き換えは set_menu）',
    inputSchema: {
      type: 'object',
      properties: {
        dish_name: { type: 'string', description: '料理名。複数品は「ハンバーグ　ライス　スープ」のように並べる' },
        date: { type: 'string', description: 'YYYY-MM-DD（省略時は今日）' },
        meal_type: { type: 'string', enum: ['breakfast', 'lunch', 'dinner'], description: '省略時は dinner（夜）' },
        memo: { type: 'string' },
        rating: { type: 'number', description: '1〜5の評価（任意）' },
        ingredients: { type: 'array', items: { type: 'string' }, description: '主な食材（任意。買い物リストに使われる）' },
      },
      required: ['dish_name'],
    },
  },
  {
    name: 'set_menu',
    description: '【Tavera】日付と食事区分を指定して献立を登録・変更する。既に登録があれば書き換える（変更前の内容も返す）。給食の献立表から取り込んだ枠は書き換えない',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        meal_type: { type: 'string', enum: ['breakfast', 'lunch', 'dinner'] },
        dish_name: { type: 'string' },
        memo: { type: 'string', description: '指定時のみ変更' },
        rating: { type: 'number', description: '1〜5。指定時のみ変更' },
        ingredients: { type: 'array', items: { type: 'string' }, description: '指定時のみ変更' },
      },
      required: ['date', 'meal_type', 'dish_name'],
    },
  },
  // ── Flowra（家計簿・我が家チーム） ──
  {
    name: 'list_transactions',
    description: '【Flowra】家計簿の記録（支出・収入・振替）を新しい順に取得する。期間・種類・口座・カテゴリ・メモのキーワードで絞り込み可能',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD' },
        type: { type: 'string', enum: ['expense', 'income', 'transfer'] },
        account_name: { type: 'string' },
        category: { type: 'string', description: 'カテゴリ（タグ）名。list_categories の名前と完全一致' },
        keyword: { type: 'string', description: 'メモ（品目）の部分一致' },
        limit: { type: 'number', description: 'デフォルト30、最大100' },
      },
    },
  },
  {
    name: 'add_transaction',
    description: '【Flowra】家計簿に記録を追加する。金額は正の整数（円）。口座残高はアプリと同じく自動で増減する。カテゴリは既存のものだけ使える（list_categories で確認）',
    inputSchema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: '正の整数（円）' },
        account_name: { type: 'string', description: '支払い・入金の口座名（振替では移動元）。list_accounts の名前' },
        type: { type: 'string', enum: ['expense', 'income', 'transfer'], description: '省略時は expense（支出）' },
        to_account_name: { type: 'string', description: '振替の移動先口座名（transfer のときだけ）' },
        date: { type: 'string', description: 'YYYY-MM-DD（省略時は今日）' },
        memo: { type: 'string', description: '品目・メモ' },
        category: { type: 'string', description: 'カテゴリ名（1つの場合）' },
        categories: { type: 'array', items: { type: 'string' }, description: 'カテゴリ名（複数の場合）' },
        is_unsettled: { type: 'boolean', description: '未精算にする場合 true' },
      },
      required: ['amount', 'account_name'],
    },
  },
  {
    name: 'update_transaction',
    description: '【Flowra】家計簿の記録を修正する（金額・日付・メモ・口座・カテゴリ・未精算）。transaction_id は list_transactions で確認する。残高は自動で再計算される',
    inputSchema: {
      type: 'object',
      properties: {
        transaction_id: { type: 'string' },
        amount: { type: 'number', description: '正の整数（円）' },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        memo: { type: 'string' },
        type: { type: 'string', enum: ['expense', 'income', 'transfer'] },
        account_name: { type: 'string' },
        to_account_name: { type: 'string' },
        category: { type: 'string', description: '指定するとカテゴリをこの1つに置き換え' },
        categories: { type: 'array', items: { type: 'string' }, description: '指定するとカテゴリをこれらに置き換え（空配列でカテゴリなし）' },
        is_unsettled: { type: 'boolean' },
      },
      required: ['transaction_id'],
    },
  },
  {
    name: 'list_accounts',
    description: '【Flowra】口座の一覧と残高を返す',
    inputSchema: {
      type: 'object',
      properties: { include_archived: { type: 'boolean', description: 'アーカイブ済み口座も含める場合 true' } },
    },
  },
  {
    name: 'get_balance',
    description: '【Flowra】残高を返す。口座名を省略するとアプリのホーム画面と同じ合計（アーカイブ以外の口座の合計）',
    inputSchema: { type: 'object', properties: { account_name: { type: 'string' } } },
  },
  {
    name: 'list_categories',
    description: '【Flowra】カテゴリ（タグ）の一覧を返す',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'monthly_summary',
    description: '【Flowra】月の収入・支出・収支とカテゴリ別の支出（予算があれば予算も）を返す。省略時は今月（日本時間）',
    inputSchema: {
      type: 'object',
      properties: { year: { type: 'number' }, month: { type: 'number', description: '1〜12' } },
    },
  },
];

async function callTool(userId: string, name: string, a: any) {
  switch (name) {
    // Taskra
    case 'list_tasks': return await listTasks(userId, a);
    case 'add_task': return await addTask(userId, a);
    case 'update_task': return await updateTask(userId, a);
    case 'complete_task': return await completeTask(userId, a);
    case 'add_subtask': return await addSubtask(userId, a);
    case 'list_projects': return await listProjects(userId);
    case 'add_project': return await addProject(userId, a);
    case 'list_tags': return await listTags(userId);
    case 'add_tag': return await addTag(userId, a);
    case 'add_note': return await addNote(userId, a);
    // Tavera
    case 'get_today_menu': return await getTodayMenu(userId);
    case 'list_menus': return await listMenus(userId, a);
    case 'add_meal_record': return await addMealRecord(userId, a);
    case 'set_menu': return await setMenu(userId, a);
    // Flowra
    case 'list_transactions': return await listTransactions(userId, a);
    case 'add_transaction': return await addTransaction(userId, a);
    case 'update_transaction': return await updateTransaction(userId, a);
    case 'list_accounts': return await listAccounts(userId, a);
    case 'get_balance': return await getBalance(userId, a);
    case 'list_categories': return await listCategories(userId);
    case 'monthly_summary': return await monthlySummary(userId, a);
    default: return { error: '未知のツール: ' + name };
  }
}

// ── HTTPエントリポイント（MCP Streamable HTTP transport） ───────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method === 'GET') return new Response('Family MCP server (use POST)', { status: 405, headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });

  const url = new URL(req.url);
  const lastSeg = url.pathname.split('/').filter(Boolean).pop() || '';
  const providedToken =
    url.searchParams.get('token') ||
    (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
    (lastSeg !== 'family-mcp' ? lastSeg : '');

  if (!MCP_SECRET_TOKEN || providedToken !== MCP_SECRET_TOKEN) {
    return json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, 401);
  }

  let body: any;
  try { body = await req.json(); }
  catch { return json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, 400); }

  const { id, method, params } = body || {};

  try {
    if (method === 'initialize') {
      return json({
        jsonrpc: '2.0', id,
        result: {
          protocolVersion: params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'family-mcp', version: '1.0.0' },
        },
      });
    }
    if (method === 'notifications/initialized') {
      return new Response(null, { status: 202, headers: corsHeaders });
    }
    if (method === 'tools/list') {
      return json({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    }
    if (method === 'tools/call') {
      const userId = await getUserId();
      if (!userId) {
        return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: '利用者が見つかりません（FAMILY_MCP_USER_EMAIL 設定を確認してください）' }) }], isError: true } });
      }
      const toolName = params?.name;
      const args = (params?.arguments && typeof params.arguments === 'object') ? params.arguments : {};
      // 利用者・チーム・世帯の切り替えは受け付けない（来ても読まない）
      for (const k of ['user_id', 'userId', 'email', 'user_email', 'team_id', 'teamId', 'household_id', 'householdId']) delete args[k];
      const result = await callTool(userId, toolName, args);
      const isError = !!(result && typeof result === 'object' && !Array.isArray(result) && 'error' in result);
      return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }], ...(isError ? { isError: true } : {}) } });
    }
    return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  } catch (e) {
    console.error('family-mcp error', e);
    const msg = (e as any)?.message || String(e);
    return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify({ error: 'エラー: ' + msg }) }], isError: true } });
  }
});

// Taskra MCP Server
// Claude.ai等のMCPクライアントからTaskraのタスクを操作するための remote MCP server。
// 認証はOAuthではなく簡易シークレットトークン方式（個人利用前提）。
// URLの ?token=... / 末尾パスセグメント / Authorization: Bearer のいずれかで
// MCP_SECRET_TOKEN と一致すれば許可する。

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL         = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_SERVICE_KEY = Deno.env.get('SB_SERVICE_ROLE_KEY')!;
const MCP_SECRET_TOKEN     = Deno.env.get('MCP_SECRET_TOKEN') || '';
const MCP_USER_EMAIL       = Deno.env.get('MCP_USER_EMAIL') || '';

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

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

// ── ユーザーID解決（メール→Supabase Auth UID。簡易キャッシュ） ─────────
let _cachedUserId: string | null = null;
async function getUserId(): Promise<string | null> {
  if (_cachedUserId) return _cachedUserId;
  if (!MCP_USER_EMAIL) return null;
  let page = 1;
  for (;;) {
    const { data, error } = await sb.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data) break;
    const found = data.users.find((u: any) => u.email === MCP_USER_EMAIL);
    if (found) { _cachedUserId = found.id; return found.id; }
    if (data.users.length < 200) break;
    page++;
  }
  return null;
}

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

async function deleteTask(userId: string, a: any) {
  let target: any = null;
  if (a.task_id) {
    const { data } = await sb.from('tasks').select('id,title').eq('user_id', userId).eq('id', a.task_id).maybeSingle();
    target = data;
  } else if (a.keyword) {
    const { data } = await sb.from('tasks').select('id,title').eq('user_id', userId).ilike('title', `%${a.keyword}%`).limit(1).maybeSingle();
    target = data;
  }
  if (!target) return { error: '対象のタスクが見つかりません' };
  const { error } = await sb.from('tasks').delete().eq('id', target.id);
  if (error) throw error;
  return { deleted: target.title };
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

// ── MCPツール定義（tools/list用） ───────────────────────────────────
const TOOLS = [
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
    name: 'delete_task',
    description: 'タスクを削除する',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        keyword: { type: 'string' },
      },
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
];

async function callTool(userId: string, name: string, a: any) {
  switch (name) {
    case 'list_tasks': return await listTasks(userId, a);
    case 'add_task': return await addTask(userId, a);
    case 'update_task': return await updateTask(userId, a);
    case 'delete_task': return await deleteTask(userId, a);
    case 'add_subtask': return await addSubtask(userId, a);
    case 'list_projects': return await listProjects(userId);
    case 'add_project': return await addProject(userId, a);
    case 'list_tags': return await listTags(userId);
    case 'add_tag': return await addTag(userId, a);
    case 'add_note': return await addNote(userId, a);
    default: return { error: '未知のツール: ' + name };
  }
}

// ── HTTPエントリポイント（MCP Streamable HTTP transport） ───────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method === 'GET') return new Response('Taskra MCP server (use POST)', { status: 405, headers: corsHeaders });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: corsHeaders });

  const url = new URL(req.url);
  const lastSeg = url.pathname.split('/').filter(Boolean).pop() || '';
  const providedToken =
    url.searchParams.get('token') ||
    (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '') ||
    (lastSeg !== 'mcp-server' ? lastSeg : '');

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
          serverInfo: { name: 'taskra-mcp', version: '1.0.0' },
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
        return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'ユーザーが見つかりません（MCP_USER_EMAIL設定を確認してください）' }], isError: true } });
      }
      const toolName = params?.name;
      const args = params?.arguments || {};
      const result = await callTool(userId, toolName, args);
      return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(result) }] } });
    }
    return json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
  } catch (e) {
    console.error('mcp-server error', e);
    return json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'エラー: ' + (e as Error).message }], isError: true } });
  }
});

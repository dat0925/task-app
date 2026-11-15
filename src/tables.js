// 会社用 Taskra：テーブル機能（タスクとは別の汎用の表）【2026-11-15 追加・同日 2回目】
//
// 形は Airtable／Notion のデータベースにそろえる：テーブル → 列（field）→ 行（record）＋ ビュー（view）。
//   - 行の値は table_records.values に、列の id をキーにして入れる（列名を変えても値が迷子にならない）
//     text・long_text・url・email … 文字列／number … 数値／date … 'YYYY-MM-DD'／checkbox … true
//     select … 選択肢の id／multi_select … 選択肢の id の配列（選択肢は table_fields.options.choices）
//     取り込みで型に合わなかった値は、捨てずに元の文字列のまま置き、画面では黄色の印で出す
//   - secret 型の列は values に入れず、table_record_secrets に暗号文だけを置く。
//     暗号化はシークレットメモ（src/secret-memo.js）と同じマスター鍵で、ブラウザの中だけで行う（E2EE）。
//     平文は画面で「表示」を押したときだけメモリに置き、ロック（タブを離れる等）で消す。console にも出さない
//   - ビュー（table_views.config）に、フィルタ・並べ替え・隠した列を保存する。変更はその場で保存する（Airtable／Notion と同じ）
//
// index.html 側の入口は、サイドバーの「Table」と renderContent の分岐だけ。描画はこのファイルで完結させる。
(function () {
  'use strict';

  var SB = function () { return window._SB; };
  var say = function (m, undo) { if (typeof window.toast === 'function') window.toast(m, undo); };
  var h = function (s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); };
  var svg = function (d, s) { s = s || 14; return '<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>'; };
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };

  var EMPTY_PRIMARY = '（名称なし）';
  var TYPES = {
    text:         { label: 'テキスト',     icon: svg('<polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/>') },
    long_text:    { label: '長いテキスト', icon: svg('<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="14" y2="18"/>') },
    number:       { label: '数値',         icon: svg('<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>') },
    date:         { label: '日付',         icon: svg('<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>') },
    checkbox:     { label: 'チェック',     icon: svg('<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>') },
    select:       { label: '選択',         icon: svg('<circle cx="12" cy="12" r="9"/><polyline points="8 11 12 15 16 11"/>') },
    multi_select: { label: '複数選択',     icon: svg('<line x1="9" y1="6" x2="20" y2="6"/><line x1="9" y1="12" x2="20" y2="12"/><line x1="9" y1="18" x2="20" y2="18"/><circle cx="4.5" cy="6" r="1.2"/><circle cx="4.5" cy="12" r="1.2"/><circle cx="4.5" cy="18" r="1.2"/>') },
    url:          { label: 'URL',          icon: svg('<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>') },
    email:        { label: 'メール',       icon: svg('<path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/>') },
    secret:       { label: 'シークレット（暗号化）', icon: svg('<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>') }
  };
  var ALL_TYPES = ['text', 'long_text', 'number', 'date', 'checkbox', 'select', 'multi_select', 'url', 'email', 'secret'];
  var TEXTLIKE = ['text', 'long_text', 'url', 'email'];   // 文字列のまま持つ型（secret と行き来できる）
  var INLINE_TEXT = ['text', 'url', 'email', 'number']; // セルでそのまま書き換える型
  var typeOf = function (f) { return TYPES[f.type] || TYPES.text; };
  var COLORS = { gray: '灰', red: '赤', orange: '橙', yellow: '黄', green: '緑', teal: '青緑', blue: '青', purple: '紫' };
  var COLOR_KEYS = Object.keys(COLORS);
  var ICO = {
    open: svg('<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>', 13),
    eye: svg('<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>', 14),
    eyeOff: svg('<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/>', 14),
    copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 14),
    edit: svg('<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>', 14),
    ext: svg('<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>', 14),
    close: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 16),
    x: svg('<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>', 13),
    table: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><line x1="3" y1="10" x2="21" y2="10"/><line x1="9" y1="4" x2="9" y2="20"/>', 16),
    grid: svg('<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="3" y1="15" x2="21" y2="15"/><line x1="9" y1="3" x2="9" y2="21"/>', 14),
    more: svg('<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>', 16),
    filter: svg('<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>', 14),
    hide: svg('<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><line x1="1" y1="1" x2="23" y2="23"/>', 14),
    sortAsc: svg('<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>', 14),
    sortDesc: svg('<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>', 14),
    check: svg('<polyline points="20 6 9 17 4 12"/>', 14),
    chev: svg('<polyline points="6 9 12 15 18 9"/>', 12)
  };

  // ---------------------------------------------------------------------
  // 状態
  // ---------------------------------------------------------------------
  var st = {
    tables: null, counts: {}, loading: false, error: '',
    tableId: null, loadedFor: null, fields: [], records: [], views: [], viewId: null,
    hasSecret: {},         // hasSecret[recordId+':'+fieldId] = true（暗号文の有無だけ。中身は持たない）
    loadingTable: false, q: '',
    revealed: {},          // 表示中の平文（key → 文字列）。ロックで消す
    drawerId: null, editingSecret: null
  };
  try { st.tableId = localStorage.getItem('tb-last') || null; } catch (e) {}

  var key = function (rid, fid) { return rid + ':' + fid; };
  var curTable = function () { return (st.tables || []).find(function (t) { return t.id === st.tableId; }) || null; };
  var fieldById = function (id) { return st.fields.find(function (f) { return f.id === id; }) || null; };
  var recById = function (id) { return st.records.find(function (r) { return r.id === id; }) || null; };
  var primaryField = function () { return st.fields.find(function (f) { return f.is_primary; }) || st.fields[0]; };
  var nowIso = function () { return new Date().toISOString(); };
  var newId = function () { return crypto.randomUUID(); };
  var norm = function (s) { return String(s == null ? '' : s).normalize('NFKC').toLowerCase(); };
  var isUrl = function (v) { try { var u = new URL(String(v).trim()); return u.protocol === 'http:' || u.protocol === 'https:'; } catch (e) { return false; } };
  var isEmail = function (v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v).trim()); };
  var isIsoDate = function (v) { return typeof v === 'string' && /^\d{4}-\d\d-\d\d$/.test(v); };

  // ---- 値の扱い（型ごと） ----
  function choices(f) { return (f.options && Array.isArray(f.options.choices)) ? f.options.choices : []; }
  function choiceById(f, id) { return choices(f).find(function (c) { return c.id === id; }) || null; }
  function rawVal(rec, f) { return rec.values ? rec.values[f.id] : undefined; }
  function isEmptyVal(rec, f) {
    if (f.type === 'secret') return !st.hasSecret[key(rec.id, f.id)];
    var v = rawVal(rec, f);
    return v == null || v === '' || v === false || (Array.isArray(v) && !v.length);
  }
  // 型に合わない値（取り込みで残した元の文字列）か
  function isMismatch(rec, f) {
    var v = rawVal(rec, f);
    if (v == null || v === '') return false;
    if (f.type === 'number') return typeof v !== 'number';
    if (f.type === 'date') return !isIsoDate(v);
    if (f.type === 'checkbox') return typeof v !== 'boolean';
    if (f.type === 'select') return !choiceById(f, v);
    if (f.type === 'multi_select') return !Array.isArray(v) || v.some(function (id) { return !choiceById(f, id); });
    if (f.type === 'url') return !isUrl(v);
    if (f.type === 'email') return !isEmail(v);
    return false;
  }
  function fmtDate(v) { return isIsoDate(v) ? v.replace(/-/g, '/') : String(v); }
  function fmtNumber(v) { return typeof v === 'number' ? v.toLocaleString('ja-JP', { maximumFractionDigits: 10 }) : String(v); }
  // 検索・書き出し・型変換に使う文字列
  function strVal(rec, f) {
    var v = rawVal(rec, f);
    if (v == null) return '';
    switch (f.type) {
      case 'checkbox': return v === true ? 'TRUE' : (v === false ? '' : String(v));
      case 'select': var c = choiceById(f, v); return c ? c.name : String(v);
      case 'multi_select': return (Array.isArray(v) ? v : [v]).map(function (id) { var c2 = choiceById(f, id); return c2 ? c2.name : String(id); }).join(', ');
      default: return String(v);
    }
  }
  function parseNumber(s) {
    var t = String(s == null ? '' : s).normalize('NFKC').replace(/[,\s¥$円]/g, '').trim();
    if (t === '') return null;
    if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return undefined;
    return Number(t);
  }
  function parseDate(s) {
    var t = String(s == null ? '' : s).normalize('NFKC').trim();
    if (!t) return null;
    var m = t.match(/^(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})日?(?:[ T].*)?$/);
    if (!m) return undefined;
    var y = +m[1], mo = +m[2], d = +m[3];
    var dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return undefined;
    return m[1] + '-' + pad(mo) + '-' + pad(d);
  }
  var TRUTHY = ['true', '1', 'yes', 'y', 'はい', '✓', '✔', '○', '◯', '済', 'on', 'checked', 'x'];
  var FALSY = ['false', '0', 'no', 'n', 'いいえ', '', '×', 'off', 'unchecked'];
  function parseCheckbox(s) {
    var t = String(s == null ? '' : s).normalize('NFKC').trim().toLowerCase();
    if (TRUTHY.indexOf(t) >= 0) return true;
    if (FALSY.indexOf(t) >= 0) return false;
    return undefined;
  }
  function newChoice(f, name) {
    var used = choices(f).map(function (c) { return c.color; });
    var color = COLOR_KEYS.find(function (c) { return used.indexOf(c) < 0; }) || COLOR_KEYS[choices(f).length % COLOR_KEYS.length];
    var c = { id: newId().slice(0, 8), name: name, color: color };
    f.options = Object.assign({}, f.options || {}); f.options.choices = choices(f).concat([c]);
    return c;
  }
  function choiceByName(f, name, create) {
    var c = choices(f).find(function (x) { return x.name === name; });
    if (!c && create) c = newChoice(f, name);
    return c;
  }
  // 文字列を列の型の値にする。{ value（undefined なら空）, warn（型に合わず元の文字列のまま残した） }
  // select／multi_select は選択肢を f.options に足すことがある（呼んだ側で列を保存する）
  function fromString(s, f) {
    s = s == null ? '' : String(s);
    if (s.trim() === '' && f.type !== 'checkbox') return { value: undefined };
    switch (f.type) {
      case 'number': var n = parseNumber(s); return n === undefined ? { value: s, warn: true } : { value: n };
      case 'date': var d = parseDate(s); return d === undefined ? { value: s, warn: true } : { value: d };
      case 'checkbox': var b = parseCheckbox(s); return b === undefined ? { value: s, warn: true } : { value: b || undefined };
      case 'select': return { value: choiceByName(f, s.trim(), true).id };
      case 'multi_select':
        var names = s.split(/\s*[,、]\s*/).map(function (x) { return x.trim(); }).filter(Boolean);
        var ids = []; names.forEach(function (nm) { var id = choiceByName(f, nm, true).id; if (ids.indexOf(id) < 0) ids.push(id); });
        return { value: ids.length ? ids : undefined };
      case 'url': return { value: s, warn: !isUrl(s) };
      case 'email': return { value: s, warn: !isEmail(s) };
      default: return { value: s };
    }
  }

  // ---- ビュー ----
  function curView() { return st.views.find(function (v) { return v.id === st.viewId; }) || st.views[0] || null; }
  function cfg() {
    var v = curView();
    var c = (v && v.config) || {};
    if (!c.filters) c.filters = { conj: 'and', conditions: [] };
    if (!Array.isArray(c.filters.conditions)) c.filters.conditions = [];
    if (!Array.isArray(c.sorts)) c.sorts = [];
    if (!Array.isArray(c.hidden_field_ids)) c.hidden_field_ids = [];
    if (v) v.config = c;
    return c;
  }
  function visibleFields() {
    var hid = cfg().hidden_field_ids;
    return st.fields.filter(function (f) { return f.is_primary || hid.indexOf(f.id) < 0; });
  }
  var saveViewTimer = null;
  function saveView() {
    var v = curView(); if (!v) return;
    clearTimeout(saveViewTimer);
    saveViewTimer = setTimeout(async function () {
      var r = await SB().from('table_views').update({ config: v.config, updated_at: nowIso() }).eq('id', v.id);
      if (r.error) fail('saveView', r.error);
    }, 300);
  }
  async function saveAllViews() {
    for (var i = 0; i < st.views.length; i++) {
      var r = await SB().from('table_views').update({ config: st.views[i].config, updated_at: nowIso() }).eq('id', st.views[i].id);
      if (r.error) { fail('saveViews', r.error); return; }
    }
  }
  // 列を消した・型を変えたときに、ビューの設定から外す
  function dropFieldFromViews(fid, onlyFilters) {
    st.views.forEach(function (v) {
      var c = v.config || {};
      if (c.filters && c.filters.conditions) c.filters.conditions = c.filters.conditions.filter(function (x) { return x.fieldId !== fid; });
      if (!onlyFilters) {
        if (c.sorts) c.sorts = c.sorts.filter(function (x) { return x.fieldId !== fid; });
        if (c.hidden_field_ids) c.hidden_field_ids = c.hidden_field_ids.filter(function (x) { return x !== fid; });
      }
    });
  }

  function hostEl() { return document.querySelector('.tb-wrap'); }

  // ---------------------------------------------------------------------
  // DB
  // ---------------------------------------------------------------------
  function fail(where, error) {
    // 値は出さない（エラーの種類と場所だけ）
    console.error('tables:' + where, error && (error.code || error.message));
    say('⚠ 保存に失敗しました。もう一度お試しください');
  }

  async function loadTables() {
    st.loading = true; st.error = '';
    var r = await SB().from('tables').select('*').order('sort_order').order('created_at');
    if (r.error) { st.loading = false; st.error = '読み込みに失敗しました'; console.error('tables:loadTables', r.error.code); return; }
    st.tables = r.data || [];
    // 行数（一覧カードに出す）。行そのものは取らず、件数だけ数える
    st.counts = {};
    await Promise.all(st.tables.map(async function (t) {
      var c = await SB().from('table_records').select('id', { count: 'exact', head: true }).eq('table_id', t.id);
      st.counts[t.id] = c.count || 0;
    }));
    st.loading = false;
    if (st.tableId && !curTable()) st.tableId = null;
  }

  // PostgREST は1回1000行まで（start.mjs の db-max-rows）。ページを分けて全部取る。make は毎回新しいクエリを返す（並び順を必ず付ける）
  async function fetchPaged(make) {
    var out = [], from = 0, size = 1000;
    for (;;) {
      var r = await make().range(from, from + size - 1);
      if (r.error) throw r.error;
      out = out.concat(r.data || []);
      if (!r.data || r.data.length < size) break;
      from += size;
    }
    return out;
  }
  function secretsOf(cols, fieldIds) {
    return fetchPaged(function () { return SB().from('table_record_secrets').select(cols).in('field_id', fieldIds).order('record_id').order('field_id'); });
  }

  async function loadTable(id) {
    st.loadingTable = true; st.loadedFor = null; st.fields = []; st.records = []; st.views = []; st.hasSecret = {}; st.revealed = {};
    try {
      var f = await SB().from('table_fields').select('*').eq('table_id', id).order('sort_order');
      if (f.error) throw f.error;
      st.fields = sortFields(f.data || []);
      st.records = await fetchPaged(function () { return SB().from('table_records').select('id,table_id,values,sort_order,created_at,updated_at').eq('table_id', id).order('sort_order').order('id'); });
      var secretFieldIds = st.fields.filter(function (x) { return x.type === 'secret'; }).map(function (x) { return x.id; });
      if (secretFieldIds.length) {
        // 暗号文の有無だけを取る（cipher 本体は「表示」「コピー」のときに1件ずつ取る）
        var rs = await secretsOf('record_id,field_id', secretFieldIds);
        rs.forEach(function (x) { st.hasSecret[key(x.record_id, x.field_id)] = true; });
      }
      var v = await SB().from('table_views').select('*').eq('table_id', id).order('sort_order').order('created_at');
      if (v.error) throw v.error;
      st.views = v.data || [];
      if (!st.views.length) {
        // 最初のビューを作る。1回目で手元（localStorage）に置いていた並べ替えがあれば引き継ぐ
        var sorts = [];
        try { var old = JSON.parse(localStorage.getItem('tb-sort-' + id) || 'null'); if (old && old.fieldId) sorts = [{ fieldId: old.fieldId, dir: old.dir || 'asc' }]; localStorage.removeItem('tb-sort-' + id); } catch (e) {}
        var nv = await SB().from('table_views').insert({ table_id: id, name: 'すべて', type: 'grid', sort_order: 0, config: { filters: { conj: 'and', conditions: [] }, sorts: sorts, hidden_field_ids: [] } }).select().single();
        if (nv.error) throw nv.error;
        st.views = [nv.data];
      }
      var last = null; try { last = localStorage.getItem('tb-view-' + id); } catch (e) {}
      st.viewId = st.views.some(function (x) { return x.id === last; }) ? last : st.views[0].id;
      st.loadedFor = id;
    } catch (e) {
      console.error('tables:loadTable', e && e.code);
      say('⚠ テーブルを読み込めませんでした');
    }
    st.loadingTable = false;
  }

  function sortFields(list) {
    return list.slice().sort(function (a, b) {
      if (a.is_primary !== b.is_primary) return a.is_primary ? -1 : 1;
      return (a.sort_order - b.sort_order) || String(a.created_at).localeCompare(String(b.created_at));
    });
  }

  async function saveValues(rec) {
    rec.updated_at = nowIso();
    var r = await SB().from('table_records').update({ values: rec.values, updated_at: rec.updated_at }).eq('id', rec.id);
    if (r.error) { fail('saveValues', r.error); return false; }
    return true;
  }
  // 1つのセルの値を変える（先に画面を変え、失敗したら戻す）
  async function setValue(rec, f, value) {
    var had = rec.values && Object.prototype.hasOwnProperty.call(rec.values, f.id);
    var before = had ? rec.values[f.id] : undefined;
    rec.values = Object.assign({}, rec.values);
    if (value === undefined || value === null || value === '' || value === false || (Array.isArray(value) && !value.length)) delete rec.values[f.id];
    else rec.values[f.id] = value;
    if (f.is_primary && !rec.values[f.id]) rec.values[f.id] = EMPTY_PRIMARY;
    refreshCell(rec.id, f.id);
    var ok = await saveValues(rec);
    if (!ok) { if (had) rec.values[f.id] = before; else delete rec.values[f.id]; refreshCell(rec.id, f.id); }
    if (st.drawerId === rec.id) { var a = document.activeElement; if (!a || !a.closest || !a.closest('#tb-drawer')) drawDrawer(); }
    return ok;
  }
  async function saveFieldOptions(f) {
    var r = await SB().from('table_fields').update({ options: f.options || {}, updated_at: nowIso() }).eq('id', f.id);
    if (r.error) { fail('saveFieldOptions', r.error); return false; }
    return true;
  }
  async function upsertRecords(recs) {
    for (var k = 0; k < recs.length; k += 200) {
      var u = await SB().from('table_records').upsert(recs.slice(k, k + 200).map(function (x) { return { id: x.id, table_id: x.table_id, values: x.values, sort_order: x.sort_order, updated_at: nowIso() }; }), { onConflict: 'id' });
      if (u.error) throw u.error;
    }
  }

  async function fetchCipher(rid, fid) {
    var r = await SB().from('table_record_secrets').select('cipher').eq('record_id', rid).eq('field_id', fid).maybeSingle();
    if (r.error) throw r.error;
    return r.data ? r.data.cipher : null;
  }

  async function saveSecret(rid, fid, plain) {
    if (!plain) {
      var d = await SB().from('table_record_secrets').delete().eq('record_id', rid).eq('field_id', fid);
      if (d.error) { fail('deleteSecret', d.error); return false; }
      delete st.hasSecret[key(rid, fid)];
      return true;
    }
    var cipher = await window.SecretMemo.encryptText(plain);
    var r = await SB().from('table_record_secrets').upsert({ record_id: rid, field_id: fid, cipher: cipher, updated_at: nowIso() }, { onConflict: 'record_id,field_id' });
    if (r.error) { fail('saveSecret', r.error); return false; }
    st.hasSecret[key(rid, fid)] = true;
    return true;
  }

  async function unlock() {
    if (!window.SecretMemo || !window.SecretMemo.requireUnlock) { say('⚠ シークレット機能を読み込めていません'); return false; }
    return window.SecretMemo.requireUnlock();
  }

  async function plainOf(rid, fid) {
    var k = key(rid, fid);
    if (st.revealed[k] != null) return st.revealed[k];
    if (!(await unlock())) return null;
    var c = await fetchCipher(rid, fid);
    if (!c) return '';
    try { return await window.SecretMemo.decryptText(c); }
    catch (e) { say('⚠ 復号できませんでした（合言葉が違う鍵で暗号化された可能性があります）'); return null; }
  }

  // ---------------------------------------------------------------------
  // 描画：入口（index.html の renderContent から呼ばれる）
  // ---------------------------------------------------------------------
  function render(el) {
    // 同期などで renderContent が呼ばれても、表示中の表は作り直さない（入力中の内容とスクロール位置を守る）
    var cur = el.querySelector(':scope > .tb-wrap');
    if (cur && cur.dataset.key === (st.tableId || 'list') && !cur.dataset.stale) return;
    draw(el);
  }

  function draw(el) {
    el = el || document.getElementById('content');
    if (!el) return;
    closeMenu();
    if (!st.tables) {
      el.innerHTML = '<div class="tb-wrap" data-key="loading" data-stale="1">' + skeleton() + '</div>';
      if (!st.loading) loadTables().then(function () { if (S.view === 'tables') draw(); });
      return;
    }
    if (st.error) {
      el.innerHTML = '<div class="tb-wrap" data-key="err" data-stale="1"><div class="tb-list"><div class="tb-empty">' + h(st.error) + '<br><button class="tb-btn" data-tb="reload" style="margin-top:10px">再読み込み</button></div></div></div>';
      bind(el.firstChild); return;
    }
    if (st.tableId && curTable() && (st.loadingTable || st.loadedFor !== st.tableId)) {
      el.innerHTML = '<div class="tb-wrap" data-key="loading" data-stale="1">' + skeleton() + '</div>';
      if (!st.loadingTable) openTable(st.tableId);
      return;
    }
    if (st.tableId && curTable()) el.innerHTML = gridHtml();
    else { st.tableId = null; el.innerHTML = listHtml(); }
    bind(el.firstChild);
  }

  function skeleton() {
    var s = '<div class="tb-skel">';
    for (var i = 0; i < 10; i++) s += '<i style="opacity:' + (1 - i * 0.08) + '"></i>';
    return s + '</div>';
  }

  // ---- 一覧 ----
  function listHtml() {
    var cards = st.tables.map(function (t) {
      return '<button class="tb-card" data-tb="open" data-id="' + t.id + '">'
        + '<span class="tb-card-name">' + ICO.table + h(t.name) + '</span>'
        + '<span class="tb-card-meta">' + (st.counts[t.id] || 0) + '件' + (t.description ? '・' + h(t.description) : '') + '</span></button>';
    }).join('');
    return '<div class="tb-wrap" data-key="list"><div class="tb-list">'
      + '<div class="tb-list-head"><h2>テーブル</h2><button class="tb-btn primary" data-tb="new-table">＋ 新しいテーブル</button></div>'
      + (st.tables.length ? '<div class="tb-cards">' + cards + '</div>'
        : '<div class="tb-empty">表の形でデータを置く場所です。ログイン情報の一覧や、取引先のリストなどに使えます。<br>'
          + '「新しいテーブル」で作り、CSV を取り込むか、1行ずつ書き足してください。<br>'
          + '<button class="tb-btn primary" data-tb="new-table" style="margin-top:14px">＋ 新しいテーブル</button></div>')
      + '</div></div>';
  }

  // ---- 絞り込み・並べ替え ----
  var OPS = {
    text: [['contains', '含む'], ['not_contains', '含まない'], ['is', '等しい'], ['is_not', '等しくない'], ['empty', '空'], ['not_empty', '空でない']],
    number: [['eq', '＝'], ['neq', '≠'], ['gt', '＞'], ['gte', '≧'], ['lt', '＜'], ['lte', '≦'], ['empty', '空'], ['not_empty', '空でない']],
    date: [['is', 'この日'], ['before', 'より前'], ['after', 'より後'], ['empty', '空'], ['not_empty', '空でない']],
    checkbox: [['checked', 'チェックあり'], ['unchecked', 'チェックなし']],
    select: [['is', '等しい'], ['is_not', '等しくない'], ['empty', '空'], ['not_empty', '空でない']],
    multi_select: [['has', '含む'], ['not_has', '含まない'], ['empty', '空'], ['not_empty', '空でない']],
    secret: [['empty', '空'], ['not_empty', '空でない']]
  };
  function opsFor(f) { return OPS[TEXTLIKE.indexOf(f.type) >= 0 ? 'text' : f.type] || OPS.text; }
  var NO_VALUE_OPS = ['empty', 'not_empty', 'checked', 'unchecked'];

  function matchCond(rec, c) {
    var f = fieldById(c.fieldId); if (!f) return true;
    var op = c.op, v = rawVal(rec, f), cv = c.value;
    if (op === 'empty') return isEmptyVal(rec, f);
    if (op === 'not_empty') return !isEmptyVal(rec, f);
    if (op === 'checked') return v === true;
    if (op === 'unchecked') return v !== true;
    if (cv == null || cv === '') return true; // 値を入れていない条件は、まだ効かせない
    if (TEXTLIKE.indexOf(f.type) >= 0) {
      var s = norm(strVal(rec, f)), q = norm(cv);
      if (op === 'contains') return s.indexOf(q) >= 0;
      if (op === 'not_contains') return s.indexOf(q) < 0;
      if (op === 'is') return s === q;
      if (op === 'is_not') return s !== q;
    }
    if (f.type === 'number') {
      var n = parseNumber(cv); if (n == null) return true;
      if (typeof v !== 'number') return op === 'neq';
      return op === 'eq' ? v === n : op === 'neq' ? v !== n : op === 'gt' ? v > n : op === 'gte' ? v >= n : op === 'lt' ? v < n : v <= n;
    }
    if (f.type === 'date') {
      if (!isIsoDate(v)) return false;
      return op === 'is' ? v === cv : op === 'before' ? v < cv : v > cv;
    }
    if (f.type === 'select') return op === 'is' ? v === cv : v !== cv;
    if (f.type === 'multi_select') { var arr = Array.isArray(v) ? v : []; return op === 'has' ? arr.indexOf(cv) >= 0 : arr.indexOf(cv) < 0; }
    return true;
  }
  function activeConds() {
    return cfg().filters.conditions.filter(function (c) { return fieldById(c.fieldId) && (NO_VALUE_OPS.indexOf(c.op) >= 0 || (c.value != null && c.value !== '')); });
  }

  var coll = new Intl.Collator('ja', { numeric: true, sensitivity: 'base' });
  function compareBy(f, a, b) {
    var ea = isEmptyVal(a, f), eb = isEmptyVal(b, f);
    if (ea || eb) return ea === eb ? 0 : (ea ? 1 : -1);
    var x = rawVal(a, f), y = rawVal(b, f);
    if (f.type === 'number' && typeof x === 'number' && typeof y === 'number') return x - y;
    if (f.type === 'checkbox') return (x === true ? 1 : 0) - (y === true ? 1 : 0);
    if (f.type === 'select' || f.type === 'multi_select') {
      var idx = function (v) { var id = Array.isArray(v) ? v[0] : v; var i = choices(f).findIndex(function (c) { return c.id === id; }); return i < 0 ? 9999 : i; };
      return idx(x) - idx(y);
    }
    return coll.compare(strVal(a, f), strVal(b, f));
  }

  function visibleRecords() {
    var rows = st.records;
    var c = cfg();
    var conds = activeConds();
    if (conds.length) {
      var any = c.filters.conj === 'or';
      rows = rows.filter(function (r) { return any ? conds.some(function (x) { return matchCond(r, x); }) : conds.every(function (x) { return matchCond(r, x); }); });
    }
    var q = norm(st.q).trim();
    if (q) {
      var words = q.split(/\s+/);
      var searchable = st.fields.filter(function (f) { return f.type !== 'secret'; });
      rows = rows.filter(function (r) {
        var hay = searchable.map(function (f) { return norm(strVal(r, f)); }).join('\u0001');
        return words.every(function (w) { return hay.indexOf(w) >= 0; });
      });
    }
    var sorts = c.sorts.filter(function (s) { var f = fieldById(s.fieldId); return f && f.type !== 'secret'; });
    if (sorts.length) {
      rows = rows.slice().sort(function (a, b) {
        for (var i = 0; i < sorts.length; i++) {
          var f = fieldById(sorts[i].fieldId);
          var ea = isEmptyVal(a, f), eb = isEmptyVal(b, f);
          if (ea !== eb) return ea ? 1 : -1; // 空は向きに関係なく最後
          if (f.type === 'number' || f.type === 'date') {
            var ma = !ea && isMismatch(a, f), mb = !eb && isMismatch(b, f);
            if (ma !== mb) return ma ? 1 : -1; // 型に合わない値は、正しい値の後ろ（空の手前）
          }
          var d = compareBy(f, a, b) * (sorts[i].dir === 'desc' ? -1 : 1);
          if (d) return d;
        }
        return a.sort_order - b.sort_order;
      });
    }
    return rows;
  }

  // ---- グリッド ----
  function gridHtml() {
    var t = curTable();
    var v = curView();
    var c = cfg();
    var rows = visibleRecords();
    var nf = activeConds().length, ns = c.sorts.length, nh = c.hidden_field_ids.filter(function (id) { return fieldById(id); }).length;
    return '<div class="tb-wrap" data-key="' + t.id + '">'
      + '<div class="tb-bar">'
      + '<button class="tb-back" data-tb="back">‹ テーブル</button>'
      + '<span class="tb-title" title="' + h(t.name) + '">' + h(t.name) + '</span>'
      + '<button class="tb-btn tb-viewbtn" data-tb="view-menu" title="ビューを切り替える">' + ICO.grid + '<span>' + h(v ? v.name : '') + '</span>' + ICO.chev + '</button>'
      + '<span class="tb-count" id="tb-count">' + countText(rows.length) + '</span>'
      + '<span class="tb-spacer"></span>'
      + '<input type="search" class="tb-search" id="tb-q" placeholder="検索（シークレット列は対象外）" value="' + h(st.q) + '">'
      + '<button class="tb-btn' + (nf ? ' on' : '') + '" data-tb="filter">' + ICO.filter + 'フィルタ' + (nf ? '<b class="tb-badge">' + nf + '</b>' : '') + '</button>'
      + '<button class="tb-btn' + (ns ? ' on' : '') + '" data-tb="sort">' + ICO.sortAsc + '並べ替え' + (ns ? '<b class="tb-badge">' + ns + '</b>' : '') + '</button>'
      + '<button class="tb-btn' + (nh ? ' on' : '') + '" data-tb="hide">' + ICO.hide + '列の表示' + (nh ? '<b class="tb-badge">' + nh + '</b>' : '') + '</button>'
      + '<button class="tb-btn" data-tb="import">CSVを取り込む</button><input type="file" id="tb-file" accept=".csv,text/csv" hidden>'
      + '<button class="tb-btn" data-tb="export">書き出す</button>'
      + '<button class="tb-icon-btn" data-tb="table-menu" title="テーブルの操作">' + ICO.more + '</button>'
      + '</div>'
      + '<div class="tb-scroll" id="tb-scroll">' + tableHtml(rows) + '</div>'
      + '</div>';
  }

  function countText(n) { return (n === st.records.length ? '' : n + ' / ') + st.records.length + '件'; }

  function tableHtml(rows) {
    var fs = visibleFields();
    var sortMap = {}; cfg().sorts.forEach(function (s) { sortMap[s.fieldId] = s.dir; });
    var filtered = {}; activeConds().forEach(function (c) { filtered[c.fieldId] = true; });
    var total = 52 + 44 + fs.reduce(function (s, f) { return s + (f.width || 200); }, 0);
    var s = '<table class="tb-grid" style="width:' + total + 'px"><colgroup><col style="width:52px">'
      + fs.map(function (f) { return '<col data-fid="' + f.id + '" style="width:' + (f.width || 200) + 'px">'; }).join('')
      + '<col style="width:44px"></colgroup><thead><tr><th class="tb-rn"></th>'
      + fs.map(function (f) {
          return '<th class="tb-th' + (f.is_primary ? ' tb-pri' : '') + '" data-tb="col-menu" data-fid="' + f.id + '" title="' + h(f.name + '（' + typeOf(f).label + '）') + '">'
            + '<div class="tb-th-inner"><span class="tb-type">' + typeOf(f).icon + '</span><span class="tb-th-name">' + h(f.name) + '</span>'
            + (filtered[f.id] ? '<span class="tb-th-mark" title="フィルタ中">' + ICO.filter + '</span>' : '')
            + (sortMap[f.id] ? '<span class="tb-th-mark" title="並べ替え中">' + (sortMap[f.id] === 'desc' ? ICO.sortDesc : ICO.sortAsc) + '</span>' : '')
            + '</div><span class="tb-resize" data-fid="' + f.id + '"></span></th>';
        }).join('')
      + '<th class="tb-addcol" data-tb="add-col" title="列を追加">＋</th></tr></thead><tbody id="tb-body">' + bodyHtml(rows) + '</tbody></table>';
    s += rows.length || !st.records.length ? '' : '<div class="tb-nohit">一致する行がありません</div>';
    s += '<button class="tb-addrow" data-tb="add-row">＋ 行を追加</button>';
    return s;
  }

  function bodyHtml(rows) {
    var fs = visibleFields();
    return rows.map(function (r, i) { return rowHtml(r, i + 1, fs); }).join('');
  }

  function rowHtml(r, n, fs) {
    return '<tr data-rid="' + r.id + '"><td class="tb-rn" data-tb="open-row" title="詳細を開く"><span class="tb-rn-num">' + n + '</span><span class="tb-rn-open">' + ICO.open + '</span></td>'
      + fs.map(function (f) { return cellHtml(r, f); }).join('')
      + '<td class="tb-addcol-cell"></td></tr>';
  }

  function cellHtml(r, f) {
    return '<td class="tb-td t-' + f.type + (f.is_primary ? ' tb-pri' : '') + '" data-fid="' + f.id + '">' + cellInner(r, f) + '</td>';
  }

  function pill(c) { return '<span class="tb-pill c-' + h(c.color || 'gray') + '">' + h(c.name) + '</span>'; }
  function warnHtml(v, why) { return '<span class="tb-warn" title="' + h(why) + '（値はそのまま残しています）"><span class="tb-warn-dot"></span>' + h(v) + '</span>'; }

  function cellInner(r, f) {
    var v = rawVal(r, f);
    if (f.type === 'secret') {
      var k = key(r.id, f.id);
      if (!st.hasSecret[k]) return '';
      var shown = st.revealed[k] != null;
      return '<span class="tb-secret-cell"><span class="tb-secret-val">' + (shown ? '<span class="tb-secret-plain">' + h(st.revealed[k]) + '</span>' : '<span class="tb-mask">••••••••</span>') + '</span>'
        + '<button class="tb-icon-btn" data-tb="reveal" title="' + (shown ? '隠す' : '表示') + '">' + (shown ? ICO.eyeOff : ICO.eye) + '</button>'
        + '<button class="tb-icon-btn" data-tb="copy" title="コピー（30秒後にクリップボードを消去）">' + ICO.copy + '</button></span>';
    }
    if (f.type === 'checkbox') {
      if (v != null && typeof v !== 'boolean') return warnHtml(v, 'チェックとして読めない値です');
      return '<span class="tb-cb' + (v === true ? ' on' : '') + '" role="checkbox" aria-checked="' + (v === true) + '">' + (v === true ? ICO.check : '') + '</span>';
    }
    if (v == null || v === '') return '';
    if (f.type === 'number') return typeof v === 'number' ? h(fmtNumber(v)) : warnHtml(v, '数値として読めない値です');
    if (f.type === 'date') return isIsoDate(v) ? h(fmtDate(v)) : warnHtml(v, '日付として読めない値です');
    if (f.type === 'select') { var c = choiceById(f, v); return c ? pill(c) : warnHtml(v, '選択肢にない値です'); }
    if (f.type === 'multi_select') return (Array.isArray(v) ? v : [v]).map(function (id) { var c2 = choiceById(f, id); return c2 ? pill(c2) : ''; }).join('');
    if (f.type === 'url') return isUrl(v) ? '<a class="tb-link" href="' + h(String(v).trim()) + '" target="_blank" rel="noopener noreferrer">' + h(v) + '</a>' : warnHtml(v, 'URL の形式ではありません');
    if (f.type === 'email') return isEmail(v) ? '<a class="tb-link" href="mailto:' + h(String(v).trim()) + '">' + h(v) + '</a>' : warnHtml(v, 'メールアドレスの形式ではありません');
    if (f.type === 'long_text') { var s = String(v); return h(s.split(/\r?\n/)[0]) + (s.indexOf('\n') >= 0 ? ' …' : ''); }
    return h(v);
  }

  // 1つのセル・1つの行だけを描き直す（全体を作り直さない）
  function refreshCell(rid, fid) {
    var td = document.querySelector('.tb-grid tr[data-rid="' + rid + '"] td[data-fid="' + fid + '"]');
    var r = recById(rid), f = fieldById(fid);
    if (td && r && f) { td.classList.remove('tb-editing'); td.innerHTML = cellInner(r, f); }
  }
  function refreshBody() {
    var body = document.getElementById('tb-body');
    if (!body) return;
    var rows = visibleRecords();
    body.innerHTML = bodyHtml(rows);
    var c = document.getElementById('tb-count'); if (c) c.textContent = countText(rows.length);
    var sc = document.getElementById('tb-scroll');
    var nh = sc && sc.querySelector('.tb-nohit');
    if (nh) nh.remove();
    if (sc && !rows.length && st.records.length) {
      var d = document.createElement('div'); d.className = 'tb-nohit'; d.textContent = '一致する行がありません';
      sc.insertBefore(d, sc.querySelector('.tb-addrow'));
    }
  }
  function redrawGrid() {
    var sc = document.getElementById('tb-scroll');
    var top = sc ? sc.scrollTop : 0, left = sc ? sc.scrollLeft : 0;
    var qf = document.activeElement && document.activeElement.id === 'tb-q';
    draw();
    sc = document.getElementById('tb-scroll');
    if (sc) { sc.scrollTop = top; sc.scrollLeft = left; }
    if (qf) { var q = document.getElementById('tb-q'); if (q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); } }
  }

  // ---------------------------------------------------------------------
  // 操作
  // ---------------------------------------------------------------------
  function bind(wrap) {
    if (!wrap) return;
    wrap.addEventListener('click', onClick);
    var q = wrap.querySelector('#tb-q');
    if (q) {
      var tm = null;
      q.addEventListener('input', function () { clearTimeout(tm); tm = setTimeout(function () { st.q = q.value; refreshBody(); }, 120); });
    }
    var fi = wrap.querySelector('#tb-file');
    if (fi) fi.addEventListener('change', function () { onCsvChosen(fi); });
    wrap.addEventListener('pointerdown', onResizeStart);
  }

  async function openTable(id) {
    st.tableId = id; st.q = ''; st.drawerId = null;
    try { localStorage.setItem('tb-last', id); } catch (e) {}
    var el = document.getElementById('content');
    if (el) el.innerHTML = '<div class="tb-wrap" data-key="loading" data-stale="1">' + skeleton() + '</div>';
    await loadTable(id);
    if (S.view === 'tables' && st.tableId === id) draw();
  }

  function onClick(e) {
    var a = e.target.closest('[data-tb]');
    var td = e.target.closest('td.tb-td');
    if (a) {
      var act = a.dataset.tb;
      if (act === 'open') return openTable(a.dataset.id);
      if (act === 'back') { st.tableId = null; try { localStorage.removeItem('tb-last'); } catch (e2) {} loadTables().then(function () { draw(); }); return; }
      if (act === 'reload') { st.tables = null; st.error = ''; return draw(); }
      if (act === 'new-table') return newTableSheet();
      if (act === 'view-menu') return viewMenu(a);
      if (act === 'filter') return filterPanel(a);
      if (act === 'sort') return sortPanel(a);
      if (act === 'hide') return hidePanel(a);
      if (act === 'import') return pickCsv();
      if (act === 'export') return exportSheet();
      if (act === 'table-menu') return tableMenu(a);
      if (act === 'col-menu') { if (e.target.closest('.tb-resize')) return; return colMenu(a); }
      if (act === 'add-col') return addColSheet();
      if (act === 'add-row') return addRow();
      var tr = a.closest('tr');
      if (act === 'open-row' && tr) return openDrawer(tr.dataset.rid);
      if ((act === 'reveal' || act === 'copy') && td && tr) { e.stopPropagation(); return act === 'reveal' ? toggleReveal(tr.dataset.rid, td.dataset.fid) : copySecret(tr.dataset.rid, td.dataset.fid); }
      return;
    }
    if (td && !e.target.closest('a')) {
      var row = td.closest('tr');
      var f = fieldById(td.dataset.fid);
      var rec = row && recById(row.dataset.rid);
      if (!f || !rec) return;
      if (f.type === 'long_text' || f.type === 'secret') return openDrawer(rec.id, f.id);
      if (f.type === 'checkbox') {
        if (rawVal(rec, f) != null && typeof rawVal(rec, f) !== 'boolean') return openDrawer(rec.id, f.id);
        return setValue(rec, f, rawVal(rec, f) === true ? undefined : true);
      }
      if (f.type === 'select' || f.type === 'multi_select') return choicePicker(td, rec, f);
      if (f.type === 'date') return startDateEdit(td, rec, f);
      startEdit(td, rec, f);
    }
  }

  // ---- セルのその場編集（テキスト・URL・メール・数値） ----
  function startEdit(td, rec, f) {
    if (td.classList.contains('tb-editing')) return;
    var raw = rawVal(rec, f);
    var before = raw == null ? '' : String(raw);
    td.classList.add('tb-editing');
    td.innerHTML = '<input class="tb-cell-input" type="text"' + (f.type === 'number' ? ' inputmode="decimal"' : '') + '>';
    var inp = td.firstChild;
    inp.value = before;
    inp.focus(); inp.select();
    var done = false;
    var finish = async function (save, moveNext) {
      if (done) return; done = true;
      var v = inp.value;
      if (save && v !== before) {
        var val = v;
        if (f.type === 'number') {
          var n = parseNumber(v);
          if (n === undefined) { say('数値として読めないので、元に戻しました'); refreshCell(rec.id, f.id); return; }
          val = n == null ? undefined : n;
        }
        await setValue(rec, f, val);
      } else refreshCell(rec.id, f.id);
      if (moveNext) {
        var next = td.nextElementSibling;
        while (next && !(next.classList.contains('tb-td') && INLINE_TEXT.some(function (t) { return next.classList.contains('t-' + t); }))) next = next.nextElementSibling;
        if (next) { var nf = fieldById(next.dataset.fid); if (nf) startEdit(next, rec, nf); }
      }
    };
    inp.addEventListener('keydown', function (ev) {
      if (ev.isComposing) return;
      if (ev.key === 'Enter') { ev.preventDefault(); finish(true); }
      else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); }
      else if (ev.key === 'Tab') { ev.preventDefault(); finish(true, true); }
    });
    inp.addEventListener('blur', function () { finish(true); });
  }

  function startDateEdit(td, rec, f) {
    if (td.classList.contains('tb-editing')) return;
    var v = rawVal(rec, f);
    td.classList.add('tb-editing');
    td.innerHTML = '<input class="tb-cell-input" type="date">';
    var inp = td.firstChild;
    inp.value = isIsoDate(v) ? v : '';
    inp.focus();
    try { inp.showPicker && inp.showPicker(); } catch (e) {}
    var done = false;
    var finish = function (save) {
      if (done) return; done = true;
      if (save && inp.value !== (isIsoDate(v) ? v : '')) setValue(rec, f, inp.value || undefined);
      else refreshCell(rec.id, f.id);
    };
    inp.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); finish(true); } else if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); finish(false); } });
    inp.addEventListener('blur', function () { finish(true); });
  }

  // ---- 選択肢のピッカー（選択・複数選択） ----
  function choicePicker(anchor, rec, f) {
    var multi = f.type === 'multi_select';
    openPanel(anchor, function (panel, close) {
      var q = '';
      var cur = function () { var v = rawVal(rec, f); return multi ? (Array.isArray(v) ? v : []) : (v ? [v] : []); };
      var paint = function () {
        var list = choices(f).filter(function (c) { return !q || norm(c.name).indexOf(norm(q)) >= 0; });
        var exact = choices(f).some(function (c) { return c.name === q.trim(); });
        var sel = cur();
        panel.querySelector('.tb-pick-list').innerHTML = list.map(function (c) {
          return '<button class="tb-pick-item" data-cid="' + h(c.id) + '"><span class="tb-pick-check">' + (sel.indexOf(c.id) >= 0 ? ICO.check : '') + '</span>' + pill(c) + '</button>';
        }).join('')
          + (q.trim() && !exact ? '<button class="tb-pick-item" data-new="1"><span class="tb-pick-check">＋</span>「' + h(q.trim()) + '」を選択肢に足す</button>' : '')
          + (!list.length && !q.trim() ? '<div class="tb-pick-empty">選択肢はまだありません。文字を入れて Enter で作れます</div>' : '');
      };
      panel.innerHTML = '<input class="tb-input tb-pick-q" placeholder="' + (multi ? '選ぶ・探す・新しく作る' : '選ぶ・探す・新しく作る') + '">'
        + '<div class="tb-pick-list"></div>'
        + (!multi && cur().length ? '<button class="tb-pick-clear">選択を外す</button>' : '');
      var inp = panel.querySelector('.tb-pick-q');
      setTimeout(function () { inp.focus(); }, 20);
      paint();
      var pick = async function (cid) {
        if (multi) {
          var s = cur().slice(); var i = s.indexOf(cid);
          if (i >= 0) s.splice(i, 1); else s.push(cid);
          await setValue(rec, f, s); paint();
        } else { close(); await setValue(rec, f, cid); }
      };
      var create = async function () {
        var name = q.trim(); if (!name) return;
        var c = newChoice(f, name);
        if (!(await saveFieldOptions(f))) return;
        q = ''; inp.value = '';
        await pick(c.id);
      };
      inp.addEventListener('input', function () { q = inp.value; paint(); });
      inp.addEventListener('keydown', function (ev) {
        if (ev.isComposing) return;
        if (ev.key === 'Enter') {
          ev.preventDefault();
          var hit = choices(f).find(function (c) { return c.name === q.trim(); }) || (q ? choices(f).find(function (c) { return norm(c.name).indexOf(norm(q)) >= 0; }) : null);
          if (hit) pick(hit.id); else create();
        }
      });
      panel.addEventListener('click', function (ev) {
        var b = ev.target.closest('.tb-pick-item');
        if (b) { if (b.dataset.new) create(); else pick(b.dataset.cid); return; }
        if (ev.target.closest('.tb-pick-clear')) { close(); setValue(rec, f, undefined); }
      });
    }, 'tb-pick');
  }

  // ---- シークレット：表示・コピー ----
  async function toggleReveal(rid, fid) {
    var k = key(rid, fid);
    if (st.revealed[k] != null) { delete st.revealed[k]; refreshCell(rid, fid); if (st.drawerId === rid) drawDrawer(); return; }
    var p = await plainOf(rid, fid);
    if (p == null) return;
    st.revealed[k] = p;
    refreshCell(rid, fid);
    if (st.drawerId === rid) drawDrawer();
  }
  async function copySecret(rid, fid) {
    var p = await plainOf(rid, fid);
    if (p == null) return;
    window.SecretMemo.copyText(p, true);
    say('コピーしました（30秒後にクリップボードを消去します）');
  }
  window.addEventListener('secretmemo:lock', function () {
    var had = Object.keys(st.revealed).length > 0;
    st.revealed = {}; st.editingSecret = null;
    if (had) {
      document.querySelectorAll('.tb-grid td.t-secret').forEach(function (td) {
        var rid = td.closest('tr') && td.closest('tr').dataset.rid; if (rid) refreshCell(rid, td.dataset.fid);
      });
    }
    if (st.drawerId) drawDrawer();
  });

  // ---- 行 ----
  async function addRow() {
    var t = curTable(); var pf = primaryField(); if (!t || !pf) return;
    var max = st.records.reduce(function (m, r) { return Math.max(m, r.sort_order || 0); }, 0);
    var rec = { id: newId(), table_id: t.id, values: {}, sort_order: max + 1, created_at: nowIso(), updated_at: nowIso() };
    rec.values[pf.id] = '';
    st.records.push(rec);
    st.q = ''; var q = document.getElementById('tb-q'); if (q) q.value = '';
    refreshBody();
    var r = await SB().from('table_records').insert({ id: rec.id, table_id: rec.table_id, values: rec.values, sort_order: rec.sort_order });
    if (r.error) { st.records = st.records.filter(function (x) { return x !== rec; }); refreshBody(); return fail('addRow', r.error); }
    var td = document.querySelector('.tb-grid tr[data-rid="' + rec.id + '"] td[data-fid="' + pf.id + '"]');
    if (td) { td.scrollIntoView({ block: 'nearest' }); startEdit(td, rec, pf); }
    else if (activeConds().length) say('フィルタで隠れています。行を足しました');
  }

  async function deleteRow(rid) {
    var rec = recById(rid);
    if (!rec) return;
    // 元に戻せるよう、暗号文ごと控えてから消す
    var secrets = [];
    var sf = st.fields.filter(function (f) { return f.type === 'secret' && st.hasSecret[key(rid, f.id)]; });
    if (sf.length) {
      var s = await SB().from('table_record_secrets').select('record_id,field_id,cipher').eq('record_id', rid);
      if (s.error) return fail('deleteRow', s.error);
      secrets = s.data || [];
    }
    var r = await SB().from('table_records').delete().eq('id', rid);
    if (r.error) return fail('deleteRow', r.error);
    st.records = st.records.filter(function (x) { return x.id !== rid; });
    sf.forEach(function (f) { delete st.hasSecret[key(rid, f.id)]; delete st.revealed[key(rid, f.id)]; });
    closeDrawer(); refreshBody();
    say('行を削除しました', async function () {
      var ins = await SB().from('table_records').insert({ id: rec.id, table_id: rec.table_id, values: rec.values, sort_order: rec.sort_order });
      if (ins.error) return fail('undoDeleteRow', ins.error);
      if (secrets.length) {
        var is = await SB().from('table_record_secrets').insert(secrets);
        if (is.error) fail('undoDeleteRow', is.error);
        secrets.forEach(function (x) { st.hasSecret[key(x.record_id, x.field_id)] = true; });
      }
      st.records.push(rec); st.records.sort(function (a, b) { return a.sort_order - b.sort_order; });
      refreshBody(); say('元に戻しました');
    });
  }

  // ---------------------------------------------------------------------
  // 行の詳細パネル
  // ---------------------------------------------------------------------
  var drawerFocus = null;
  function openDrawer(rid, focusFid) {
    st.drawerId = rid; drawerFocus = focusFid || null; st.editingSecret = null;
    var bg = document.getElementById('tb-drawer-bg');
    if (!bg) {
      bg = document.createElement('div'); bg.id = 'tb-drawer-bg'; bg.className = 'tb-drawer-bg';
      bg.addEventListener('click', closeDrawer);
      var d = document.createElement('div'); d.id = 'tb-drawer'; d.className = 'tb-drawer';
      d.setAttribute('role', 'dialog'); d.setAttribute('aria-label', '行の詳細');
      document.body.appendChild(bg); document.body.appendChild(d);
      d.addEventListener('click', onDrawerClick);
      requestAnimationFrame(function () { bg.classList.add('on'); d.classList.add('on'); });
    }
    drawDrawer();
  }
  function closeDrawer() {
    st.drawerId = null; st.editingSecret = null;
    var bg = document.getElementById('tb-drawer-bg'), d = document.getElementById('tb-drawer');
    if (d && d.contains(document.activeElement)) document.activeElement.blur(); // 入力中の内容を保存させる
    if (bg) bg.classList.remove('on');
    if (d) d.classList.remove('on');
    setTimeout(function () { if (!st.drawerId) { if (bg) bg.remove(); if (d) d.remove(); } }, 220);
  }

  function drawDrawer() {
    var d = document.getElementById('tb-drawer');
    var rec = recById(st.drawerId);
    if (!d) return;
    if (!rec) { closeDrawer(); return; }
    var pf = primaryField();
    var title = (pf && strVal(rec, pf)) || EMPTY_PRIMARY;
    var fmt = function (s) { try { return new Date(s).toLocaleString('ja-JP', { dateStyle: 'short', timeStyle: 'short' }); } catch (e) { return ''; } };
    var hid = cfg().hidden_field_ids;
    var shownF = st.fields.filter(function (f) { return f.is_primary || hid.indexOf(f.id) < 0; });
    var hiddenF = st.fields.filter(function (f) { return !f.is_primary && hid.indexOf(f.id) >= 0; });
    d.innerHTML = '<div class="tb-drawer-head"><span class="tb-drawer-title">' + h(title) + '</span>'
      + '<button class="tb-icon-btn" data-dw="close" title="閉じる（Esc）">' + ICO.close + '</button></div>'
      + '<div class="tb-drawer-body">' + shownF.map(function (f) { return fieldEditor(rec, f); }).join('')
      + (hiddenF.length ? '<div class="tb-drawer-sep">このビューで隠している列</div>' + hiddenF.map(function (f) { return fieldEditor(rec, f); }).join('') : '')
      + '</div>'
      + '<div class="tb-drawer-foot"><span>作成 ' + fmt(rec.created_at) + '　更新 ' + fmt(rec.updated_at) + '</span><span class="tb-spacer"></span>'
      + '<button class="tb-btn danger" data-dw="delete-row">行を削除</button></div>';
    d.querySelectorAll('[data-field-input]').forEach(function (inp) {
      var f = fieldById(inp.dataset.fieldInput);
      var ev = inp.type === 'checkbox' || inp.tagName === 'SELECT' || inp.type === 'date' ? 'change' : 'change';
      inp.addEventListener(ev, function () { saveFromDrawer(rec, f, inp); });
      if (inp.tagName === 'TEXTAREA') autoGrow(inp);
    });
    if (drawerFocus) {
      var target = d.querySelector('[data-field-input="' + drawerFocus + '"]');
      if (target) setTimeout(function () { target.focus(); }, 60);
      drawerFocus = null;
    }
  }

  function autoGrow(ta) {
    var fit = function () { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 420) + 'px'; };
    ta.addEventListener('input', fit); setTimeout(fit, 0);
  }

  function fieldEditor(rec, f) {
    var v = rawVal(rec, f);
    var sv = v == null ? '' : (typeof v === 'object' ? '' : String(v));
    var head = '<div class="tb-field-label"><span class="tb-type">' + typeOf(f).icon + '</span>' + h(f.name) + (f.is_primary ? '<span class="tb-guess">主列</span>' : '') + '</div>';
    var note = isMismatch(rec, f) ? '<div class="tb-field-note">' + h(typeOf(f).label) + 'として読めない値です。値はそのまま残しています。</div>' : '';
    var id = ' data-field-input="' + f.id + '"';
    var body;
    if (f.type === 'long_text') body = '<textarea class="tb-textarea"' + id + '>' + h(sv) + '</textarea>';
    else if (f.type === 'url' || f.type === 'email') {
      var ok = f.type === 'url' ? isUrl(sv) : isEmail(sv);
      var href = f.type === 'url' ? sv.trim() : 'mailto:' + sv.trim();
      body = '<div class="tb-url-row"><input class="tb-input" type="text"' + id + ' value="' + h(sv) + '">'
        + (sv && ok ? '<a class="tb-btn" href="' + h(href) + '"' + (f.type === 'url' ? ' target="_blank" rel="noopener noreferrer"' : '') + ' title="開く">' + ICO.ext + '</a>' : '') + '</div>';
    } else if (f.type === 'number') body = '<input class="tb-input" type="text" inputmode="decimal"' + id + ' value="' + h(sv) + '">';
    else if (f.type === 'date') body = isIsoDate(v) || v == null ? '<input class="tb-input" type="date"' + id + ' value="' + h(isIsoDate(v) ? v : '') + '" style="max-width:220px">' : '<input class="tb-input" type="text"' + id + ' value="' + h(sv) + '" placeholder="YYYY-MM-DD">';
    else if (f.type === 'checkbox') body = typeof v === 'boolean' || v == null ? '<label class="tb-check" style="margin:0"><input type="checkbox"' + id + (v === true ? ' checked' : '') + '> チェック</label>' : '<input class="tb-input" type="text"' + id + ' value="' + h(sv) + '">';
    else if (f.type === 'select') {
      body = '<select class="tb-select" style="width:100%"' + id + '><option value="">（なし）</option>'
        + choices(f).map(function (c) { return '<option value="' + h(c.id) + '"' + (v === c.id ? ' selected' : '') + '>' + h(c.name) + '</option>'; }).join('')
        + (v && !choiceById(f, v) ? '<option value="' + h(v) + '" selected>' + h(v) + '（選択肢にない値）</option>' : '') + '</select>';
    } else if (f.type === 'multi_select') {
      var arr = Array.isArray(v) ? v : [];
      body = '<div class="tb-chips">' + choices(f).map(function (c) {
        return '<button class="tb-chip' + (arr.indexOf(c.id) >= 0 ? ' on' : '') + '" data-dw="toggle-choice" data-fid="' + f.id + '" data-cid="' + h(c.id) + '">' + pill(c) + '</button>';
      }).join('') + (choices(f).length ? '' : '<span style="color:var(--text3);font-size:12.5px">選択肢がありません。列のメニューの「選択肢を編集」で作れます</span>') + '</div>';
    } else if (f.type === 'secret') {
      var k = key(rec.id, f.id);
      var has = !!st.hasSecret[k], shown = st.revealed[k] != null;
      if (st.editingSecret === k) {
        body = '<div class="tb-secret-box" style="padding:6px"><input class="tb-input" type="text" id="tb-secret-edit" autocomplete="off" spellcheck="false" style="border:none;background:none;padding:2px 4px">'
          + '<button class="tb-btn primary" data-dw="secret-save" data-fid="' + f.id + '">保存</button><button class="tb-btn" data-dw="secret-cancel">やめる</button></div>';
        setTimeout(function () { var i = document.getElementById('tb-secret-edit'); if (i) { i.value = st.revealed[k] != null ? st.revealed[k] : ''; i.focus(); } }, 0);
      } else {
        body = '<div class="tb-secret-box"><span class="tb-secret-val">'
          + (!has ? '<span style="color:var(--text3)">（未入力）</span>' : shown ? '<span class="tb-secret-plain">' + h(st.revealed[k]) + '</span>' : '<span class="tb-mask">••••••••••</span>') + '</span>'
          + (has ? '<button class="tb-icon-btn" data-dw="reveal" data-fid="' + f.id + '" title="' + (shown ? '隠す' : '表示') + '">' + (shown ? ICO.eyeOff : ICO.eye) + '</button>'
            + '<button class="tb-icon-btn" data-dw="copy" data-fid="' + f.id + '" title="コピー">' + ICO.copy + '</button>' : '')
          + '<button class="tb-icon-btn" data-dw="secret-edit" data-fid="' + f.id + '" title="書き換える">' + ICO.edit + '</button></div>';
      }
    } else body = '<input class="tb-input" type="text"' + id + ' value="' + h(sv) + '"' + (f.is_primary ? ' placeholder="' + EMPTY_PRIMARY + '"' : '') + '>';
    return '<div class="tb-field">' + head + body + note + '</div>';
  }

  async function saveFromDrawer(rec, f, inp) {
    var v;
    if (f.type === 'checkbox' && inp.type === 'checkbox') v = inp.checked ? true : undefined;
    else if (f.type === 'number') {
      v = parseNumber(inp.value);
      if (v === undefined) { say('数値として読めないので、元に戻しました'); inp.value = rawVal(rec, f) == null ? '' : String(rawVal(rec, f)); return; }
      if (v === null) v = undefined;
    } else if (f.type === 'date' && inp.type === 'text') {
      v = parseDate(inp.value);
      if (v === undefined) { say('日付として読めないので、元に戻しました'); inp.value = String(rawVal(rec, f) || ''); return; }
      if (v === null) v = undefined;
    } else if (f.type === 'checkbox') {
      var b = parseCheckbox(inp.value); v = b === undefined ? inp.value : (b || undefined);
    } else v = inp.value === '' ? undefined : inp.value;
    var before = rawVal(rec, f);
    if (JSON.stringify(before) === JSON.stringify(v)) return;
    await setValue(rec, f, v);
    if (f.is_primary || f.type === 'url' || f.type === 'email' || f.type === 'checkbox' || f.type === 'date') {
      var a = document.activeElement; if (!a || !a.closest || !a.closest('#tb-drawer') || inp.type === 'checkbox' || inp.tagName === 'SELECT') drawDrawer();
    }
  }

  async function onDrawerClick(e) {
    var a = e.target.closest('[data-dw]'); if (!a) return;
    var act = a.dataset.dw, rid = st.drawerId, fid = a.dataset.fid;
    if (act === 'close') return closeDrawer();
    if (act === 'delete-row') return deleteRow(rid);
    if (act === 'reveal') return toggleReveal(rid, fid);
    if (act === 'copy') return copySecret(rid, fid);
    if (act === 'toggle-choice') {
      var rec0 = recById(rid), f0 = fieldById(fid); if (!rec0 || !f0) return;
      var arr = Array.isArray(rawVal(rec0, f0)) ? rawVal(rec0, f0).slice() : [];
      var i = arr.indexOf(a.dataset.cid); if (i >= 0) arr.splice(i, 1); else arr.push(a.dataset.cid);
      await setValue(rec0, f0, arr); return drawDrawer();
    }
    if (act === 'secret-edit') {
      var k = key(rid, fid);
      if (st.hasSecret[k] && st.revealed[k] == null) { var p = await plainOf(rid, fid); if (p == null) return; st.revealed[k] = p; }
      else if (!(await unlock())) return;
      st.editingSecret = k; return drawDrawer();
    }
    if (act === 'secret-cancel') { st.editingSecret = null; return drawDrawer(); }
    if (act === 'secret-save') {
      var inp = document.getElementById('tb-secret-edit'); if (!inp) return;
      if (!(await unlock())) return;
      var val = inp.value;
      a.disabled = true;
      var ok = await saveSecret(rid, fid, val);
      if (ok) {
        var kk = key(rid, fid);
        if (val) st.revealed[kk] = val; else delete st.revealed[kk];
        var rec = recById(rid);
        if (rec) { rec.updated_at = nowIso(); SB().from('table_records').update({ updated_at: rec.updated_at }).eq('id', rid).then(function () {}); }
        st.editingSecret = null; refreshCell(rid, fid); drawDrawer(); say('保存しました（暗号化済み）');
      } else a.disabled = false;
    }
  }

  // ---------------------------------------------------------------------
  // メニューとパネル
  // ---------------------------------------------------------------------
  function closeMenu() { ['tb-menu', 'tb-panel'].forEach(function (id) { var m = document.getElementById(id); if (m) { if (m._off) document.removeEventListener('pointerdown', m._off, true); m.remove(); } }); }
  function place(m, anchor) {
    var r = anchor.getBoundingClientRect();
    var left = Math.min(r.left, window.innerWidth - m.offsetWidth - 8);
    var top = r.bottom + 4; if (top + m.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - m.offsetHeight - 4);
    m.style.left = Math.max(8, left) + 'px'; m.style.top = top + 'px';
  }
  function outsideClose(m) {
    setTimeout(function () {
      m._off = function (e) {
        if (m.contains(e.target)) return;
        if (e.target.closest && e.target.closest('.tb-overlay,.sm-overlay')) return;
        closeMenu();
      };
      document.addEventListener('pointerdown', m._off, true);
    }, 0);
  }
  function openMenu(anchor, html, onPick) {
    closeMenu();
    var m = document.createElement('div'); m.id = 'tb-menu'; m.className = 'tb-menu'; m.innerHTML = html;
    document.body.appendChild(m); place(m, anchor);
    m.addEventListener('click', function (e) { var b = e.target.closest('button[data-m]'); if (!b || b.disabled) return; closeMenu(); onPick(b.dataset.m, b); });
    outsideClose(m);
  }
  // 中を操作しても閉じないパネル（フィルタ・並べ替え・列の表示・選択肢のピッカー）
  function openPanel(anchor, build, extraClass) {
    closeMenu();
    var m = document.createElement('div'); m.id = 'tb-panel'; m.className = 'tb-menu tb-panel' + (extraClass ? ' ' + extraClass : '');
    document.body.appendChild(m);
    build(m, closeMenu);
    place(m, anchor);
    outsideClose(m);
    m._reflow = function () { place(m, anchor); };
    return m;
  }

  function colMenu(th) {
    var f = fieldById(th.dataset.fid); if (!f) return;
    var allowed = function (t) {
      if (t === f.type) return false;
      if (f.is_primary) return t === 'text';
      if (f.type === 'secret') return TEXTLIKE.indexOf(t) >= 0;
      if (t === 'secret') return TEXTLIKE.indexOf(f.type) >= 0;
      return true;
    };
    var types = ALL_TYPES.map(function (t) {
      return '<button data-m="type:' + t + '"' + (allowed(t) ? '' : ' disabled') + '><span class="tb-type">' + TYPES[t].icon + '</span>' + TYPES[t].label + (t === f.type ? '（いまの型）' : '') + '</button>';
    }).join('');
    var hasChoices = f.type === 'select' || f.type === 'multi_select';
    openMenu(th, '<button data-m="rename">' + ICO.edit + '名前を変更</button>'
      + (hasChoices ? '<button data-m="choices">' + TYPES.select.icon + '選択肢を編集</button>' : '')
      + '<button data-m="sort-asc"' + (f.type === 'secret' ? ' disabled' : '') + '>' + ICO.sortAsc + 'この列で昇順に並べる</button><button data-m="sort-desc"' + (f.type === 'secret' ? ' disabled' : '') + '>' + ICO.sortDesc + 'この列で降順に並べる</button>'
      + '<button data-m="filter">' + ICO.filter + 'この列でフィルタ</button>'
      + '<button data-m="hide"' + (f.is_primary ? ' disabled title="主列は隠せません"' : '') + '>' + ICO.hide + 'このビューで隠す</button>'
      + '<hr><div class="tb-menu-label">型を変更</div><div class="tb-menu-scroll">' + types + '</div>'
      + '<hr><button data-m="delete" class="danger"' + (f.is_primary ? ' disabled title="主列は消せません"' : '') + '>列を削除</button>',
      function (act) {
        if (act === 'rename') return renameField(f);
        if (act === 'choices') return choicesSheet(f);
        if (act === 'delete') return deleteField(f);
        if (act === 'hide') { cfg().hidden_field_ids.push(f.id); saveView(); return redrawGrid(); }
        if (act === 'filter') {
          var op = opsFor(f)[0][0];
          cfg().filters.conditions.push({ id: newId().slice(0, 8), fieldId: f.id, op: op, value: '' });
          saveView(); redrawGrid();
          var b = document.querySelector('[data-tb="filter"]'); if (b) filterPanel(b);
          return;
        }
        if (act === 'sort-asc' || act === 'sort-desc') { cfg().sorts = [{ fieldId: f.id, dir: act === 'sort-desc' ? 'desc' : 'asc' }]; saveView(); return redrawGrid(); }
        if (act.indexOf('type:') === 0) return changeType(f, act.slice(5));
      });
  }

  function tableMenu(btn) {
    openMenu(btn, '<button data-m="rename">' + ICO.edit + 'テーブル名を変更</button><hr><button data-m="delete" class="danger">テーブルを削除</button>', function (act) {
      var t = curTable(); if (!t) return;
      if (act === 'rename') {
        textSheet('テーブル名を変更', '', t.name, '変更する', async function (v) {
          var r = await SB().from('tables').update({ name: v, updated_at: nowIso() }).eq('id', t.id);
          if (r.error) return fail('renameTable', r.error);
          t.name = v; redrawGrid();
        });
      }
      if (act === 'delete') {
        var n = st.records.length;
        confirmSheet('テーブルを削除しますか？', '「' + t.name + '」と、その中の ' + n + ' 件の行（暗号化した値を含む）を削除します。元に戻せません。', '削除する', async function () {
          var r = await SB().from('tables').delete().eq('id', t.id);
          if (r.error) return fail('deleteTable', r.error);
          st.tableId = null; try { localStorage.removeItem('tb-last'); } catch (e) {}
          await loadTables(); draw(); say('「' + t.name + '」を削除しました');
        });
      }
    });
  }

  // ---- ビュー ----
  function viewMenu(btn) {
    var v = curView();
    openMenu(btn, '<div class="tb-menu-label">ビュー</div>'
      + st.views.map(function (x) { return '<button data-m="go:' + x.id + '">' + (x.id === st.viewId ? ICO.check : '<span style="width:14px;display:inline-block"></span>') + h(x.name) + '</button>'; }).join('')
      + '<hr><button data-m="new">＋ 新しいビュー</button><button data-m="dup">このビューを複製</button><button data-m="rename">' + ICO.edit + 'このビューの名前を変更</button>'
      + '<button data-m="delete" class="danger"' + (st.views.length <= 1 ? ' disabled title="ビューが1つのときは消せません"' : '') + '>このビューを削除</button>',
      function (act) {
        if (act.indexOf('go:') === 0) { st.viewId = act.slice(3); try { localStorage.setItem('tb-view-' + st.tableId, st.viewId); } catch (e) {} return redrawGrid(); }
        if (act === 'new' || act === 'dup') {
          textSheet(act === 'new' ? '新しいビュー' : 'ビューを複製', act === 'new' ? 'フィルタ・並べ替え・隠す列を、ビューごとに保存できます。' : '', act === 'new' ? '' : v.name + 'のコピー', '作る', async function (name) {
            var config = act === 'new' ? { filters: { conj: 'and', conditions: [] }, sorts: [], hidden_field_ids: [] } : JSON.parse(JSON.stringify(cfg()));
            var max = st.views.reduce(function (m, x) { return Math.max(m, x.sort_order || 0); }, 0);
            var r = await SB().from('table_views').insert({ table_id: st.tableId, name: name, type: 'grid', sort_order: max + 1, config: config }).select().single();
            if (r.error) { fail('newView', r.error); return; }
            st.views.push(r.data); st.viewId = r.data.id;
            try { localStorage.setItem('tb-view-' + st.tableId, st.viewId); } catch (e) {}
            redrawGrid();
          });
        }
        if (act === 'rename') {
          textSheet('ビューの名前を変更', '', v.name, '変更する', async function (name) {
            var r = await SB().from('table_views').update({ name: name, updated_at: nowIso() }).eq('id', v.id);
            if (r.error) { fail('renameView', r.error); return; }
            v.name = name; redrawGrid();
          });
        }
        if (act === 'delete') {
          confirmSheet('ビューを削除しますか？', '「' + v.name + '」を削除します。行と列は消えません。', '削除する', async function () {
            var r = await SB().from('table_views').delete().eq('id', v.id);
            if (r.error) return fail('deleteView', r.error);
            st.views = st.views.filter(function (x) { return x.id !== v.id; });
            st.viewId = st.views[0].id; redrawGrid(); say('ビュー「' + v.name + '」を削除しました');
          });
        }
      });
  }

  // ---- フィルタ ----
  function filterPanel(btn) {
    openPanel(btn, function (panel) {
      var paint = function () {
        var c = cfg();
        var conds = c.filters.conditions.filter(function (x) { return fieldById(x.fieldId); });
        panel.innerHTML = '<div class="tb-panel-head">フィルタ<span class="tb-spacer"></span>'
          + (conds.length > 1 ? '<select class="tb-select" data-k="conj"><option value="and"' + (c.filters.conj !== 'or' ? ' selected' : '') + '>すべてに一致</option><option value="or"' + (c.filters.conj === 'or' ? ' selected' : '') + '>いずれかに一致</option></select>' : '')
          + '</div>'
          + (conds.length ? conds.map(function (x) { return condRow(x); }).join('') : '<div class="tb-pick-empty">条件はまだありません。条件に合う行だけを表示できます</div>')
          + '<div class="tb-panel-foot"><button class="tb-btn" data-k="add">＋ 条件を追加</button>' + (conds.length ? '<button class="tb-btn" data-k="clear">すべて外す</button>' : '') + '</div>';
        if (panel._reflow) panel._reflow();
      };
      var condRow = function (x) {
        var f = fieldById(x.fieldId);
        var ops = opsFor(f);
        var valHtml = '';
        if (NO_VALUE_OPS.indexOf(x.op) < 0) {
          if (f.type === 'select' || f.type === 'multi_select') valHtml = '<select class="tb-select" data-k="value"><option value="">選んでください</option>' + choices(f).map(function (c) { return '<option value="' + h(c.id) + '"' + (x.value === c.id ? ' selected' : '') + '>' + h(c.name) + '</option>'; }).join('') + '</select>';
          else if (f.type === 'date') valHtml = '<input class="tb-input" type="date" data-k="value" value="' + h(x.value || '') + '">';
          else valHtml = '<input class="tb-input" type="text" data-k="value"' + (f.type === 'number' ? ' inputmode="decimal"' : '') + ' value="' + h(x.value || '') + '" placeholder="値">';
        }
        return '<div class="tb-cond" data-cid="' + h(x.id) + '">'
          + '<select class="tb-select" data-k="field">' + st.fields.map(function (ff) { return '<option value="' + ff.id + '"' + (ff.id === f.id ? ' selected' : '') + '>' + h(ff.name) + '</option>'; }).join('') + '</select>'
          + '<select class="tb-select" data-k="op">' + ops.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === x.op ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('') + '</select>'
          + '<span class="tb-cond-val">' + valHtml + '</span>'
          + '<button class="tb-icon-btn" data-k="del" title="この条件を外す">' + ICO.x + '</button></div>';
      };
      var apply = function () { saveView(); refreshBody(); updateBarBadges(); };
      panel.addEventListener('change', function (e) {
        var c = cfg(); var t = e.target; var row = t.closest('.tb-cond');
        if (t.dataset.k === 'conj') { c.filters.conj = t.value; apply(); return; }
        if (!row) return;
        var x = c.filters.conditions.find(function (y) { return y.id === row.dataset.cid; }); if (!x) return;
        if (t.dataset.k === 'field') { x.fieldId = t.value; x.op = opsFor(fieldById(t.value))[0][0]; x.value = ''; apply(); paint(); }
        else if (t.dataset.k === 'op') { x.op = t.value; if (NO_VALUE_OPS.indexOf(x.op) >= 0) x.value = ''; apply(); paint(); }
        else if (t.dataset.k === 'value') { x.value = t.value; apply(); }
      });
      var tm = null;
      panel.addEventListener('input', function (e) {
        var t = e.target; if (t.dataset.k !== 'value' || t.tagName !== 'INPUT' || t.type === 'date') return;
        var row = t.closest('.tb-cond'); var x = cfg().filters.conditions.find(function (y) { return y.id === row.dataset.cid; }); if (!x) return;
        x.value = t.value; clearTimeout(tm); tm = setTimeout(apply, 200);
      });
      panel.addEventListener('click', function (e) {
        var b = e.target.closest('[data-k]'); if (!b || b.tagName === 'SELECT' || b.tagName === 'INPUT') return;
        var c = cfg();
        if (b.dataset.k === 'add') {
          var pf = primaryField();
          c.filters.conditions.push({ id: newId().slice(0, 8), fieldId: pf.id, op: opsFor(pf)[0][0], value: '' });
          paint(); saveView();
          var vs = panel.querySelectorAll('[data-k="value"]'); if (vs.length) vs[vs.length - 1].focus();
        } else if (b.dataset.k === 'clear') { c.filters.conditions = []; apply(); paint(); }
        else if (b.dataset.k === 'del') { var row = b.closest('.tb-cond'); c.filters.conditions = c.filters.conditions.filter(function (y) { return y.id !== row.dataset.cid; }); apply(); paint(); }
      });
      paint();
      if (!cfg().filters.conditions.length) panel.querySelector('[data-k="add"]').click();
    }, 'tb-panel-wide');
  }

  // ---- 並べ替え ----
  function sortPanel(btn) {
    openPanel(btn, function (panel) {
      var sortable = st.fields.filter(function (f) { return f.type !== 'secret'; });
      var paint = function () {
        var c = cfg();
        c.sorts = c.sorts.filter(function (s) { return fieldById(s.fieldId); });
        panel.innerHTML = '<div class="tb-panel-head">並べ替え</div>'
          + (c.sorts.length ? c.sorts.map(function (s, i) {
            return '<div class="tb-cond" data-i="' + i + '"><span class="tb-sort-n">' + (i === 0 ? '並べ順' : '次に') + '</span>'
              + '<select class="tb-select" data-k="field">' + sortable.map(function (f) { return '<option value="' + f.id + '"' + (f.id === s.fieldId ? ' selected' : '') + '>' + h(f.name) + '</option>'; }).join('') + '</select>'
              + '<select class="tb-select" data-k="dir"><option value="asc"' + (s.dir !== 'desc' ? ' selected' : '') + '>昇順（A→Z・小→大・古→新）</option><option value="desc"' + (s.dir === 'desc' ? ' selected' : '') + '>降順（Z→A・大→小・新→古）</option></select>'
              + '<button class="tb-icon-btn" data-k="del" title="外す">' + ICO.x + '</button></div>';
          }).join('') : '<div class="tb-pick-empty">並べ替えていません（追加した順）</div>')
          + '<div class="tb-panel-foot"><button class="tb-btn" data-k="add"' + (c.sorts.length >= 3 ? ' disabled' : '') + '>＋ 並べ替えを追加</button>' + (c.sorts.length ? '<button class="tb-btn" data-k="clear">すべて外す</button>' : '') + '</div>';
        if (panel._reflow) panel._reflow();
      };
      var apply = function () { saveView(); refreshBody(); updateBarBadges(); refreshHeadMarks(); };
      panel.addEventListener('change', function (e) {
        var row = e.target.closest('.tb-cond'); if (!row) return;
        var s = cfg().sorts[+row.dataset.i];
        if (e.target.dataset.k === 'field') s.fieldId = e.target.value; else s.dir = e.target.value;
        apply();
      });
      panel.addEventListener('click', function (e) {
        var b = e.target.closest('[data-k]'); if (!b || b.tagName === 'SELECT' || b.disabled) return;
        var c = cfg();
        if (b.dataset.k === 'add') { var used = c.sorts.map(function (s) { return s.fieldId; }); var f = sortable.find(function (x) { return used.indexOf(x.id) < 0; }) || sortable[0]; c.sorts.push({ fieldId: f.id, dir: 'asc' }); }
        else if (b.dataset.k === 'clear') c.sorts = [];
        else if (b.dataset.k === 'del') c.sorts.splice(+b.closest('.tb-cond').dataset.i, 1);
        apply(); paint();
      });
      paint();
    }, 'tb-panel-wide');
  }

  // ---- 列の表示 ----
  function hidePanel(btn) {
    openPanel(btn, function (panel) {
      var paint = function () {
        var hid = cfg().hidden_field_ids;
        panel.innerHTML = '<div class="tb-panel-head">このビューで表示する列<span class="tb-spacer"></span><button class="tb-link-btn" data-k="all">すべて表示</button></div>'
          + st.fields.map(function (f) {
            return '<label class="tb-check tb-hide-row"><input type="checkbox" data-fid="' + f.id + '"' + (f.is_primary || hid.indexOf(f.id) < 0 ? ' checked' : '') + (f.is_primary ? ' disabled' : '') + '><span class="tb-type">' + typeOf(f).icon + '</span>' + h(f.name) + (f.is_primary ? '<span class="tb-guess">主列</span>' : '') + '</label>';
          }).join('');
      };
      panel.addEventListener('change', function (e) {
        var fid = e.target.dataset.fid; if (!fid) return;
        var c = cfg();
        c.hidden_field_ids = c.hidden_field_ids.filter(function (x) { return x !== fid; });
        if (!e.target.checked) c.hidden_field_ids.push(fid);
        saveView(); redrawGrid(); var b = document.querySelector('[data-tb="hide"]'); if (b) hidePanel(b);
      });
      panel.addEventListener('click', function (e) {
        if (e.target.closest('[data-k="all"]')) { cfg().hidden_field_ids = []; saveView(); redrawGrid(); var b = document.querySelector('[data-tb="hide"]'); if (b) hidePanel(b); }
      });
      paint();
    });
  }

  function updateBarBadges() {
    var c = cfg();
    var set = function (sel, n) {
      var b = document.querySelector(sel); if (!b) return;
      b.classList.toggle('on', n > 0);
      var badge = b.querySelector('.tb-badge');
      if (n > 0) { if (!badge) { badge = document.createElement('b'); badge.className = 'tb-badge'; b.appendChild(badge); } badge.textContent = n; }
      else if (badge) badge.remove();
    };
    set('[data-tb="filter"]', activeConds().length);
    set('[data-tb="sort"]', c.sorts.length);
    refreshHeadMarks();
  }
  function refreshHeadMarks() {
    var sortMap = {}; cfg().sorts.forEach(function (s) { sortMap[s.fieldId] = s.dir; });
    var filtered = {}; activeConds().forEach(function (c) { filtered[c.fieldId] = true; });
    document.querySelectorAll('.tb-grid thead th.tb-th').forEach(function (th) {
      var inner = th.querySelector('.tb-th-inner'); if (!inner) return;
      inner.querySelectorAll('.tb-th-mark').forEach(function (x) { x.remove(); });
      var fid = th.dataset.fid;
      if (filtered[fid]) inner.insertAdjacentHTML('beforeend', '<span class="tb-th-mark" title="フィルタ中">' + ICO.filter + '</span>');
      if (sortMap[fid]) inner.insertAdjacentHTML('beforeend', '<span class="tb-th-mark" title="並べ替え中">' + (sortMap[fid] === 'desc' ? ICO.sortDesc : ICO.sortAsc) + '</span>');
    });
  }

  // ---- 列：名前・選択肢・型・削除・幅 ----
  function renameField(f) {
    textSheet('列の名前を変更', '', f.name, '変更する', async function (v) {
      if (st.fields.some(function (x) { return x !== f && x.name === v; })) return '同じ名前の列があります';
      var r = await SB().from('table_fields').update({ name: v, updated_at: nowIso() }).eq('id', f.id);
      if (r.error) { fail('renameField', r.error); return; }
      f.name = v; redrawGrid();
    });
  }

  function choicesSheet(f) {
    var work = choices(f).map(function (c) { return Object.assign({}, c); });
    var s = openSheet('<h3>選択肢を編集：' + h(f.name) + '</h3><p class="tb-lead">名前を変えると、その選択肢を選んでいる行の表示もすべて変わります。</p><div id="tb-ch-list"></div>'
      + '<button class="tb-btn" data-x="add" style="margin-top:8px">＋ 選択肢を追加</button><div class="tb-err" id="tb-ch-err"></div>'
      + '<div class="tb-actions"><button class="tb-btn" data-x="cancel">やめる</button><button class="tb-btn primary" data-x="ok">保存する</button></div>');
    var used = function (cid) { return st.records.filter(function (r) { var v = rawVal(r, f); return Array.isArray(v) ? v.indexOf(cid) >= 0 : v === cid; }).length; };
    var paint = function () {
      s.el.querySelector('#tb-ch-list').innerHTML = work.map(function (c, i) {
        return '<div class="tb-ch-row" data-i="' + i + '"><select class="tb-select tb-ch-color c-' + h(c.color) + '" data-k="color">' + COLOR_KEYS.map(function (k) { return '<option value="' + k + '"' + (c.color === k ? ' selected' : '') + '>' + COLORS[k] + '</option>'; }).join('') + '</select>'
          + '<input class="tb-input" data-k="name" value="' + h(c.name) + '"><span class="tb-ch-used">' + (c.id ? used(c.id) + '件' : '新規') + '</span>'
          + '<button class="tb-icon-btn" data-k="del" title="この選択肢を消す">' + ICO.x + '</button></div>';
      }).join('') || '<div class="tb-pick-empty">選択肢はありません</div>';
    };
    paint();
    s.el.addEventListener('input', function (e) { var row = e.target.closest('.tb-ch-row'); if (row && e.target.dataset.k === 'name') work[+row.dataset.i].name = e.target.value; });
    s.el.addEventListener('change', function (e) { var row = e.target.closest('.tb-ch-row'); if (row && e.target.dataset.k === 'color') { work[+row.dataset.i].color = e.target.value; paint(); } });
    s.el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-k="del"]'); if (b) { work.splice(+b.closest('.tb-ch-row').dataset.i, 1); paint(); }
    });
    s.el.querySelector('[data-x="add"]').onclick = function () { var tmp = { id: '', name: '', color: COLOR_KEYS[work.length % COLOR_KEYS.length] }; work.push(tmp); paint(); var ins = s.el.querySelectorAll('.tb-ch-row input'); if (ins.length) ins[ins.length - 1].focus(); };
    s.el.querySelector('[data-x="cancel"]').onclick = s.close;
    s.el.querySelector('[data-x="ok"]').onclick = async function () {
      var err = s.el.querySelector('#tb-ch-err');
      work = work.map(function (c) { return Object.assign(c, { name: c.name.trim() }); });
      if (work.some(function (c) { return !c.name; })) { err.textContent = '名前が空の選択肢があります'; return; }
      var names = work.map(function (c) { return c.name; });
      if (names.length !== new Set(names).size) { err.textContent = '同じ名前の選択肢があります'; return; }
      var keep = work.filter(function (c) { return c.id; }).map(function (c) { return c.id; });
      var removed = choices(f).filter(function (c) { return keep.indexOf(c.id) < 0; });
      var affected = st.records.filter(function (r) { var v = rawVal(r, f); return removed.some(function (c) { return Array.isArray(v) ? v.indexOf(c.id) >= 0 : v === c.id; }); });
      if (affected.length && !confirm('消す選択肢を選んでいる ' + affected.length + ' 件の行から、その選択を外します。よろしいですか？')) return;
      work.forEach(function (c) { if (!c.id) c.id = newId().slice(0, 8); });
      var beforeOpts = f.options;
      f.options = Object.assign({}, f.options || {}, { choices: work });
      if (!(await saveFieldOptions(f))) { f.options = beforeOpts; return; }
      if (affected.length) {
        var rmIds = removed.map(function (c) { return c.id; });
        affected.forEach(function (r) {
          r.values = Object.assign({}, r.values);
          var v = r.values[f.id];
          if (Array.isArray(v)) { v = v.filter(function (id) { return rmIds.indexOf(id) < 0; }); if (v.length) r.values[f.id] = v; else delete r.values[f.id]; }
          else delete r.values[f.id];
        });
        try { await upsertRecords(affected); } catch (e2) { fail('choices', e2); }
      }
      // 消した選択肢を指していたフィルタ条件も外す
      st.views.forEach(function (v) { var c = v.config || {}; if (c.filters && c.filters.conditions) c.filters.conditions = c.filters.conditions.filter(function (x) { return x.fieldId !== f.id || !x.value || keep.indexOf(x.value) >= 0 || work.some(function (w) { return w.id === x.value; }); }); });
      await saveAllViews();
      s.close(); redrawGrid(); say('選択肢を保存しました');
    };
  }

  async function changeType(f, to) {
    var from = f.type;
    if (from === to) return;
    if (to === 'secret') return toSecret(f);
    if (from === 'secret') return fromSecret(f, to);
    // 文字列を経由して変える。選択↔複数選択は選択肢をそのまま使う。型に合わない値は元の文字列のまま残す
    var target = { id: f.id, type: to, options: (to === 'select' || to === 'multi_select') ? { choices: (from === 'select' || from === 'multi_select') ? choices(f).slice() : [] } : {} };
    var changes = [], warns = 0;
    st.records.forEach(function (r) {
      if (isEmptyVal(r, f)) return;
      var v = rawVal(r, f), nv;
      if ((from === 'select' || from === 'multi_select') && (to === 'select' || to === 'multi_select') && !isMismatch(r, f)) {
        var ids = Array.isArray(v) ? v : [v];
        nv = to === 'multi_select' ? ids : ids[0];
      } else {
        var res = fromString(strVal(r, f), target);
        nv = res.value; if (res.warn) warns++;
      }
      changes.push({ r: r, v: nv });
    });
    var lost = (from === 'multi_select' && to === 'select') ? st.records.filter(function (r) { var v = rawVal(r, f); return Array.isArray(v) && v.length > 1; }).length : 0;
    var body = '「' + f.name + '」を' + TYPES[from].label + 'から' + TYPES[to].label + 'に変えます。値のある ' + changes.length + ' 件を変換します。'
      + (warns ? warns + ' 件は形式が合わないため、元の文字のまま残します（黄色の印で出ます）。' : '')
      + (lost ? '複数を選んでいる ' + lost + ' 件は、先頭の1つだけが残ります。' : '');
    confirmSheet('列の型を変えますか？', body, '変える', async function () {
      await progressRun('型を変えています', changes.length, async function (tick) {
        changes.forEach(function (x, i) { x.r.values = Object.assign({}, x.r.values); if (x.v === undefined) delete x.r.values[f.id]; else x.r.values[f.id] = x.v; tick(i + 1); });
        await upsertRecords(changes.map(function (x) { return x.r; }));
        var up = await SB().from('table_fields').update({ type: to, options: target.options, updated_at: nowIso() }).eq('id', f.id);
        if (up.error) throw up.error;
        f.type = to; f.options = target.options;
        dropFieldFromViews(f.id, true);
        if (to === 'secret' || from === 'secret') dropFieldFromViews(f.id);
        await saveAllViews();
      });
      redrawGrid(); say('「' + f.name + '」を' + TYPES[to].label + 'にしました');
    });
  }

  function toSecret(f) {
    var withVal = st.records.filter(function (x) { return strVal(x, f) !== ''; });
    confirmSheet('シークレット（暗号化）に変えますか？', '「' + f.name + '」の ' + withVal.length + ' 件の値を暗号化し、平文を消します。検索・並べ替え・フィルタ（空かどうか以外）の対象から外れます。', '暗号化する', async function () {
      if (!(await unlock())) return;
      await progressRun('暗号化しています', withVal.length, async function (tick) {
        var rows = [];
        for (var i = 0; i < withVal.length; i++) { rows.push({ record_id: withVal[i].id, field_id: f.id, cipher: await window.SecretMemo.encryptText(strVal(withVal[i], f)), updated_at: nowIso() }); tick(i + 1); }
        for (var j = 0; j < rows.length; j += 200) { var ins = await SB().from('table_record_secrets').upsert(rows.slice(j, j + 200), { onConflict: 'record_id,field_id' }); if (ins.error) throw ins.error; }
        var up = await SB().from('table_fields').update({ type: 'secret', options: {}, updated_at: nowIso() }).eq('id', f.id); if (up.error) throw up.error;
        // 暗号文が入ったのを確かめてから平文を消す
        withVal.forEach(function (x) { x.values = Object.assign({}, x.values); delete x.values[f.id]; });
        await upsertRecords(withVal);
        withVal.forEach(function (x) { st.hasSecret[key(x.id, f.id)] = true; });
        f.type = 'secret'; f.options = {};
        dropFieldFromViews(f.id, true);
        st.views.forEach(function (v) { var c = v.config || {}; if (c.sorts) c.sorts = c.sorts.filter(function (s) { return s.fieldId !== f.id; }); });
        await saveAllViews();
      });
      redrawGrid(); say('「' + f.name + '」を暗号化しました');
    });
  }

  function fromSecret(f, to) {
    var n = st.records.filter(function (x) { return st.hasSecret[key(x.id, f.id)]; }).length;
    confirmSheet('暗号化を外しますか？', '「' + f.name + '」の ' + n + ' 件を復号し、平文で保存し直します。DB とバックアップに平文が残るようになります。パスワードなどは暗号化のまま置くことをおすすめします。', '暗号化を外す', async function () {
      if (!(await unlock())) return;
      var targets = st.records.filter(function (x) { return st.hasSecret[key(x.id, f.id)]; });
      await progressRun('復号しています', targets.length, async function (tick) {
        var cs = await secretsOf('record_id,cipher', [f.id]);
        var map = {}; cs.forEach(function (x) { map[x.record_id] = x.cipher; });
        for (var i = 0; i < targets.length; i++) {
          var p = map[targets[i].id] ? await window.SecretMemo.decryptText(map[targets[i].id]) : '';
          targets[i].values = Object.assign({}, targets[i].values); if (p) targets[i].values[f.id] = p;
          tick(i + 1);
        }
        await upsertRecords(targets);
        var up = await SB().from('table_fields').update({ type: to, updated_at: nowIso() }).eq('id', f.id); if (up.error) throw up.error;
        var del = await SB().from('table_record_secrets').delete().eq('field_id', f.id); if (del.error) throw del.error;
        targets.forEach(function (r) { delete st.hasSecret[key(r.id, f.id)]; delete st.revealed[key(r.id, f.id)]; });
        f.type = to;
        dropFieldFromViews(f.id, true); await saveAllViews();
      });
      redrawGrid(); say('「' + f.name + '」の暗号化を外しました');
    });
  }

  async function deleteField(f) {
    if (f.is_primary) return;
    var withVal = st.records.filter(function (x) { return !isEmptyVal(x, f); }).length;
    confirmSheet('列を削除しますか？', '「' + f.name + '」と、その列の ' + withVal + ' 件の値を削除します。直後なら「Undo」で元に戻せます。', '削除する', async function () {
      // 元に戻せるよう控える（シークレットは暗号文のまま。ビューの設定も）
      var saved = { field: JSON.parse(JSON.stringify(f)), values: {}, secrets: [], views: JSON.parse(JSON.stringify(st.views.map(function (v) { return { id: v.id, config: v.config }; }))) };
      st.records.forEach(function (x) { if (x.values && f.id in x.values) saved.values[x.id] = x.values[f.id]; });
      if (f.type === 'secret') {
        try { saved.secrets = await secretsOf('record_id,field_id,cipher', [f.id]); } catch (e) { return fail('deleteField', e); }
      }
      var r = await SB().from('table_fields').delete().eq('id', f.id);
      if (r.error) return fail('deleteField', r.error);
      st.fields = st.fields.filter(function (x) { return x.id !== f.id; });
      var touched = st.records.filter(function (x) { return x.values && f.id in x.values; });
      touched.forEach(function (x) { x.values = Object.assign({}, x.values); delete x.values[f.id]; });
      dropFieldFromViews(f.id); saveAllViews();
      redrawGrid();
      // values に残ったキーを掃除する（表示には影響しないが、書き出しや容量のため）
      try { await upsertRecords(touched); } catch (e3) { fail('deleteField', e3); }
      say('列「' + f.name + '」を削除しました', async function () {
        var fr = saved.field;
        var ins = await SB().from('table_fields').insert({ id: fr.id, table_id: fr.table_id, name: fr.name, type: fr.type, options: fr.options, is_primary: false, is_required: fr.is_required, sort_order: fr.sort_order, width: fr.width });
        if (ins.error) return fail('undoDeleteField', ins.error);
        var back = [];
        st.records.forEach(function (x) { if (x.id in saved.values) { x.values = Object.assign({}, x.values); x.values[fr.id] = saved.values[x.id]; back.push(x); } });
        try { await upsertRecords(back); } catch (e4) { return fail('undoDeleteField', e4); }
        for (var k3 = 0; k3 < saved.secrets.length; k3 += 200) { var u3 = await SB().from('table_record_secrets').insert(saved.secrets.slice(k3, k3 + 200)); if (u3.error) return fail('undoDeleteField', u3.error); }
        saved.secrets.forEach(function (x) { st.hasSecret[key(x.record_id, x.field_id)] = true; });
        saved.views.forEach(function (sv) { var v = st.views.find(function (x) { return x.id === sv.id; }); if (v) v.config = sv.config; });
        await saveAllViews();
        st.fields = sortFields(st.fields.concat([fr]));
        redrawGrid(); say('元に戻しました');
      });
    });
  }

  function onResizeStart(e) {
    var hdl = e.target.closest('.tb-resize'); if (!hdl) return;
    e.preventDefault(); e.stopPropagation();
    var f = fieldById(hdl.dataset.fid); if (!f) return;
    var col = document.querySelector('.tb-grid col[data-fid="' + f.id + '"]');
    var table = document.querySelector('.tb-grid');
    var startX = e.clientX, startW = f.width || 200, baseTotal = table ? table.offsetWidth - startW : 0;
    hdl.classList.add('on');
    var move = function (ev) {
      var w = Math.max(80, Math.min(800, startW + ev.clientX - startX));
      f.width = w; if (col) col.style.width = w + 'px'; if (table) table.style.width = (baseTotal + w) + 'px';
    };
    var up = async function () {
      document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up);
      hdl.classList.remove('on');
      if (f.width !== startW) { var r = await SB().from('table_fields').update({ width: f.width }).eq('id', f.id); if (r.error) fail('resize', r.error); }
    };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
  }

  // ---------------------------------------------------------------------
  // シート（モーダル）
  // ---------------------------------------------------------------------
  function openSheet(html, wide) {
    closeMenu();
    var ov = document.createElement('div'); ov.className = 'tb-overlay';
    ov.innerHTML = '<div class="tb-sheet' + (wide ? ' wide' : '') + '" role="dialog">' + html + '</div>';
    document.body.appendChild(ov);
    var close = function () { ov.remove(); document.removeEventListener('keydown', esc, true); };
    var esc = function (e) { if (e.key === 'Escape' && !ov.dataset.busy) { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', esc, true);
    ov.addEventListener('click', function (e) { if (e.target === ov && !ov.dataset.busy) close(); });
    return { el: ov.firstChild, close: close, ov: ov };
  }

  function textSheet(title, lead, value, okLabel, onOk) {
    var s = openSheet('<h3>' + h(title) + '</h3>' + (lead ? '<p class="tb-lead">' + lead + '</p>' : '')
      + '<input class="tb-input" id="tb-ts-in" type="text"><div class="tb-err" id="tb-ts-err"></div>'
      + '<div class="tb-actions"><button class="tb-btn" data-x="cancel">やめる</button><button class="tb-btn primary" data-x="ok">' + h(okLabel) + '</button></div>');
    var inp = s.el.querySelector('#tb-ts-in'); inp.value = value || ''; setTimeout(function () { inp.focus(); inp.select(); }, 30);
    var go = async function () {
      var v = inp.value.trim(); if (!v) { s.el.querySelector('#tb-ts-err').textContent = '入力してください'; return; }
      var msg = await onOk(v);
      if (typeof msg === 'string') { s.el.querySelector('#tb-ts-err').textContent = msg; return; }
      s.close();
    };
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) go(); });
    s.el.querySelector('[data-x="ok"]').onclick = go;
    s.el.querySelector('[data-x="cancel"]').onclick = s.close;
  }

  function confirmSheet(title, body, okLabel, onOk) {
    var s = openSheet('<h3>' + h(title) + '</h3><p class="tb-lead">' + h(body) + '</p>'
      + '<div class="tb-actions"><button class="tb-btn" data-x="cancel">やめる</button><button class="tb-btn primary" data-x="ok">' + h(okLabel) + '</button></div>');
    s.el.querySelector('[data-x="cancel"]').onclick = s.close;
    s.el.querySelector('[data-x="ok"]').onclick = function () { s.close(); onOk(); };
  }

  async function progressRun(label, total, fn) {
    var s = openSheet('<h3>' + h(label) + '</h3><p class="tb-lead" id="tb-pr-txt">0 / ' + total + '</p><div class="tb-progress"><i id="tb-pr-bar"></i></div>');
    s.ov.dataset.busy = '1';
    var tick = function (n) {
      var t = s.el.querySelector('#tb-pr-txt'), b = s.el.querySelector('#tb-pr-bar');
      if (t) t.textContent = n + ' / ' + total; if (b) b.style.width = (total ? n / total * 100 : 100) + '%';
    };
    try { await fn(tick); }
    catch (e) { console.error('tables:progress', e && (e.code || e.message)); say('⚠ 途中で失敗しました。画面を読み込み直して状態を確かめてください'); }
    finally { s.close(); }
  }

  function newTableSheet() {
    var s = openSheet('<h3>新しいテーブル</h3><p class="tb-lead">先頭の列（主列）は、行を見分ける名前の列です。あとから列を足したり、CSV を取り込んだりできます。</p>'
      + '<label class="tb-lbl">テーブル名</label><input class="tb-input" id="tb-nt-name" type="text" placeholder="例：取引先リスト">'
      + '<label class="tb-lbl">主列の名前</label><input class="tb-input" id="tb-nt-pri" type="text" value="名称">'
      + '<div class="tb-err" id="tb-nt-err"></div>'
      + '<div class="tb-actions"><button class="tb-btn" data-x="cancel">やめる</button><button class="tb-btn primary" data-x="ok">作る</button></div>');
    var nm = s.el.querySelector('#tb-nt-name'), pr = s.el.querySelector('#tb-nt-pri');
    setTimeout(function () { nm.focus(); }, 30);
    s.el.querySelector('[data-x="cancel"]').onclick = s.close;
    var go = async function () {
      var name = nm.value.trim(), pri = pr.value.trim() || '名称';
      if (!name) { s.el.querySelector('#tb-nt-err').textContent = 'テーブル名を入れてください'; return; }
      var id = newId();
      var max = (st.tables || []).reduce(function (m, t) { return Math.max(m, t.sort_order || 0); }, 0);
      var r = await SB().from('tables').insert({ id: id, name: name, sort_order: max + 1 });
      if (r.error) return fail('newTable', r.error);
      var f = await SB().from('table_fields').insert({ table_id: id, name: pri, type: 'text', is_primary: true, is_required: true, sort_order: 0, width: 240 });
      if (f.error) return fail('newTable', f.error);
      s.close();
      await loadTables();
      openTable(id);
    };
    s.el.querySelector('[data-x="ok"]').onclick = go;
    nm.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) go(); });
  }

  function typeOptions(selected, guess) {
    return ALL_TYPES.map(function (t) { return '<option value="' + t + '"' + (selected === t ? ' selected' : '') + '>' + TYPES[t].label + (guess === t ? '（推定）' : '') + '</option>'; }).join('');
  }

  function addColSheet() {
    var s = openSheet('<h3>列を追加</h3>'
      + '<label class="tb-lbl">列の名前</label><input class="tb-input" id="tb-ac-name" type="text">'
      + '<label class="tb-lbl">型</label><select class="tb-select" id="tb-ac-type" style="width:100%">' + typeOptions('text') + '</select>'
      + '<p class="tb-lead" id="tb-ac-help" style="margin-top:8px"></p>'
      + '<div class="tb-err" id="tb-ac-err"></div>'
      + '<div class="tb-actions"><button class="tb-btn" data-x="cancel">やめる</button><button class="tb-btn primary" data-x="ok">追加する</button></div>');
    var HELP = {
      text: '1行の文字。名前・ID・短いメモなど。', long_text: '改行を含む長い文。一覧では1行目だけを出し、詳細パネルで全文を書きます。',
      number: '数値。並べ替えとフィルタで大小を比べられます。', date: '日付。カレンダーから選べます。', checkbox: '済み／未済みなどの印。セルを押すと切り替わります。',
      select: '決まった選択肢から1つ選ぶ。選択肢は選ぶときにその場で作れます。', multi_select: '決まった選択肢から複数選ぶ。タグのような使い方です。',
      url: 'Web のアドレス。押すと別タブで開きます。', email: 'メールアドレス。押すとメールソフトが開きます。',
      secret: 'パスワードなど人に見せたくない値。ブラウザの中で暗号化して保存し、一覧では伏せ字で出します。'
    };
    var nm = s.el.querySelector('#tb-ac-name'), ty = s.el.querySelector('#tb-ac-type'), help = s.el.querySelector('#tb-ac-help');
    var upd = function () { help.textContent = HELP[ty.value] || ''; }; ty.addEventListener('change', upd); upd();
    setTimeout(function () { nm.focus(); }, 30);
    s.el.querySelector('[data-x="cancel"]').onclick = s.close;
    var go = async function () {
      var name = nm.value.trim(), type = ty.value;
      if (!name) { s.el.querySelector('#tb-ac-err').textContent = '列の名前を入れてください'; return; }
      if (st.fields.some(function (x) { return x.name === name; })) { s.el.querySelector('#tb-ac-err').textContent = '同じ名前の列があります'; return; }
      var f = await createField(name, type);
      if (!f) return;
      s.close(); redrawGrid();
      var sc = document.getElementById('tb-scroll'); if (sc) sc.scrollLeft = sc.scrollWidth;
    };
    s.el.querySelector('[data-x="ok"]').onclick = go;
    nm.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) go(); });
  }

  async function createField(name, type, options) {
    var max = st.fields.reduce(function (m, f) { return Math.max(m, f.sort_order || 0); }, 0);
    var width = { long_text: 280, checkbox: 110, number: 140, date: 150, select: 170, multi_select: 240 }[type] || 200;
    var row = { id: newId(), table_id: st.tableId, name: name, type: type, sort_order: max + 1, width: width, is_primary: false, is_required: false, options: options || ((type === 'select' || type === 'multi_select') ? { choices: [] } : {}) };
    var r = await SB().from('table_fields').insert(row).select().single();
    if (r.error) { fail('createField', r.error); return null; }
    st.fields = sortFields(st.fields.concat([r.data]));
    return r.data;
  }

  // ---------------------------------------------------------------------
  // CSV
  // ---------------------------------------------------------------------
  function parseCsv(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    var rows = [], row = [], cell = '', q = false, i = 0, n = text.length;
    while (i < n) {
      var c = text[i];
      if (q) {
        if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i += 2; continue; } q = false; i++; continue; }
        cell += c; i++; continue;
      }
      if (c === '"') { q = true; i++; continue; }
      if (c === ',') { row.push(cell); cell = ''; i++; continue; }
      if (c === '\r') { i++; continue; }
      if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; continue; }
      cell += c; i++;
    }
    if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
    // 末尾の空行を落とす
    while (rows.length && rows[rows.length - 1].every(function (x) { return x === ''; })) rows.pop();
    return rows;
  }

  function decodeFile(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); }
    catch (e) { return new TextDecoder('shift_jis').decode(buf); } // Excel で保存した CSV
  }

  function csvCell(v) {
    v = v == null ? '' : String(v);
    return /[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  function pickCsv() {
    var inp = document.getElementById('tb-file');
    if (inp) { inp.value = ''; inp.click(); }
  }
  async function onCsvChosen(inp) {
    var file = inp.files && inp.files[0]; if (!file) return;
    var text = decodeFile(await file.arrayBuffer());
    inp.value = ''; // 同じファイルを選び直せるように
    var rows = parseCsv(text);
    if (rows.length < 1) return say('⚠ CSV が空です');
    importMapSheet(file.name, rows);
  }

  // 型の推定（提案だけ。決めるのは人）
  function guessType(name, values) {
    var filled = values.filter(function (v) { return v.trim() !== ''; });
    var ratio = function (fn) { return filled.length ? filled.filter(fn).length / filled.length : 0; };
    if (/pass|パスワード|暗証|secret|pin\b/i.test(name)) return 'secret';
    if (!filled.length) return 'text';
    if (ratio(isUrl) >= 0.6 || /url|ＵＲＬ|リンク|ログインページ/i.test(name)) return 'url';
    if (ratio(isEmail) >= 0.8 || /mail|メール/i.test(name) && ratio(isEmail) >= 0.5) return 'email';
    if (ratio(function (v) { return parseCheckbox(v) !== undefined; }) === 1 && filled.some(function (v) { return parseCheckbox(v) === true; }) && new Set(filled.map(function (v) { return v.trim().toLowerCase(); })).size <= 2) return 'checkbox';
    if (ratio(function (v) { return parseDate(v) != null; }) >= 0.9) return 'date';
    if (ratio(function (v) { return parseNumber(v) != null; }) >= 0.9) return 'number';
    if (filled.some(function (v) { return /\n/.test(v) || v.length > 80; })) return 'long_text';
    var distinct = new Set(filled.map(function (v) { return v.trim(); })).size;
    if (filled.length >= 10 && distinct <= 12 && distinct <= filled.length / 3) return 'select';
    return 'text';
  }

  function importMapSheet(fileName, rows) {
    var header = rows[0].map(function (x, i) { return (x || '').trim() || ('列' + (i + 1)); });
    var data = rows.slice(1);
    var pf = primaryField();
    var cols = header.map(function (name, i) {
      var vals = data.map(function (r) { return r[i] == null ? '' : r[i]; });
      var existing = st.fields.find(function (f) { return f.name === name; });
      var g = guessType(name, vals);
      return { i: i, name: name, filled: vals.filter(function (v) { return v.trim() !== ''; }).length, guess: g, target: existing ? existing.id : '__new__', newType: g };
    });
    // 主列に当たる列が無ければ、先頭の列を主列に当てる
    if (pf && !cols.some(function (c) { return c.target === pf.id; })) cols[0].target = pf.id;

    var targetOptions = function (c) {
      return '<option value="__new__"' + (c.target === '__new__' ? ' selected' : '') + '>新しい列として追加</option>'
        + st.fields.map(function (f) { return '<option value="' + f.id + '"' + (c.target === f.id ? ' selected' : '') + '>既存の列：' + h(f.name) + (f.is_primary ? '（主列）' : '（' + typeOf(f).label + '）') + '</option>'; }).join('')
        + '<option value="__skip__"' + (c.target === '__skip__' ? ' selected' : '') + '>取り込まない</option>';
    };
    var s = openSheet('<h3>CSV を取り込む</h3><p class="tb-lead">' + h(fileName) + '：' + data.length + ' 件（見出しの行を除く）。<br>'
      + '列ごとに取り込み先と型を選んでください。<span class="tb-guess">推定</span>は中身から推した型で、決めるのはあなたです。値の中身はこの画面に出しません。</p>'
      + '<table class="tb-map"><thead><tr><th style="width:30%">CSV の列</th><th style="width:38%">取り込み先</th><th>新しい列の型</th></tr></thead><tbody>'
      + cols.map(function (c) {
          return '<tr data-ci="' + c.i + '"><td><div class="tb-colname">' + h(c.name) + '</div><div class="tb-fill">' + c.filled + ' / ' + data.length + ' 件に値あり</div></td>'
            + '<td><select class="tb-select" data-k="target">' + targetOptions(c) + '</select></td>'
            + '<td><select class="tb-select" data-k="type"' + (c.target === '__new__' ? '' : ' disabled') + '>' + typeOptions(c.newType, c.guess) + '</select></td></tr>';
        }).join('')
      + '</tbody></table>'
      + '<div class="tb-alert" id="tb-im-note" style="display:none"></div>'
      + '<div class="tb-err" id="tb-im-err"></div>'
      + '<div class="tb-actions"><button class="tb-btn" data-x="cancel">やめる</button><button class="tb-btn primary" data-x="ok">' + data.length + ' 件を取り込む</button></div>', true);

    var sync = function () {
      s.el.querySelectorAll('tr[data-ci]').forEach(function (tr) {
        var c = cols[+tr.dataset.ci];
        c.target = tr.querySelector('[data-k="target"]').value;
        var ts = tr.querySelector('[data-k="type"]'); ts.disabled = c.target !== '__new__'; c.newType = ts.value;
      });
      var note = s.el.querySelector('#tb-im-note');
      var secretCols = cols.filter(function (c) { return (c.target === '__new__' && c.newType === 'secret') || (st.fields.find(function (f) { return f.id === c.target && f.type === 'secret'; })); });
      note.style.display = secretCols.length ? '' : 'none';
      note.textContent = secretCols.length ? 'シークレット列（' + secretCols.map(function (c) { return c.name; }).join('・') + '）は、取り込む前に合言葉で解錠し、ブラウザの中で暗号化してから保存します。' : '';
    };
    s.el.querySelectorAll('select').forEach(function (x) { x.addEventListener('change', sync); });
    sync();
    s.el.querySelector('[data-x="cancel"]').onclick = s.close;
    s.el.querySelector('[data-x="ok"]').onclick = async function () {
      sync();
      var err = s.el.querySelector('#tb-im-err');
      var used = cols.filter(function (c) { return c.target !== '__new__' && c.target !== '__skip__'; }).map(function (c) { return c.target; });
      if (used.length !== new Set(used).size) { err.textContent = '同じ既存の列に2つ以上の CSV 列を当てています'; return; }
      if (pf && used.indexOf(pf.id) < 0) { err.textContent = '主列（' + pf.name + '）に当てる CSV の列を選んでください'; return; }
      var newNames = cols.filter(function (c) { return c.target === '__new__'; }).map(function (c) { return c.name; });
      if (newNames.some(function (n) { return st.fields.some(function (f) { return f.name === n; }); })) { err.textContent = '既存の列と同じ名前の「新しい列」があります。既存の列に当てるか、取り込まないにしてください'; return; }
      s.close();
      await runImport(cols, data);
    };
  }

  async function runImport(cols, data) {
    // 1. 新しい列を作る（シークレットがあるなら先に解錠）
    var needSecret = cols.some(function (c) { return (c.target === '__new__' && c.newType === 'secret') || st.fields.some(function (f) { return f.id === c.target && f.type === 'secret'; }); });
    if (needSecret && !(await unlock())) { say('解錠しなかったので、取り込みをやめました'); return; }
    for (var i = 0; i < cols.length; i++) {
      var c = cols[i];
      if (c.target === '__new__') { var f = await createField(c.name, c.newType); if (!f) return; c.target = f.id; }
    }
    var pf = primaryField();
    var maps = cols.filter(function (c) { return c.target !== '__skip__'; }).map(function (c) { return { i: c.i, f: fieldById(c.target) }; });
    var choiceBefore = {}; maps.forEach(function (m) { if (m.f.type === 'select' || m.f.type === 'multi_select') choiceBefore[m.f.id] = choices(m.f).length; });

    // 2. 行を組み立てる（検証に落ちた値も捨てない。要確認として報告する）
    var issues = [];
    var seen = {};
    st.records.forEach(function (r) { var v = strVal(r, pf); if (v) seen[v] = seen[v] || '既存の行'; });
    var maxOrder = st.records.reduce(function (m, r) { return Math.max(m, r.sort_order || 0); }, 0);
    var recs = [], secretPlain = [];
    var width = cols.length;
    data.forEach(function (row, idx) {
      var line = idx + 2; // 見出しを1行目として数えた行番号
      var rec = { id: newId(), table_id: st.tableId, values: {}, sort_order: maxOrder + idx + 1, _line: line };
      if (row.length !== width) issues.push({ line: line, rid: rec.id, reason: '列の数が見出しと合いません（' + row.length + '列）' });
      maps.forEach(function (m) {
        var v = row[m.i] == null ? '' : row[m.i];
        if (m.f.type === 'secret') { if (v !== '') secretPlain.push({ rid: rec.id, fid: m.f.id, v: v }); return; }
        if (m.f.is_primary) {
          if (!v.trim()) { v = EMPTY_PRIMARY; issues.push({ line: line, rid: rec.id, reason: '名称が空のため「' + EMPTY_PRIMARY + '」を入れました' }); }
          else if (seen[v]) issues.push({ line: line, rid: rec.id, reason: '名称が重複（' + (typeof seen[v] === 'number' ? seen[v] + '行目' : seen[v]) + 'と同じ）。まとめずに両方残しました' });
          else seen[v] = line;
          rec.values[m.f.id] = v; return;
        }
        var res = fromString(v, m.f);
        if (res.warn) issues.push({ line: line, rid: rec.id, reason: '「' + m.f.name + '」が' + typeOf(m.f).label + 'の形式ではありません（値はそのまま保持）' });
        if (res.value !== undefined) rec.values[m.f.id] = res.value;
      });
      recs.push(rec);
    });

    // 3. 保存（選択肢 → 暗号化 → 行 → 暗号文の順。行が入ってから暗号文を入れる）
    var okRows = 0, okSecrets = 0, errors = [];
    await progressRun('取り込んでいます', recs.length + secretPlain.length, async function (tick) {
      for (var m0 = 0; m0 < maps.length; m0++) {
        var mf = maps[m0].f;
        if (choiceBefore[mf.id] != null && choices(mf).length !== choiceBefore[mf.id]) { if (!(await saveFieldOptions(mf))) throw new Error('choices'); }
      }
      var secRows = [];
      for (var j = 0; j < secretPlain.length; j++) {
        secRows.push({ record_id: secretPlain[j].rid, field_id: secretPlain[j].fid, cipher: await window.SecretMemo.encryptText(secretPlain[j].v) });
        secretPlain[j].v = null; // 平文をすぐ手放す
      }
      var done = 0;
      for (var k = 0; k < recs.length; k += 100) {
        var chunk = recs.slice(k, k + 100);
        var r = await SB().from('table_records').insert(chunk.map(function (x) { return { id: x.id, table_id: x.table_id, values: x.values, sort_order: x.sort_order }; }));
        if (r.error) { chunk.forEach(function (x) { x._failed = true; errors.push({ line: x._line, reason: '保存に失敗しました' }); }); console.error('tables:import', r.error.code); }
        else okRows += chunk.length;
        done += chunk.length; tick(done);
      }
      var failed = {}; recs.forEach(function (x) { if (x._failed) failed[x.id] = true; });
      secRows = secRows.filter(function (x) { return !failed[x.record_id]; });
      for (var m = 0; m < secRows.length; m += 100) {
        var sc = secRows.slice(m, m + 100);
        var r2 = await SB().from('table_record_secrets').insert(sc);
        if (r2.error) { console.error('tables:importSecrets', r2.error.code); sc.forEach(function (x) { var rr = recs.find(function (y) { return y.id === x.record_id; }); errors.push({ line: rr ? rr._line : '?', reason: 'シークレット列の保存に失敗しました' }); }); }
        else { okSecrets += sc.length; sc.forEach(function (x) { st.hasSecret[key(x.record_id, x.field_id)] = true; }); }
        done += sc.length; tick(done);
      }
      recs.forEach(function (x) { if (!x._failed) { var y = Object.assign({}, x); delete y._line; y.created_at = nowIso(); y.updated_at = y.created_at; st.records.push(y); } });
    });
    st.counts[st.tableId] = st.records.length;
    st.q = '';
    redrawGrid();
    resultSheet(data.length, okRows, okSecrets, issues, errors);
  }

  function resultSheet(total, okRows, okSecrets, issues, errors) {
    var list = errors.map(function (x) { return { line: x.line, reason: '⚠ ' + x.reason }; }).concat(issues).sort(function (a, b) { return a.line - b.line; });
    var s = openSheet('<h3>取り込みが終わりました</h3>'
      + '<div class="tb-sum"><div><b>' + okRows + '</b><span>取り込んだ行（CSV ' + total + ' 件）</span></div>'
      + '<div><b>' + issues.length + '</b><span>要確認</span></div><div><b>' + errors.length + '</b><span>失敗</span></div></div>'
      + (okSecrets ? '<p class="tb-lead">シークレット列の値 ' + okSecrets + ' 件を暗号化して保存しました。</p>' : '')
      + (list.length ? '<p class="tb-lead" style="margin-bottom:6px">行番号は、CSV の見出しを1行目として数えたものです。押すとその行を開きます。</p><div class="tb-issues">'
        + list.map(function (x) { return '<div class="tb-issue" data-rid="' + (x.rid || '') + '"><b>' + x.line + '行目</b><span>' + h(x.reason) + '</span></div>'; }).join('') + '</div>'
        : '<p class="tb-lead">要確認の行はありません。</p>')
      + '<div class="tb-actions"><button class="tb-btn primary" data-x="ok">閉じる</button></div>', true);
    s.el.querySelector('[data-x="ok"]').onclick = s.close;
    s.el.querySelectorAll('.tb-issue[data-rid]').forEach(function (el) {
      el.onclick = function () { if (!el.dataset.rid) return; s.close(); openDrawer(el.dataset.rid); };
    });
  }

  // ---- 書き出し ----
  function exportSheet() {
    var t = curTable(); if (!t) return;
    var hasSecretCol = st.fields.some(function (f) { return f.type === 'secret'; });
    var s = openSheet('<h3>書き出す</h3><p class="tb-lead">「' + h(t.name) + '」の ' + st.records.length + ' 件を書き出します。フィルタ・検索・並べ替えに関係なく全件です。</p>'
      + '<label class="tb-check"><input type="radio" name="tb-fmt" value="csv" checked> CSV（Excel で開ける。文字コードは UTF-8）</label>'
      + '<label class="tb-check"><input type="radio" name="tb-fmt" value="json"> JSON（列の型と選択肢も含めて、ほかのツールへ移すとき）</label>'
      + (hasSecretCol ? '<hr style="border:none;border-top:1px solid var(--border);margin:12px 0"><label class="tb-check"><input type="checkbox" id="tb-ex-secret"> シークレット列も含める</label>'
        + '<div class="tb-alert" id="tb-ex-warn" style="display:none">含めると、パスワードなどが平文でファイルに書き出されます。書き出したファイルの扱いに気をつけ、使い終わったら削除してください。</div>' : '')
      + '<div class="tb-actions"><button class="tb-btn" data-x="cancel">やめる</button><button class="tb-btn primary" data-x="ok">書き出す</button></div>');
    var cb = s.el.querySelector('#tb-ex-secret');
    if (cb) cb.onchange = function () { s.el.querySelector('#tb-ex-warn').style.display = cb.checked ? '' : 'none'; };
    s.el.querySelector('[data-x="cancel"]').onclick = s.close;
    s.el.querySelector('[data-x="ok"]').onclick = async function () {
      var fmt = s.el.querySelector('input[name="tb-fmt"]:checked').value;
      var withSecret = !!(cb && cb.checked);
      if (withSecret && !confirm('パスワードなどを平文で書き出します。よろしいですか？')) return;
      s.close();
      await doExport(t, fmt, withSecret);
    };
  }

  async function doExport(t, fmt, withSecret) {
    var fields = st.fields.filter(function (f) { return withSecret || f.type !== 'secret'; });
    var plain = {};
    if (withSecret) {
      if (!(await unlock())) return;
      var sids = st.fields.filter(function (f) { return f.type === 'secret'; }).map(function (f) { return f.id; });
      if (sids.length) {
        var cs;
        try { cs = await secretsOf('record_id,field_id,cipher', sids); } catch (e) { return fail('export', e); }
        for (var i = 0; i < cs.length; i++) plain[key(cs[i].record_id, cs[i].field_id)] = await window.SecretMemo.decryptText(cs[i].cipher);
      }
    }
    var csvVal = function (r, f) { return f.type === 'secret' ? (plain[key(r.id, f.id)] || '') : strVal(r, f); };
    var jsonVal = function (r, f) {
      if (f.type === 'secret') return plain[key(r.id, f.id)] || null;
      var v = rawVal(r, f);
      if (v == null) return f.type === 'checkbox' ? false : (f.type === 'multi_select' ? [] : null);
      if (f.type === 'select') { var c = choiceById(f, v); return c ? c.name : v; }
      if (f.type === 'multi_select') return (Array.isArray(v) ? v : [v]).map(function (id) { var c2 = choiceById(f, id); return c2 ? c2.name : id; });
      return v;
    };
    var rows = st.records.slice().sort(function (a, b) { return a.sort_order - b.sort_order; });
    var stamp = new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
    var base = t.name.replace(/[\\/:*?"<>|]/g, '_') + '_' + stamp;
    var blob;
    if (fmt === 'csv') {
      var lines = [fields.map(function (f) { return csvCell(f.name); }).join(',')]
        .concat(rows.map(function (r) { return fields.map(function (f) { return csvCell(csvVal(r, f)); }).join(','); }));
      blob = new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    } else {
      var out = { table: { name: t.name, description: t.description }, exported_at: nowIso(), secrets_included: withSecret,
        fields: fields.map(function (f) { var o = { id: f.id, name: f.name, type: f.type, is_primary: f.is_primary }; if (f.type === 'select' || f.type === 'multi_select') o.choices = choices(f).map(function (c) { return { name: c.name, color: c.color }; }); return o; }),
        records: rows.map(function (r) { var o = {}; fields.forEach(function (f) { o[f.name] = jsonVal(r, f); }); return { id: r.id, created_at: r.created_at, updated_at: r.updated_at, values: o }; }) };
      blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    }
    plain = null;
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = base + '.' + fmt;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 200);
    say(rows.length + ' 件を書き出しました' + (withSecret ? '（シークレット列を含む）' : ''));
  }

  // ---------------------------------------------------------------------
  // キーボード：Esc で閉じる（メニュー → パネルの順）
  // ---------------------------------------------------------------------
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape' || S.view !== 'tables') return;
    if (document.querySelector('.tb-overlay,.sm-overlay')) return;
    if (document.getElementById('tb-menu') || document.getElementById('tb-panel')) { closeMenu(); e.stopPropagation(); return; }
    if (st.drawerId && !(document.activeElement && document.activeElement.classList.contains('tb-cell-input'))) { closeDrawer(); e.stopPropagation(); }
  }, true);

  // 別のビューへ移ったら、パネルとメニューを片付ける
  var lastView = null;
  setInterval(function () {
    if (typeof S === 'undefined') return;
    if (lastView === 'tables' && S.view !== 'tables') { closeMenu(); if (st.drawerId) closeDrawer(); st.revealed = {}; }
    lastView = S.view;
  }, 400);

  window.BizTables = { render: render };
})();

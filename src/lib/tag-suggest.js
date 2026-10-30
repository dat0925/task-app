// =====================================================================
// タスクタイトルからタグを提案するユーティリティ（クイック追加用）
// 実行時: index.html が <script type="module"> で読み込み、window.TagSuggest に公開する
// テスト: node --test src/lib/tag-suggest.test.js
// 依存ゼロ。状態を持たない純関数群（crypto.js と同じ流儀）。
//
// 方針:
// - 提案は「既存タグの中から最大1つ」だけ。Taskra のタグは実質カテゴリとして
// 単一選択で使われているため、分類問題として扱う（新しいタグは作らない）。
// - 判定は端末内のみで行い、タイトルを外部に送信しない。
// - 根拠は2段構え:
// 1) タイトルにタグ名そのものが含まれていれば最優先
// 2) 過去タスクの「タイトル → タグ」の履歴から、文字バイグラムの一致で推定
// =====================================================================

// 比較用にテキストを正規化する（小文字化＋空白・記号除去）
export function normText(s) {
return String(s || '')
.toLowerCase()
.replace(/[\s　、。，．・：:；;／/＼\\（）()「」『』［］\[\]#＃@＠!！?？*＊~〜\-ー―_]/g, '');
}

// 文字バイグラム（2文字の連なり）の配列を返す。重複はそのまま残す
export function bigrams(s) {
const t = normText(s);
const out = [];
for (let i = 0; i + 1 < t.length; i++) out.push(t.slice(i, i + 2));
return out;
}

// 過去タスクから「タグごとの語彙モデル」を作る
// 戻り値: Map<tagId, { count: そのタグのタスク数, grams: Map<bigram, 出現回数>}>
export function buildTagModel(tasks, tags) {
const model = new Map();
for (const tg of tags) model.set(tg.id, { count: 0, grams: new Map()});
for (const task of tasks || []) {
const ids = (task && task.tagIds) || [];
if (!ids.length ||!task.title) continue;
const gs = bigrams(task.title);
if (!gs.length) continue;
for (const id of ids) {
const m = model.get(id);
if (!m) continue;
m.count++;
for (const g of gs) m.grams.set(g, (m.grams.get(g) || 0) + 1);
}
}
return model;
}

// タイトルに対するタグ提案を返す。提案できなければ null
// 戻り値: { tagId, reason: 'name' | 'history', matched: 一致したバイグラム数}
export function suggestTag(title, tags, model) {
const t = normText(title);
if (t.length < 2 ||!tags ||!tags.length) return null;

// 1) タグ名そのものが含まれている場合（長い名前＝より具体的なものを優先）
const byName = [...tags]
.filter(tg => tg.name && normText(tg.name).length >= 2)
.sort((a, b) => normText(b.name).length - normText(a.name).length)
.find(tg => t.includes(normText(tg.name)));
if (byName) return { tagId: byName.id, reason: 'name', matched: 0};

// 2) 履歴のバイグラム一致で推定
if (!model) return null;
const titleGrams = [...new Set(bigrams(title))];
if (!titleGrams.length) return null;
let best = null;
for (const tg of tags) {
const m = model.get(tg.id);
if (!m || m.count < 1) continue;
let matched = 0;
for (const g of titleGrams) if (m.grams.has(g)) matched++;
if (matched < 2) continue;
const coverage = matched / titleGrams.length;
if (coverage < 0.34) continue;
// タスク数が多いタグほど語彙が広く偶然一致しやすいので、件数の平方根で割り引く
const score = matched / Math.sqrt(m.count);
if (!best || score > best.score) best = { tagId: tg.id, reason: 'history', matched, score};
}
return best;
}

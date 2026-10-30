// =====================================================================
// src/lib/tag-suggest.js の単体テスト
//   実行: node --test src/lib/tag-suggest.test.js
//   依存ゼロ（Node標準 node:test / node:assert のみ）。
// =====================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTagModel, suggestTag, normText } from './tag-suggest.js';

const tags = [
  { id: 't-work', name: '仕事' },
  { id: 't-shop', name: '買い物' },
  { id: 't-home', name: '家事' },
];

const history = [
  { title: '牛乳を買う', tagIds: ['t-shop'] },
  { title: '卵を買う', tagIds: ['t-shop'] },
  { title: '納豆と豆腐を買う', tagIds: ['t-shop'] },
  { title: '週次報告書を書く', tagIds: ['t-work'] },
  { title: '会議の資料を作る', tagIds: ['t-work'] },
  { title: '洗濯物を干す', tagIds: ['t-home'] },
];

test('タイトルにタグ名が含まれていればそのタグを提案する', () => {
  const model = buildTagModel(history, tags);
  const r = suggestTag('買い物のリストを作る', tags, model);
  assert.equal(r.tagId, 't-shop');
  assert.equal(r.reason, 'name');
});

test('履歴の語彙が近いタイトルには、そのタグを提案する', () => {
  const model = buildTagModel(history, tags);
  const r = suggestTag('味噌を買う', tags, model);
  assert.equal(r.tagId, 't-shop');
  assert.equal(r.reason, 'history');
});

test('履歴と無関係なタイトルには提案しない', () => {
  const model = buildTagModel(history, tags);
  assert.equal(suggestTag('髪を切る', tags, model), null);
});

test('履歴が空なら提案しない（タグ名一致のみ働く）', () => {
  const model = buildTagModel([], tags);
  assert.equal(suggestTag('味噌を買う', tags, model), null);
  assert.equal(suggestTag('仕事の電話をする', tags, model).tagId, 't-work');
});

test('短すぎるタイトルには提案しない', () => {
  const model = buildTagModel(history, tags);
  assert.equal(suggestTag('あ', tags, model), null);
  assert.equal(suggestTag('', tags, model), null);
});

test('正規化は空白と記号を取り除く', () => {
  assert.equal(normText(' 牛乳 を、買う！'), '牛乳を買う');
});

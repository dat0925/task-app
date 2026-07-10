# Taskra（タスクラ）引き継ぎ書

最終更新: 2026-07-10

---

## 🆕 Supabaseセキュリティアラート対応：管理者用RPC・RLSポリシーの権限漏れを修正（2026-07-10）

### 背景

Supabaseから「Action required: security vulnerabilities detected in your projects」という
セキュリティアラートメールが届き、`get_advisors`（security）で全体を棚卸しした結果、
共有Supabaseプロジェクト（`sfhtvtcmgueystyuhzvd`）内のTaskra関連テーブル・関数に、
「管理者専用／service専用のつもりが実際は誰でも（anon含む）実行・アクセス可能だった」
権限設定ミスが複数見つかった。

### 修正内容

**1. `admin_get_all_users()` RPCに認可チェック追加＋anon実行権限を剥奪**
（マイグレーション: `fix_admin_get_all_users_auth_check`）

- Tavera側の関数だが、同一プロジェクト内の問題として合わせて対応
- `admin_update_plan` / `admin_set_usage_overrides` / `admin_reset_usage` の3関数には
  `IF (SELECT email FROM auth.users WHERE id = auth.uid()) IS DISTINCT FROM 'mstd0520@gmail.com' THEN RAISE EXCEPTION`
  という認可チェックが入っていたが、`admin_get_all_users()`だけこのチェックが欠落しており、
  かつ`anon`ロールにもEXECUTE権限が付与されたままだった
- 未ログインの第三者が`/rest/v1/rpc/admin_get_all_users`を直接叩くだけで、
  Taveraの全ユーザーのメールアドレス・プラン・利用状況が取得できる状態だった（SECURITY DEFINERのためRLSも無視）
- 対応: 同関数に同じ認可チェックを追加し、4関数すべて`anon`からのEXECUTE権限を`REVOKE`
  （`authenticated`のみ残すが、内部チェックで結局本人以外は`Unauthorized`になる）

**2. `ai_usage` / `file_extract_usage` テーブルのRLSポリシーを管理者限定に修正**
（マイグレーション: `restrict_overly_permissive_rls_policies`）

- `"Admin can read all usage"` / `"Admin can update usage"` という名前のポリシーが、
  実際には`USING (true)`かつロール指定なし（`public`扱い）＝**anon含め誰でも
  全ユーザーのAI利用状況・ファイル抽出利用状況を読み書きできる状態**だった
- 対応: `USING`句を`(SELECT email FROM auth.users WHERE id = auth.uid()) = 'mstd0520@gmail.com'`に変更

**3. `line_users` テーブルのポリシーを`service_role`限定に修正**

- ポリシー名`"line_users: service only"`という意図に反し、`USING(true)`が`public`ロールに
  適用されており、LINE連携ユーザーのマッピング情報を誰でも読み書き削除できる状態だった
- 対応: ポリシーを`TO service_role`に変更（クライアントからは触れなくなる。
  Edge Functionはservice_roleキー使用のため影響なし想定）

**4. `task_logs` テーブルの全ポリシーから`anon`を除外**

- `read_all` / `insert_all` / `update_all` / `delete_all` の4ポリシーが全て`USING(true)`かつ
  `public`ロールで、未ログインでも全タスクログの閲覧・改ざん・削除が可能だった
- 対応: 4ポリシーとも`TO authenticated`に変更（ログイン済みユーザーのみ。個別ユーザー単位の
  絞り込みは今回未実施＝ログインさえすれば他人のログも操作可能なまま。要フォロー）

**5. `workspace_members` テーブルの無条件許可ポリシーを削除**

- `ws_members_insert`（`WITH CHECK (true)`, 無条件許可）と、正しく本人チェックする
  `wsmembers_can_insert_self`（`WITH CHECK (user_id = auth.uid())`）が同居しており、
  RLSはOR評価のため前者が後者を無意味化し、誰でも任意のワークスペースに自分以外を
  メンバー追加できる状態だった
- 対応: 無条件許可の`ws_members_insert`を削除。正しい制限付きポリシーのみ残す

**6. `notifications` テーブルのINSERT/DELETEから`anon`を除外**

- SELECT/UPDATEは本人限定で正しかったが、INSERT/DELETEが`USING(true)`かつ`public`で
  誰でも任意ユーザー宛の通知を作成・削除できた
- 対応: `TO authenticated`に変更

### 原因調査

- `file_extract_usage`のポリシーは`create_file_extract_usage`マイグレーション（2026-07-05）で
  `ai_usage`テーブルの既存ポリシー（ポリシー名・`USING(true)`の書き方まで同一）を
  そのままコピーして作られたことが履歴から確認できた。つまり「`ai_usage`側の誤った
  権限設計」が起点となり、新規テーブルを作るたびにコピペで踏襲・拡散していったと見られる
- `ai_usage` / `line_users` / `task_logs` / `workspace_members`自体は、追跡可能な
  マイグレーション履歴（2026-06-27以降）より前に作成されたテーブルのため、
  最初にいつ・どの改修で`USING(true)`パターンが持ち込まれたかは特定できなかった
- 教訓: `USING (true)`は「誰でもOK」という意味であり、「管理者/service専用」を
  意図する場合は`TO service_role`や`auth.uid()`ベースのチェックを明示する必要がある。
  新規テーブル作成時に既存ポリシーをコピーする前に、対象ロールが本当に適切か確認すること

### 触れなかった箇所（要フォロー）

- `task_logs`の4ポリシーは`authenticated`なら誰でも全ログを操作できる状態のまま
  （ユーザー/ワークスペース単位の絞り込みは未実装）
- 以下のSupabase Advisor（security）指摘は今回スコープ外、未対応:
  - 12テーブル（`kotobakake_*`, `reno_*`, `housecleaning_*`など）でRLS有効だがポリシー0件
    （Edge Function経由のservice_roleアクセスのみを想定した設計と思われ、リスクは低いと
    判断したが未検証）
  - `pg_net`拡張がpublicスキーマに配置されている（`extension_in_public`）
  - 認証関連のヘルパー関数（`auth_user_workspace_ids`, `find_household_by_code`,
    `get_my_household_id`, `get_workspace_by_invite_token`, `household_has_premium`）が
    `anon`/`authenticated`双方からSECURITY DEFINERとして実行可能（意図的な設計の可能性が
    高いが未レビュー）
  - 複数関数の`function_search_path_mutable`警告（`purge_old_notification_log`など）
  - 漏洩パスワード保護（HaveIBeenPwned連携）が無効

---

## 🆕 一括日付設定に「本日」ボタン追加／日付・時間調整ボタンの視認性改善（2026-07-10）

### 依頼内容

1. タスク一覧の「日付を一括設定」モーダルで、開始日・期限それぞれの「+1日」ボタンの
   左に「本日」ボタンが欲しい
2. タスク詳細・一括編集モーダル両方にある日付/時間調整ボタン（`.date-adj-btn`：
   +1日／+7日／+1月／+10m／+1h／+3h／9:00等の時刻ボタン／本日）が小さくて見づらいが、
   サイズは変えられないので、メモ欄の補助ボタン（`.note-copy-btn`）のように
   縁と文字色で視認性を上げてほしい

### 変更内容

**1. 一括日付設定モーダルに「本日」ボタン追加**（`handleBulkEdit('dates')`内、
index.html 7400行台）
- 開始日・期限それぞれのボタン行の先頭（+1日の左）に「本日」ボタンを追加
  （id: `bulk-sadj-today` / `bulk-dadj-today`）
- 新規ヘルパー関数`setBulkToday(inp,wdEl)`を追加。既存の`adjBulkDate`は
  「現在値がある場合はそこからの差分計算」ロジックのため日数0では素通りしてしまい
  「常に今日にする」用途には使えなかったので、専用関数として分離
- クリック時は`startCleared`/`dueCleared`フラグをfalseに戻す（クリア状態から
  本日ボタンで復帰できるように）

**2. `.date-adj-btn`の視認性改善**（CSS、index.html 195行目・213行目）
- 変更前: `background:var(--bg2)` `border:1px solid var(--border)` `color:var(--text2)`
  （グレー系で薄い）
- 変更後: `background:transparent` `border:1px solid var(--accent)` `color:var(--accent)`
  `font-weight:700`を追加。hoverは`background:var(--accent-bg,var(--bg2))`に変更
- サイズ（font-size:10px, padding:6px 0）は指示通り変更なし
- `.date-adj-btn`は共通クラスのため、タスク詳細のスケジュール欄（開始日/開始時間/期限/
  計画開始日）と一括編集モーダルの両方に自動的に反映される

### 触れなかった箇所

- 認証・決済（Stripe）・RLS・DBスキーマは今回のスコープ外で、一切変更していない
  （UI/CSSのみの変更のため、セキュリティチェック項目は非該当と判断）
- ダークモード（`[data-dark]`）側で`--accent`の再定義はないため、ライト/ダーク共通で
  同じインディゴ系の色になる。ダーク背景での実機コントラスト確認は未実施
- 実機ブラウザでの最終見た目確認は未実施。特に一括編集モーダルは4ボタン
  （本日/+1日/+7日/+1月）がflex:1で並ぶため、修正後の文字色・縁が窮屈に
  見えないか確認してほしい

Node.js構文チェック済みでエラーなし。push後、GitHub Pagesビルド成功を確認済み
（コミット`dedf539`でbuilt）。

---

## 🆕 PCビュー タスク詳細のメモツールバーが2段に折り返す不具合を修正（2026-07-10）

### 背景

PC版（幅336pxの右サイドドロワー`.drawer`）でタスク詳細を開き、メモ欄を開くと、
`#memo-toolbar`内の4ボタン（コピー／📅 日時／🔗 Link／編集）のうち「編集」だけが
2段目に折り返されてしまう不具合の報告（スクリーンショットで確認）。

### 原因

`.note-copy-btn`の横paddingが`14px`と大きく、4ボタン+アイコン+テキストの合計幅が
ドロワー内側の実効幅（約281px、`.drawer`336px→`.drawer-body`padding14px→
`.dt-schedule-block`border1px→`.dt-section-body`padding12px を差し引いた値）を
約20px超過していた。

### 変更内容

- `.note-copy-btn`（217行目付近）の横paddingを`14px`→`8px`に縮小、内部アイコン-テキスト間の
  `gap`を`4px`→`3px`に縮小、`white-space:nowrap`を追加（折り返し防止の保険）
- このクラスは以下4箇所で共通利用されているため、今回の修正は全箇所に反映される：
  - タスク詳細メモ（コピー／日時／Link／編集）
  - タスク詳細コメント（日時／Link）
  - ノート詳細メモ（コピー／日時／Link／プレビュー）
  - ノート詳細コメント（日時／Link）
- 概算計算（Noto Sans CJK JP Boldでのテキスト幅測定＋アイコン/絵文字幅の見積り）で、
  修正後の4ボタン合計幅は約252px（旧: 約301px）となり、実効幅281pxに対して
  約29pxの余裕を確保。実機/実ブラウザでの最終確認は未実施のため要目視確認
- フォントサイズ・縦paddingは変更していないため、ボタンの高さや文字の読みやすさは維持

Node.js構文チェック済みでエラーなし（CSSのみの変更、`<style>`ブロック内でJSへの影響なし）。

### 触れなかった箇所

- 認証・決済（Stripe）・RLSまわりは今回のスコープ外で、一切変更していない
- モバイル（幅768px以下）では`.drawer`が画面幅100%になるため元々折り返しは発生しておらず、
  今回の変更による影響は軽微（ボタンがやや小さくなる程度）と想定
- 実際のPCブラウザでの見た目確認はできていないため、次にこのファイルを触る人（AI/人間）は
  実機で1段に収まっているか、ボタンが窮屈すぎないかを確認してほしい

---

## 🆕 コメント入力欄がキーボードに隠れる不具合を修正・追加調整（2026-07-09）

### 追加調整（初回対応だけでは不十分だったため）

初回対応（余白320px + visualViewport.resizeイベントのみでスクロール調整）では、
実機で確認したところフォーカス直後にまだ隠れが残っていた。原因として、
`visualViewport`の`resize`イベントがキーボードのアニメーション完了タイミングと
ズレる場合があると考えられたため、以下に変更：

- スペーサーの高さを320px→480pxに増量（サジェストバー分も含めて確実に余地を確保）
- `visualViewport.resize`イベントに依存せず、フォーカス時に150ms/350ms/600msの
  3タイミングで強制的にスクロール位置を再計算するフォールバック処理を追加
  （まだそのフィールドにフォーカスが残っている場合のみ実行、二重スクロールしないよう
  差分が無ければ何もしない判定込み）
- ロジック自体は1つの関数`adjustScroll`に統一し、`visualViewport.resize`とフォールバック
  タイマーの両方から呼び出す形に整理

Node.js構文チェック済みでエラーなし。実機での再確認が必要。

---

## 🆕 コメント入力欄がキーボードに隠れる不具合を修正（2026-07-09）

### 背景

タスク詳細・ノート詳細どちらも、画面下部の「コメントを追加…」欄をタップすると
キーボードが迫り上がり、入力欄自体が隠れて見えなくなる不具合の報告。

### 原因

キーボード表示時に入力欄を見える位置までスクロールする処理（`visualViewport.resize`を
使った既存ロジック、11441行目付近）はすでに存在していたが、コメント入力欄は
`.drawer-body`内の一番下（末尾）の要素のため、スクロールしようにも
「これ以上スクロールできる余地」がなく、既存ロジックが機能していなかった。

### 変更内容

- 新規IIFE（既存の`visualViewport`対策コードの直前に追加）：
  - `INPUT`/`TEXTAREA`/`contenteditable`要素にフォーカスが入った瞬間、
    最も近い`.drawer-body`（`.expand-modal`/`.calc-drawer-body`/`.tlist-wrap`も対象）の
    末尾に高さ320pxの一時的な余白div（`data-kb-spacer`）を追加し、スクロール可能な余地を確保
  - フォーカスが外れた（かつ他の入力欄にフォーカスが移っていない）タイミングで余白を削除し、
    追加前のscrollTopに復元
  - この余白があることで、既存の`visualViewport.resize`ハンドラが実際にコンテナを
    スクロールして入力欄をキーボードの上に見える位置まで移動できるようになる
- 既存のスクロール処理自体（gap:24pxなど）は変更なし

Node.js構文チェック済みでエラーなし。

### 触れなかった箇所

- 認証・決済（Stripe）・RLSまわりは今回のスコープ外で、一切変更していない
- 実機（iOS PWA）での目視確認が必要。挙動が想定と異なる場合は320pxの余白量や
  gap値の調整、または`scrollIntoView`ベースの別アプローチへの切り替えを検討

---

## 🆕 メモ/コメントの全ボタンを塗りつぶしなし(アウトライン)に統一、編集/プレビューも同デザインに（2026-07-09）

### 背景

前回、コピー・日時・Linkを塗りつぶし（`background:var(--accent)`）で統一したが、実機で見ると
派手すぎる／編集(タスク詳細)・プレビュー(ノート詳細)ボタンだけデザインが違うとの指摘。
「全部塗りつぶしなしにして」「編集ボタンもデザイン合わせて」という依頼。

### 変更内容

- `.note-copy-btn`を塗りつぶし→アウトラインに変更：
  `background:var(--accent)`/`color:#fff` → `background:transparent`/`color:var(--accent)`、
  `border:1px solid var(--accent)`は維持。hoverは`background:var(--accent-bg,var(--bg2))`
- 「編集」（タスク詳細 `dt-preview-btn`）と「プレビュー」（ノート詳細 `nt-preview-btn`）を
  `.note-stamp-btn-minor`→`.note-copy-btn`に変更し、他の3ボタン（コピー／日時／Link）と
  完全に同一デザインに統一
- これにより以下4箇所の全ボタンが同一デザイン（アウトライン・同色・同サイズ）になった：
  - ノート詳細メモ：コピー／📅 日時／🔗 Link／プレビュー
  - ノート詳細コメント：📅 日時／🔗 Link
  - タスク詳細メモ：コピー／📅 日時／🔗 Link／編集
  - タスク詳細コメント：📅 日時／🔗 Link
- 使わなくなった`.note-stamp-btn-minor`のCSS定義を削除（他に参照箇所なし、確認済み）
- イベントハンドラ（`data-a`/`id`）は一切変更しておらず、見た目のみの変更

Node.js構文チェック済みでエラーなし。

### 触れなかった箇所

- 認証・決済（Stripe）・RLSまわりは今回のスコープ外で、一切変更していない
- PC拡大モーダル（`openExpandModal`）は`#drawer`の`innerHTML`をコピーする実装のため、
  今回のクラス変更は自動的に反映される想定（別途モーダル側の個別修正は不要）

---

## 🆕 メモ/コメントの日時・Link・コピーボタンを完全統一（2026-07-09）

### 背景

前回の対応で「日時」ボタンだけコピーと同じ大きさ（塗りつぶし）にしたが、実機で見ると
「日時」「Link」「コピー」がそれぞれ違うデザイン（塗りつぶし/アウトライン/地味）のままで
統一感がないとの指摘。加えて、タスク詳細・ノート詳細それぞれの「コメント」欄にある
「📅 日時」「🔗 Link」ボタンも従来の旧`.note-stamp-btn`（グレーのボーダー付きピル）のまま
放置されていたため、これも合わせて統一してほしいとの依頼。

### 変更内容

- `.note-copy-btn`を全ボタン共通の統一スタイルとして再定義し、サイズをコンパクト化：
  `padding:10px 16px`→`6px 14px`、`min-height:44px`→`28px`、`font-size:13px`→`12px`、
  `border-radius:10px`→`8px`。1行に複数ボタンを並べても折り返さないよう調整
- 使わなくなった`.note-stamp-btn-major`（アウトラインの中間サイズ）は削除
- 以下すべてのボタンを`.note-copy-btn`（塗りつぶし・同色・同サイズ）に統一：
  - ノート詳細メモ：コピー／📅 日時／🔗 Link（プレビューは`.note-stamp-btn-minor`のまま維持）
  - ノート詳細コメント：📅 日時（`ncm-stamp`）／🔗 Link（`ncm-link-btn`）
  - タスク詳細メモ：コピー（`copy-task-notes`）／📅 日時（`stamp`）／🔗 Link（`dt-link-btn`）
    （編集トグル`dt-preview-btn`は`.note-stamp-btn-minor`のまま維持）
  - タスク詳細コメント：📅 日時（`cm-stamp`）／🔗 Link（`cm-link-btn`）
- イベントハンドラ（`data-a`/`id`）は一切変更しておらず、見た目のみの変更

Node.js構文チェック済みでエラーなし。

### 触れなかった箇所

- 認証・決済（Stripe）・RLSまわりは今回のスコープ外で、一切変更していない
- 「編集」「プレビュー」トグルボタンは意図的に脇役スタイル（`.note-stamp-btn-minor`）のまま
  維持（今回の統一対象は日時・Link・コピーの3種）
- PC拡大モーダル（`openExpandModal`）は`#drawer`の`innerHTML`をコピーする実装のため、
  今回のクラス変更は自動的に反映される想定（別途モーダル側の個別修正は不要）

---

## 🆕 メモツールバーのサイズ調整・Note/タスク詳細デザイン統一（2026-07-09）

### 背景

直前の「ノート詳細画面『メモ』ツールバーのボタン階層改善」で`.note-copy-btn`（コピー、塗りつぶし）
を大きくしたところ「縦に大きすぎる」というフィードバック。また、タスク詳細側の同種メモツールバー
（`memo-toolbar`、絵文字アイコンのみの旧`.note-stamp-btn`スタイル）とノート詳細側のデザインが
異なりすぎるため統一してほしいとの要望があった。

### 変更内容

- `.note-copy-btn`：縦幅を約2/3に縮小（`padding:10px 16px`→`7px 16px`、`min-height:44px`→`30px`）。
  横幅（`padding`の左右16px）は変更なし
- 新規CSSクラス`.note-stamp-btn-major`を追加：「📅 日時」ボタン用。`.note-copy-btn`と同じ
  padding/min-height/font-sizeだが、塗りつぶしではなくアウトライン（背景transparent、
  `border:1px solid var(--accent)`、文字色`var(--accent)`）でコピーボタンとの主従を視覚的に区別
- ノート詳細（`renderNoteDrawer`内）の「📅 日時」ボタンを`.note-stamp-btn-minor`→
  `.note-stamp-btn-major`に変更（コピーボタンと同じ大きさに）
- タスク詳細（`renderDrawer`内、`#memo-toolbar`）を全面的にNote側と同じデザイン言語に統一：
  - 📋（絵文字のみ）→ `.note-copy-btn`（SVGアイコン+「コピー」テキスト、`data-a="copy-task-notes"`）
  - 📅（絵文字のみ）→ `.note-stamp-btn-major`（「📅 日時」テキスト付き）
  - 🔗（絵文字のみ）→ `.note-stamp-btn-minor`（「🔗 Link」テキスト付き）
  - 編集（旧: インラインstyleで塗りつぶし）→ `.note-stamp-btn-minor`（インラインstyle除去、
    ノート詳細の「プレビュー」ボタンと同格の脇役スタイルに統一）
  - `#memo-toolbar`に`flex-wrap:wrap`を追加（ボタンサイズ拡大に伴う折り返し対応）
- イベントハンドラ（`data-a="copy-task-notes"`、`id="dt-link-btn"`、`id="dt-preview-btn"`等）は
  一切変更しておらず、見た目のみの変更

Node.js構文チェック済みでエラーなし。

### 触れなかった箇所

- 認証・決済（Stripe）・RLSまわりは今回のスコープ外で、一切変更していない
- コメント欄（`cm-section`内）の「📅 日時」「🔗 Link」ボタン（`.note-stamp-btn`のまま、
  `ncm-stamp`/`ncm-link-btn`）は今回のスコープ外で未変更
- PC拡大モーダル（`openExpandModal`）は`#drawer`の`innerHTML`をコピーする実装のため、
  今回のクラス変更は自動的に反映される想定（別途モーダル側の個別修正は不要）

---

## 🆕 ノート詳細画面「メモ」ツールバーのボタン階層改善（2026-07-09）

### 背景

ノート詳細（`#drawer`内）の「メモ」ツールバーで、「📅 日時」「コピー」「Link」「プレビュー」の
4ボタンが同一スタイル（`.note-stamp-btn`）で並んでおり、実際に最も多用される「コピー」が他と
埋もれて視認・タップしづらいという声への対応。

### 変更内容

- 新規CSSクラスを追加（既存`.note-stamp-btn`はそのまま温存、他画面への影響なし）：
  - `.note-copy-btn`：コピー専用。塗りつぶし（`var(--accent)`背景+白文字）、アイコン+テキスト、
    `min-height:44px`でタップ領域確保、`:active`で`scale(0.96)`の押下フィードバック
  - `.note-stamp-btn-minor`：日時・Link・プレビュー用。ボーダーレス・グレー文字で脇役化
- ノート詳細のメモツールバーHTML（`index.html`内、ノートdrawer描画部分）を上記クラスに置き換え。
  コピー音ボタンにSVGアイコン（クリップボード）を追加
- 挙動・イベントハンドラ（`data-a="copy-note-body-inline"`、`id="nt-link-btn"`、`id="nt-preview-btn"`等）は
  一切変更しておらず、見た目のみの変更

### 触れなかった箇所

- 認証・決済（Stripe）・RLSまわりは今回のスコープ外で、一切変更していない
- タスク詳細側の同種メモツールバー（`copy-task-notes`等、絵文字アイコンのみの旧スタイル）は
  今回のスコープ外で未変更。同じ考え方を展開する場合は`.note-copy-btn`/`.note-stamp-btn-minor`を
  流用可能
- PC拡大モーダル（`openExpandModal`）は`#drawer`の`innerHTML`をコピーする実装のため、
  今回のクラス変更は自動的に反映される想定（別途モーダル側の個別修正は不要）

Node.js構文チェック済みでエラーなし。

---

## 🆕 PC拡大モーダル（openExpandModal）内でメモ・各セクション開閉が効かない不具合・修正（2026-07-08）

### 症状

タスク詳細をPCで「拡大表示」（`openExpandModal('task')`で開く大きいモーダル）した状態で、
モーダル内の「メモ」セクションをタップしても開閉せず、代わりに背後にある元のドロワー（右側の
タスク詳細パネル）側のメモが開閉してしまう。同様に📅（日時スタンプ）ボタンでメモに日時を挿入
しても、見た目上は反映されない（実際は背後のドロワーのテキストエリアに挿入されていた）。

### 原因

`openExpandModal()`は`renderDrawer()`が生成した`#drawer`のDOMを`modal.innerHTML = dr.innerHTML`で
**そのままコピー**して拡大モーダルを作る実装のため、`memo-collapse`・`dt-notes`・`dt-detail-body`
など多数の`id`が**ページ内に重複**する（元のドロワーと拡大モーダルの両方に同じidの要素が存在）。

一方、セクション開閉やメモ操作系の一部のクリックハンドラ（グローバルな`data-a`委任クリックハンドラ内）
は`document.getElementById('memo-collapse')`のように**ドキュメント全体から検索**していたため、
常に「そのidを持つ最初の要素」＝元のドロワー側の要素を掴んでしまい、拡大モーダル側でクリックしても
背後のドロワーが操作される、という不具合になっていた。

なお`date-adj`/`date-clear`/`paste-to-field`/`clear-note-body`など一部のハンドラは既に
`el.closest('.expand-modal,#drawer')`でスコープを絞ってから要素を取得する対策が入っていたが、
下記のメモ・セクション開閉系のハンドラには**同じ対策が漏れていた**。

### 修正内容

以下のハンドラを、クリックされた要素の属する`.expand-modal`または`#drawer`にスコープを絞って
要素を取得するよう統一（`el.closest('.expand-modal,#drawer')`→`ctx.querySelector(...)`→
見つからなければ`document.getElementById(...)`にフォールバック、という既存パターンに合わせた）：

- `dt-memo-toggle`（メモ開閉）
- `dt-detail-toggle`（詳細設定開閉）
- `dt-subs-toggle`（サブタスク開閉）
- `dt-cm-toggle`（コメント開閉）
- `dt-sched-toggle`（スケジュール開閉）
- `dt-gantt-toggle`（未使用だが同様に対策）
- `subs-done-toggle`（完了済みサブタスク表示）
- `stamp`（📅 日時スタンプ挿入ボタン）
- `copy-task-notes`（メモをコピー）
- `clear-task-notes`（メモをクリア）

また、`reattachModalEvents()`（拡大モーダル用の再イベントアタッチ関数）内で従来アタッチされて
いなかった以下も追加：
- `#dt-link-btn`（🔗 リンク挿入ボタン）
- `#memo-expand-btn` / `#memo-collapse-btn`（メモの「もっと見る／閉じる」）

これにより、拡大モーダルを開いた状態でも、モーダル自身の要素に対して正しく操作できるようになった
（背後のドロワーが誤って操作されることがなくなった）。

### 副次対応：メモ欄の高さを拡大（2026-07-08）

タスク詳細のメモ入力欄（`#dt-notes`のtextarea）・プレビューエリア（`#dt-preview-area`）の高さを
約2倍に拡大：
- textarea: `rows="6"` → `rows="12"`
- プレビューエリア: `max-height:160px` → `max-height:320px`（「もっと見る」判定の閾値も164→324に追随）

Node.js構文チェック済みでエラーなし。

### 触れなかった箇所

- 認証・決済（Stripe）・RLSまわりは今回のスコープ外で、一切変更していない
- `dt-gantt-toggle`に対応するマークアップは現状コード内に見当たらず（過去機能の残骸と思われる）。
  動作確認はできないが、他の開閉ハンドラと同じ対策のみ機械的に適用した

---

## 🆕 「メール・チャットから起票」機能を追加（2026-07-05）

### 背景・設計思想

Nextビュー（GTDのNext Action）とDashboardで整理はしているが、Teams・メール・口頭依頼が
飛び交って捕捉しきれず集中を乱される、という課題への対応。「AIに優先順位を決めさせる」案も
出たが、優先度判断には人にしか分からない文脈（誰が待っているか・口頭の重み等）が要るため
却下。GTDのCapture→Clarifyのうち、Clarify前段の**Captureの摩擦を減らす**ことに絞った：

- 貼り付けたテキストからAIが行動項目だけを抽出する
- ただし**自動でタスク化はしない**。既存のAIチャット（`add_task`等）は「即実行」の設計だが、
  雑多な文章からの抽出は誤爆のコストが高いため、候補をチェックボックス付きで提示し、人が
  選別してから確定させる「下書き→確認→確定」のフローにした
- 確定した項目は`status:'inbox'`でInboxに入れるのみ。プロジェクト・タグ付けやNextへの
  昇格判断は今まで通り人間が行う（AIに意思決定させない）

### 実装

- エントリポイント: AIチャットパネルのヘッダーに📋ボタンを追加（`data-a="extract-open"`）。
  既存のAIチャット（即実行コマンド用）とは別の専用モーダルとして実装し、責務を分離
- `openExtractModal()`: 貼り付け用テキストエリアのモーダルを表示
- `extractAnalyze()`: 既存の`AI_ENDPOINT`（`ai-chat` Edge Function、変更なし）に対し、
  専用のsystem prompt + `extract_tasks`ツール（`tool_choice`で強制）を渡して呼び出す。
  Edge Function自体はsystem/messages/toolsをそのまま中継する汎用プロキシなので
  **バックエンドの変更・デプロイ不要**で実現できた
- `renderExtractResults()` / `extractConfirm()`: 抽出結果を選択・タイトル編集・期限日編集
  可能なカードとして表示し、選択した件数分だけ`mkTask()`→`saveTask()`でInboxに追加
- 既存のAI機能と同様、Freeプランでは`showUpgradeModal('ai')`でゲート。月間AI利用回数の
  上限もEdge Function側の既存カウンターがそのまま適用される

Node.js構文チェック済みでエラーなし。

---

## 🆕 一括処理モードが完了後も終了しない問題・修正（2026-07-05）

### 症状

一括処理モード（「一括」ボタン）で日付・タグ・プロジェクト・繰り返し・フラグを
一括設定すると、操作自体は成功するが**選択モードが終了せず**、チェックボックス表示
のまま他のビューに遷移してしまう。`S.selectMode`はビューを跨いだグローバル状態
なので、気づかずに他のビュー（Todayなど）へ移動すると、そこでも選択モードのUI
（ドラッグハンドル非表示・チェックだけの行など）になってしまい操作しづらい。

### 原因

`handleBulkEdit()`内の各フィールド処理で、選択モード解除(`S.selectMode=false;
S.selectedIds=[];`)の有無が**フィールドごとにバラバラ**だった：
- ✅ 解除していた：`complete`（完了）・`parent`（親設定）・`detach`（独立化）・`delete`（削除）
- ❌ 解除していなかった：`dates`（日付）・`tags`（タグ）・`project`（プロジェクト）・
  `repeat`（繰り返し）・`flag`（フラグ）

### 修正内容

`dates`/`tags`/`project`/`repeat`/`flag`の完了ハンドラにも`S.selectMode=false;
S.selectedIds=[];`を追加し、全フィールドで一括処理完了時に選択モードを自動終了する
よう統一。モーダルの「キャンセル」ボタンは従来通り選択状態を維持（誤ってキャンセルしても
選び直せるように）。

Node.js構文チェック済みでエラーなし。

---

## 🆕 Dashboard「期限切れ」もっと見るが専用ビューに繋がっていない問題・修正（2026-07-05）

### 症状

Dashboardの「期限切れ」セクションの「もっと見る →」をタップしても、期限切れタスクだけの
一覧は表示されず、実質的に「今日」ビュー（`S.view='today'`）に遷移していた。
`today`ビューは「期限が今日」または「フラグ付き」のタスクしか拾わないため、
期限切れタスクの一部（フラグなし・今日より前が期限）が表示されない不整合があった。

### 原因

`renderDashboard()`内の`section()`呼び出しで、「期限切れ」セクションの`viewName`引数が
誤って`'today'`になっていた（コピペ起因と推測）。専用の`overdue`ビュー自体が存在しなかった。

### 修正内容

新規`overdue`ビューを追加し、新規ビュー追加チェックリスト（本ファイル内、旧セッション記載）
に沿って全箇所を登録：
- `getTasks()`：`dueAt<today`かつ未完了のタスクを抽出するフィルタ条件を追加
- `counts()`：`overdue`件数を追加
- `renderSidebar()`の`ALL_SYS`：サイドバーに「Overdue」項目を追加（Todayの直下）
- `ALL_NAV_ITEMS`：ボトムナビカスタマイズ候補に追加
- `getNavSequence()`の`SYS_VIEWS`：前後ナビゲーション対応
- `renderContent()`の`titles`：タイトルバー文字列
- `VIEW_HELP`：？ツールチップの説明文
- `openViewHelp()`のアイコンmap
- `renderEmpty()`：空状態メッセージ
- `ICONS.overdue`：専用アイコン（アラームクロック風）を追加
- `renderList()`の`showSubsInView`・`renderRow()`の親タスク名表示：`today`/`flagged`と同様に`overdue`でもサブタスクの親タイトルを表示するよう対象に追加
- `renderDashboard()`：「期限切れ」セクションの`viewName`を`'today'`→`'overdue'`に修正

修正後、Node.js構文チェック（本ファイル冒頭のルール①）で全JS文字列の構文エラーがないことを確認済み。



---

## 🚨 Claude作業ルール（再発防止・必読）

### ① index.html のJS文字列を直接編集するときは必ずNode.js構文チェックを通してからpushする

index.htmlの描画関数（`renderDrawer()`など）はJSのテンプレートリテラルではなく**1行の巨大な文字列連結**（`+'<div...>'`形式）になっている。
Pythonでこの文字列を置換するとクォート・バックスラッシュのエスケープが非常に壊れやすく、**過去2回同じ事故が発生した**（左メニュー・下部ナビが消える全壊）。

**必須手順：**
```
1. Python/sedで置換
2. 置換できたか count() で確認（0件ならミス）
3. Node.js で構文チェック ← これを省くと事故になる
4. OK が出たらファイル書き込み・commit・push
```

Node.js構文チェックのコマンド（テンプレ）:
```python
import subprocess, tempfile, os
tmpf = tempfile.mktemp(suffix='.html')
open(tmpf, 'w').write(c)  # c = 修正後のHTML文字列
r = subprocess.run(
    ['node', '-e',
     "const h=require('fs').readFileSync('" + tmpf + "','utf8');"
     "const m=h.match(/<script>([\\s\\S]*?)<\\/script>/g)||[];"
     "const j=m.map(s=>s.replace(/<\\/?script>/g,'')).join('\\n');"
     "try{new Function(j);process.stdout.write('JS_OK\\n');}catch(e){process.stderr.write('JS_ERR:'+e.message+'\\n');}"],
    capture_output=True, text=True
)
os.unlink(tmpf)
# JS_OK が出たらファイル書き込みへ。JS_ERR が出たら書き込み禁止。
```

### ② index.html のJS文字列内に含まれる文字列の実際のバイト列を必ず確認してから置換する

`repr()` でPythonが表示する `\\'` は **ファイル上の1文字の `'`** であり、バックスラッシュではない。
置換対象を構築する前に必ず以下を実行してバイト列を確認すること：
```python
c = open('index.html').read()
idx = c.find('目印となる文字列')
print(repr(c[idx:idx+200]))  # 実際のバイト列を確認
```

### ③ Pythonスクリプトはファイルに書き出してから実行する（heredoc禁止）

`bash_tool` に `<< 'ENDSCRIPT'` で渡すheredoc内にPython文字列リテラルのエスケープシーケンスを混在させると、bashとPython双方のエスケープが干渉して `SyntaxError` になる。
**Pythonスクリプトは必ず `cat > /tmp/fix.py` 等でファイルに書き出し、`python3 /tmp/fix.py` で実行すること。**

---

## 🐛 LogbookがiPadサイドバーに表示されない問題・修正（2026-06-26）

### 症状

iPadの左サイドバーの「ビュー」セクションにLogbookが表示されず、誤完了したタスクを
復元するためのLogbookに辿り着けない。

### 原因

`renderSidebar()`のサイドバー項目構築ロジックが、ボトムナビの保存順（`bnavOrder` =
`localStorage`の`bnav_order`）を基準に並び替えていた。`ALL_SYS`にLogbookが追加
されていても、`bnavOrder`（ユーザーのボトムナビカスタマイズ保存値）にない項目は末尾に
フォールバックするため、スクロールしないと見えない位置に押し込まれていた。

また`ALL_NAV_ITEMS`（ボトムナビカスタマイズ候補リスト）にもLogbookが未登録で、
ボトムナビへの追加もできない状態だった。

### 修正内容

1. `ALL_NAV_ITEMS`に`{v:'completed', label:'Logbook', icon:()=>ICONS.check}`を追加
   → ボトムナビカスタマイズ画面から追加できるようになった
2. `renderSidebar()`のnavItems構築を`ALL_SYS`固定順に変更
   → `bnavOrder`に関係なく、常に設計通りの順序でサイドバーに表示される
3. `getNavSequence()`のハードコード`SYS_VIEWS`に`assigned`/`completed`/`gantt`を追加
   → 前後ナビゲーション（◀▶）でもこれらのビューを拾えるようになった

### 教訓

サイドバー表示のために必要な登録箇所（HANDOVER.mdの「新規ビュー追加時の注意」参照）に
加え、**`ALL_NAV_ITEMS`**も忘れずに追加すること。`ALL_SYS`に入れただけでは、
既存ユーザーの`bnav_order`保存値によっては末尾に押し込まれ、事実上見えない状態になる。
**サイドバーはnow`ALL_SYS`固定順で表示されるため、以後は`ALL_SYS`の項目順が
サイドバーの表示順そのものになる。**

---

## 📝 2026-06-26 セッション④ 作業まとめ

### 実施した修正・改善（全て動作確認済み）

1. **Taskraにタスク追加**（Supabase直接INSERT）
   - 「川島さんからの予約GO改修相談2026/06/26」、予約GOプロジェクト、期限6/29、優先度中

2. **Logbookアイコン復元**（切り戻しで消えていたICONS.archiveを再追加）
   - ICONS定義にarchive（アーカイブ箱SVG）を追加、LogbookがICONS.checkになっていたのを修正

3. **サイドバーのビュー順をALL_SYS固定順に変更**（`148ebf3`）
   - bnav_order（ユーザーのボトムナビ保存順）に引きずられてサイドバー順がバラバラになっていた
   - `navItems=[...ALL_SYS]`（スプレッドコピー）で固定順に。以後改修で順序が変わらない
   - 確定順：Dashboard→Inbox→Next→Today→Forecast→Flagged→Assigned→Review→Logbook→Search→Note→Gantt

4. **フィルタバー刷新完了**（3ステップに分割して安定適用）
   - ステップ1（`cc461e5`）：完了ボタン削除のみ
   - ステップ2（`8f7177b`）：CSS刷新（枠線なし・フラットpill・横スクロール対応）
   - ステップ3（`a9eb2f2`）：セパレーター追加（ツール系｜フィルター群｜ソート）

### ⚠️ フィルタバー壊れた件の教訓

以前フィルタバーを一括変更したら壊れた原因の推測：
- `let html = ...` という変数名がグローバルの`html`と干渉した可能性（今回は`_tfh`に変更）
- `@media(pointer:fine)`の追加がCSSの`{}`バランスに影響した可能性（今回は見送り）
- 今回は3ステップに分けて1つずつ確認しながら適用→問題なく完了

### ⚠️ PWAキャッシュについて（再掲）

SW戦略をnetwork-firstに変えたら悪化した。v50（stale-while-revalidate）のまま維持。
PWA側のSW変更は慎重に。

---

## 📝 2026-06-26 セッション③ 作業まとめ

### 実施した修正（全てコミット済み・動作確認済み）

1. **parseQA: 全角括弧内の曜日が欠落するバグ修正**（`3476008`相当）
   - 例：「7/8（火）9（水）のロードマップ」→「7/8（）9（水）」になっていた
   - `[（(]曜字[）)]`パターンを検出し、括弧内は日付解釈せずタイトルとして保持

2. **goto-proj: スマホでdrawerを閉じてからプロジェクト遷移**
   - タスク詳細のプロジェクト移動ボタンを押しても画面が変わらなかった問題
   - `S.drawerOpen=false`を追加

3. **AI: サブタスクの開始日等を変更できない問題修正**
   - `context.tasks`に`parentTaskId`を追加（AIがサブタスクを識別できなかった）
   - systemPromptに「サブタスクもupdate_taskで更新可能」を明記
   - update_taskのdescriptionにサブタスク対応を追記

4. **プロジェクトチップ（go-proj）のスワイプ誤タップ防止**
   - FAST TAPに`_touchMoved && el.dataset.a==='go-proj'`ガードを追加

5. **タスク追加時にプロジェクト最上部に配置**
   - `topOrderInProject()`ヘルパー追加
   - クイック追加・＋ボタン・Inbox→PJ割り当て時、全て最上部orderをセット

### 未完了：フィルタバーデザイン刷新

フィルタバーの刷新（完了ボタン削除・フラットpill・セパレーター）を試みたが、
適用後にボトムナビ・サイドバーが消える重大バグが再現。2回試みて2回失敗。

**判明していること：**
- フィルタバー単体では過去に動作していた（数時間正常稼働）
- ①〜⑤の修正と組み合わせると壊れる
- シークレットモードでも再現→SW/キャッシュは無関係
- コードのJS/CSSの文法チェックは通っている
- 変数名衝突の可能性：`_tfh`、`_hasQF`、`SEP`等と既存コードの何かが干渉か

**次回やること：**
- `@media(pointer:fine)`の追加がCSSの`}`バランスを崩す可能性を確認
- フィルタバーJS変更を最小限（完了ボタン削除のみ）から段階的に適用
- ブラウザのコンソールエラーを確認できる環境で作業する

### ⚠️ PWAキャッシュについて

PWAのSW戦略を`stale-while-revalidate`→`network-first`に変えたら悪化した（v51）。
v50（stale-while-revalidate）に戻してある。PWA側はSW変更せずに対処すること。

---

## 📝 2026-06-26 セッション② 作業まとめ

このセッションで実施した内容。

1. **LogbookがiPadサイドバーに表示されない問題を修正**（コミット `a6d76ca`）
   - 前セッションでLogbook（completedビュー）は実装済みだったが、サイドバーの並び順が
     ボトムナビ保存順（`bnav_order`）依存だったため、未登録のLogbookが末尾に押し込まれ
     事実上見えない状態になっていた。
   - `renderSidebar()`のnavItems構築を`ALL_SYS`固定順に変更し、常にReviewの直下に表示されるよう修正。
   - `ALL_NAV_ITEMS`にLogbookを追加（ボトムナビカスタマイズ候補に出るように）。
   - `getNavSequence()`のハードコード`SYS_VIEWS`にassigned/completed/ganttを追加。

2. **HANDOVER.md更新**（コミット `a28f3bc`）
   - 上記バグの原因・修正・教訓を記録。

### ⚠️ 今後の注意（今回判明した教訓の補足）

新規ビューを`ALL_SYS`に追加しても、**`ALL_NAV_ITEMS`に入れないとボトムナビカスタマイズ
候補に出ない**。さらに既存ユーザーの`bnav_order`保存値にない項目はサイドバー末尾に
流れていた（今回の修正で`ALL_SYS`固定順になったため以後は問題なし）。

「新規ビュー追加時のチェックリスト」（下記セクション参照）に **`ALL_NAV_ITEMS`への追加**
を必ず含めること。

---

## 📝 2026-06-26 作業まとめ（セッション引き継ぎ）

このセッションで実施した内容。コミット順（古い→新しい）に記載。詳細は各コミットメッセージとこのファイルの各セクション参照。

1. **ボトムナビのSidebar/AIボタン幅バグ修正**：固定フランクのつもりが`flex-shrink:0`のみでflex-growが残り、中央領域と同じ1/3幅になっていた。`flex:0 0 58px`に修正。
2. **AIボタン/パネルのUX改善**：上部AIボタン（✦）はスマホでは下部ナビと重複するため非表示化（PCのみ表示）。AIパネルに背景オーバーレイ＋ドラッグハンドルを追加し、外タップ・下スワイプで閉じられるように。
3. **AIアシスタント（アプリ内チャット）の機能拡張・整理**：
   - `completedTasks`（直近14日の完了タスク）をAIのcontextに追加 → 「今日完了にしたタスク一覧出して」等に対応
   - `complete_task`/`reactivate_task`の2ツールを廃止し`update_task`の`status`フィールド（active/inbox/completed/archived）に統合。コード量削減・保守性向上が目的
4. **Taskra MCPサーバーを新規実装**（`supabase/functions/mcp-server/index.ts`）：Claude.aiのカスタムコネクタからTaskraを直接操作できるように。**手順・トラブルシュートは下の「## MCP連携」セクション参照。動作確認済み**（list_tasks/update_task等で実際にタスク操作・一括期限変更を実施し正常動作を確認）
5. **メモ欄クリアボタンの位置変更**：Note詳細・タスク詳細どちらも、🗑クリアボタンが他ボタンと近すぎて誤タップしやすかったため、ツールバーから削除し下部「•••」メニューに移動
6. **Logbook（完了済み一覧）をサイドバーに追加**：「誤って完了にしたタスクを探して戻したい」という要望に対応。実は`getTasks()`のcompletedフィルタ・`VIEW_HELP`・`titles`・`renderEmpty`まで**以前のセッションで実装済みだったが、サイドバーへの導線だけが欠落**していて誰も到達できない状態だった（後述「新規ビュー追加時の注意」参照）。

### ⚠️ 新規ビュー追加時の注意（今回判明した教訓）

`S.view`に新しい値を追加する際、関連箇所が散らばっているため**1か所だけ実装して終わったつもりになる事故が起きやすい**。チェックリスト：

- [ ] `renderSidebar()`内`ALL_SYS`配列（サイドバー項目）
- [ ] `renderContent()`内`titles`オブジェクト（タイトルバー文字列。**抜けると無言で空白になる**）
- [ ] `VIEW_HELP`オブジェクト（？ツールチップの内容。**抜けると？タップで無反応**）
- [ ] `openViewHelp()`内のアイコンmap（？ツールチップのアイコン）
- [ ] `renderEmpty()`内の空状態メッセージ
- [ ] `getTasks()`内のフィルタ・ソート条件
- [ ] `renderContent()`の`qaHidden`配列・`renderTaskFilters()`の`showToggle`（クイック追加バー・フィルタツールバーを出すか）
- [ ] **`ALL_NAV_ITEMS`への追加**（ボトムナビカスタマイズ候補に出るため。**省くとサイドバー表示順も狂う**ことがあった。基本的に全ビュー追加推奨）

今回の`completed`ビューは上記のほぼ全部が**過去のセッションで実装済み**だったにもかかわらずサイドバー項目だけが無かったため誰にも見えなかった。新規ビュー追加を依頼されたら、まずこのチェックリストで既存実装の有無を確認すると手戻りが減る。

---

## 🚨 タスクが1000件超で読み込まれず消える問題・根本修正（2026-06-23）

### 症状

特定のタスク（例:「発表会」を含むタスク）が一覧にもInboxにも**検索結果にも出ない**。
完全に消えたように見えるが、Supabase上にはデータが存在する（service roleで確認可）。

### 原因

PostgREST（Supabase REST API）は1リクエストあたり**最大1000行**で打ち切る。
`dbAll`/`dbAllNoFilter` は `SB.from('tasks').select('*')` を件数指定なしで投げており、
タスク総数が1000件を超えると**超過分が一切読み込まれない**。読み込まれない＝
`S.tasks`に存在しない＝一覧・Inbox・検索すべてに出ない（検索もS.tasks上での
フィルタなので当然ヒットしない）。

当該ユーザー（mstd0520@gmail.com / 448933d7-...）はタスク1321件（active 331・
inbox 33・completed 957、archive 0）で、上限を321件超過していた。どの行が落ちるかは
PostgRESTの返却順（≒物理順）依存で不定のため、消えるタスクは一見ランダムに見える。

notes(109)/projects(26)/tags(3)/sections(12)は1000未満のため影響なし。tasksのみ。

### 修正内容

`dbAll`/`dbAllNoFilter` を `.range(from,from+999)` で全行をページ取得するよう変更
（`_pageAll`ヘルパーを追加。1ページ1000行、返却が1000未満になるまでループ）。
順序を安定させるため `.order('id',{ascending:true})` を付与。RLSはそのまま効くので
共有プロジェクトのタスクも従来通り取得される。

→ デプロイ後にアプリを再読み込み（PWAは更新反映）すれば、超過分のタスクが全て
復活して見えるようになる。DBの書き換えは一切不要（データは無傷だった）。

### 今後の改善余地（任意）

completed が957件と肥大化しており、今後さらに増えると毎回全件ロードが重くなる。
- 完了タスクは「直近N日 or 直近N件」だけ初期ロードし、Completedビューを開いた時に
  追加取得する遅延ロード化
- もしくは古い完了タスクの定期アーカイブ
を検討するとロード時間・通信量を抑えられる。

---

## 🐛 Inboxのタスクが消える問題・修正（2026-06-23）

### 症状

Inboxに入れたはずのタスクの一部が一覧から消える。サイドバーのInboxバッジ件数は
そのまま（例: バッジ「4」なのに一覧は2件しか出ない）。

### 原因

「現在」フィルタ（`S.hideNotStarted`／開始日が未来＝未着手のタスクを除外）が、
`getTasks()` 内でビューを問わず全ビューに適用されていた（Inboxにも効いていた）。
このため開始日が未来のInboxタスクが一覧から除外されていた。一方、Inboxバッジ件数
（`counts().inbox`）は `hideNotStarted` を考慮しないため、件数と一覧が食い違っていた。

「現在」フィルタはボトムナビのアイコン長押し（500ms）でもトグルされ（通知は上部に
2.2秒のみ）、誤操作で気づかずONになりやすい。`hideNotStarted` はセッション限りの
状態（localStorage非永続）なので、リロードすると消えたタスクは元に戻る。

### 修正内容

`getTasks()` の該当行を `S.view!=='inbox'` でガードし、Inboxビューでは「現在」
フィルタを適用しないよう変更：

```js
// 修正前
if(S.hideNotStarted){tasks=tasks.filter(x=>!isNotStartedTask(x))}
// 修正後
if(S.hideNotStarted&&S.view!=='inbox'){tasks=tasks.filter(x=>!isNotStartedTask(x))}
```

Inboxは「未分類・未整理のタスクを集めて整理する受信箱」であり、開始日が未来でも
必ず表示する必要がある（見えないと整理対象から漏れる）。これによりInbox一覧＝
バッジ件数で一致するようになる。Today／プロジェクト等の他ビューでは従来通り
「現在」フィルタが機能する。

### 補足（未対応・任意）

Inboxビューでもツールバーの「現在」トグルボタンは表示・押下可能なまま（押しても
Inboxでは何も起きないのが正しい動作）。混乱を避けたい場合はInboxビューで同ボタンを
非表示にする選択肢もあるが、今回は最小修正に留めた。

---

## 🚨 Stripe webhook 障害・修正（2026-06-23）

**事象**: Stripeから「taskra-paymentエンドポイントへ9日間連続でエラー」のメールが届き、
Stripeがエンドポイントを自動無効化した（2026-06-14頃〜）。
14リクエストが "other errors" で失敗。この間の課金イベントは全て取りこぼされていた。

**根本原因**: `stripe-webhook` Edge Functionが `verify_jwt: true` で設定されていた。
StripeはSupabase JWTを送れないため、Supabaseミドルウェアが関数本体に到達する前に
401を返していた（stripe-signature検証すら実行されていなかった）。

**修正内容**（Supabase Edge Function v22→v23）:
1. `verify_jwt: false` に変更（セキュリティはstripe-signature検証で維持）
2. `invoice.payment_succeeded` ハンドラを追加
   → これがないと月次自動更新のたびにプランが維持されない恐れがあった

**対応手順（再発時）**:
1. Supabase MCPで stripe-webhook を `verify_jwt: false` で再デプロイ
2. Stripe ダッシュボード → Developers → Webhooks → taskra-payment → 「有効にする」
3. 「イベントの配信」タブでテストイベントを送って確認

**登録済みイベント**（2026-06-23時点）:
- `checkout.session.completed`（初回購入）
- `customer.subscription.created`（サブスク作成）
- `customer.subscription.updated`（プラン変更）
- `customer.subscription.deleted`（解約・ダウングレード）
- `invoice.payment_succeeded`（月次自動更新 ← 今回追加）

**注意**: `verify_jwt` は絶対に `true` に戻さないこと。
Stripe webhookは公開エンドポイントである必要があり、
セキュリティはstripe-signatureヘッダーで担保する。

---

## ⚠️ iPadでタスクの並び替え（ドラッグ）が機能しなくなった（2026-06-20 修正・直前のhover修正の副作用）

### 症状

直前の「2タップ問題」修正（`.nav-item:hover`/`.trow:hover`を`@media(pointer:fine)`で
ガード）の直後、iPadでタスクのドラッグ並び替えが機能しなくなった。iPhoneは問題なし。

### 原因（直前修正の副作用）

タスクのドラッグ&ドロップは画面幅で完全に実装が分岐していた：
- `!isMobile`（幅>768px、iPadはここに該当）→ PC用: ネイティブHTML5 Drag&Drop
  （`.task-drag-handle`への`mousedown`→`draggable=true`→`dragstart`という、
  マウス操作前提の実装）
- `isMobile`（幅<=768px、iPhoneはここに該当）→ 長押しタッチドラッグ
  （`touchstart`/`touchmove`/`touchend`を直接使う、タッチ専用の実装）

iPadは直接指でタッチしていても画面幅だけで「PC」判定されマウス用実装が使われていたが、
これが動いていたのは、WebKitが「`:hover`で見た目が変わる要素はタッチでも合成mousedown
イベントを発火する」という挙動に偶然乗っかっていたため。直前の修正で`.trow:hover`を
`@media(pointer:fine)`配下に移したことで、直接タッチ時にこの合成mousedownが発火しなくなり、
`mousedown`起点の`draggable=true`設定が行われずドラッグが始まらなくなった
（2タップ問題とドラッグ問題は同じWebKitの挙動の表裏だった）。

### 修正内容

画面幅ベースの`if(!isMobile){PC実装}else{タッチ実装}`という排他分岐をやめ、
タッチ対応端末かどうか（`'ontouchstart' in window || navigator.maxTouchPoints>0`）で
タッチドラッグ実装も独立して有効化するよう変更。iPad（幅>768pxかつタッチ対応）では
PC用実装とタッチ用実装の両方が有効になり、指で直接ドラッグした場合は長押しタッチドラッグが、
トラックパッド/マウスでドラッグした場合はネイティブDrag&Dropが、それぞれ適切に動作する。
タッチ開始時に`touchstart`で`preventDefault()`しているため合成mousedownは発生せず、
両実装が同時に有効でも競合しない。

### 教訓

- iPadのようなタッチ＋トラックパッド両対応端末を画面幅だけで「PC」「モバイル」に
  分類するのは危険。入力方式の判定にはタッチ対応の有無（`maxTouchPoints`等）を見るべき。
- WebKitの「hover CSSがあるとタッチでも合成mousedownを発火する」という挙動は、
  一見無関係な機能（hoverの見た目）が別の機能（ネイティブdrag&drop）の動作条件に
  なってしまう典型例。CSSの`:hover`を変更する際は、その要素にmousedown/dragstart等の
  マウスイベント前提のロジックが乗っていないか必ず確認すること。

---

## ⚠️ iPadでプロジェクト/タスクが2タップしないと切り替わらない（2026-06-20 修正）

### 症状

iPadで、サイドバーのプロジェクトをタップしてもタスク一覧がそのプロジェクトの
タスクに切り替わらず、もう一度タップするとようやく切り替わる。タスク一覧から
タスクをタップした時も同様に2タップ必要。iPhoneでは発生しない。

### 原因

`.nav-item:hover`（プロジェクト/ビュー一覧の行）と`.trow:hover`（タスク一覧の行）に
`:hover`のCSSルールが`@media(pointer:fine)`等でガードされず素のまま定義されていた。

iPadOSはMagic Keyboardなどトラックパッド付きアクセサリが使える関係で、画面を直接
指でタップしても「1回目のタップ＝:hover状態の発火」「2回目のタップ＝実際のclickの発火」
という2段階扱いになるWebKit特有の挙動がある（iPhoneにはこの機構がないため発生しない）。
同ファイル内の`.dt-section-head`では既に`@media(pointer:fine)`で正しくガードされており
（5月以前の対応と思われる）、`.nav-item`と`.trow`だけ対応が漏れていた。

### 修正内容

以下のhoverルールを`@media(pointer:fine)`でガードし、ファインポインタ（マウス/
トラックパッド）使用時のみ適用されるよう変更：
- `.nav-item:hover`（プロジェクト・ビュー・タグ一覧の行）
- `.trow:hover`（タスク・ノート一覧の行）
- `.chk:hover`（タスク完了チェックボックス・同種の2タップ症状が起きうるため予防的に修正）
- `.fc-task:hover`（カレンダービューのタスクチップ・同様の理由で予防的に修正）

### 既知の積み残し

`.proj-item:hover .proj-actions{display:flex}` / `.tag-item:hover .tag-actions{display:flex}`
（プロジェクト/タグの編集・削除アイコンをhoverで表示する処理）も同様に素の`:hover`で
未ガードのまま残っている。今回は意図的に触れていない。理由は、`@media(max-width:768px)`で
狭い画面では常時表示されるフォールバックが既にあるが、iPad幅でトラックパッドを
使っていない場合に同様にガードすると、編集・削除アイコンに到達する手段がなくなって
しまう（タップで表示する代替UIが現状ない）ため。プロジェクト行のタップでまだ
2タップが必要な場合はこのルールが原因の可能性があり、その際は「タップで開く
ケバブメニュー」等、別の表示方式の追加が必要になる。

### 教訓

- WebKitのこの挙動は、クリックされる要素自身だけでなく、その要素やhover時に
  見た目が変わる範囲全体に`:hover`ルールがあると発生しうる。1箇所直して終わりにせず、
  同じ要素・同じクラスに複数の`:hover`ルールが重なっていないか確認すること。
- 同じ修正パターン（`@media(pointer:fine)`でガード）が既にコード内の別箇所
  （`.dt-section-head`）に存在していたので、今後新しい`:hover`ルールを追加する際は
  最初からこのパターンに倣うとよい。

---

## ⚠️ iPadでサイドバー左下のユーザーメニューがホームインジケーターに隠れてタップできない（2026-06-20 修正）

### 症状

iPadのサイドバー左下にあるユーザーメニュー（アバター＋名前＋プラン＋▲シェブロン）が
画面の下端にほとんど隠れてしまい、タップできない。

### 原因

`.sidebar-foot`（サイドバー最下部のフッター、ユーザーメニューのトリガーを内包）に
`padding-bottom:env(safe-area-inset-bottom)`が設定されていなかった。モバイル時の
下部ナビ`.bot-nav`には同様の処理が既に入っているが、iPad幅レイアウトで使われる
`.sidebar-foot`側だけ抜けていた。`viewport-fit=cover`を使っている都合上、
ホームインジケーターのジェスチャー領域と要素が重なり、タップ判定もOSのジェスチャーに
奪われてしまっていた。

### 修正内容

`.sidebar-foot`に`padding-bottom:env(safe-area-inset-bottom)`を追加。
ポップアップメニュー自体の位置は`sidebar-foot`の`getBoundingClientRect()`を基準に
JS側で動的計算されているため、追加修正不要で自動的に正しい位置に追従する。

### 検討した代替案（不採用）

UIパターン自体（アバター＋シェブロンを左下に置き、タップで展開）の再検討も検討したが、
Notion/Slack/Linear等の主要プロダクトでも同じ配置・構成が広く使われている定番パターンであり、
今回の問題はパターンの問題ではなく純粋にセーフエリア対応漏れの実装バグと判断し、
UI自体の作り直しは行わなかった。

---

## ⚠️ iPad外部キーボード使用時、コメント入力フォーカスで画面が最上部へ飛ぶ（2026-06-20 修正）

### 症状

タスク詳細のコメント欄をタップ（フォーカス）すると、画面全体が最上部へジャンプする。
iPadに外部キーボードを接続している時に発生・視認されやすい。

### 原因

2026-05-17に一度修正済み（コミット`d15d324`）だったが、対策が`.drawer-body`内の
スクロール補正のみで、`window`/`document.body`レベルの誤スクロールには対応していなかった。
WebKitは、入れ子の`overflow:auto`コンテナ内のinput/textareaへフォーカスした際、
ネイティブの「フォーカス要素を可視領域に入れる」処理で誤って`window`/`body`側を
スクロールしてしまうことがある。オンスクリーンキーボード使用時はキーボード出現に伴う
レイアウト変化とタイミングが重なって目立たないことがあるが、外部キーボード接続時は
オンスクリーンキーボードが出ないためこの誤スクロールがそのまま視認される。

### 修正内容

`document`に`focusin`のグローバルリスナーを追加し、input/textarea/contenteditableへの
フォーカスのたびに`window.scrollTo(0,0)`・`document.documentElement.scrollTop`・
`document.body.scrollTop`を強制的に0へリセット（フォーカス直後＋次フレーム＋350ms後の
3段階）。本アプリは`.layout{height:100vh;overflow:hidden}`設計であり、window/bodyレベルの
スクロールはモバイル・デスクトップ両レイアウトとも常に0であるべきため、全画面・全入力欄に
対して安全に適用できる。

既存の`.drawer-body`内スクロール補正（`_cmSetupInput`内の`inp.onfocus`）は、コメント欄を
drawer-body内で見える位置に保つための別目的の処理として維持。

### 教訓

- 同じ症状の不具合を再度報告された場合、過去の修正が「症状の一部だけ」を対象にしていて
  別の発生経路（このケースでは外部キーボードの有無）でカバーできていなかった可能性を疑う。
- iOS Safariのフォーカス時自動スクロールはCSSや`preventScroll`では完全に制御できないため、
  「発生を防ぐ」のではなく「発生した後に正しい位置へ戻す」リアクティブな補正が現実的。

---

## ⚠️ Supabase接続待ちタイムアウトによるデータ消失バグ（2026-06-20 修正）

### 症状

iPadで登録したタスクがiPhoneに反映されない、または最終的に画面から消える。

### 原因

`init()`はSupabase接続（Supabase-js CDN読み込み＋`auth.getSession()`）が完了するまで
最大5秒待ってからデータをロードしていたが、5秒を超えてタイムアウトすると、未接続のまま
処理を続行していた。その状態だと`dbAll/dbPut/dbDel`がローカル限定の`IndexedDB`版
（Supabaseに一切送信されないバージョン）のままになっており、その間に保存したタスクは
端末のIndexedDBにしか残らない。その後、定期同期（120秒ポーリング・visibilitychange）で
`loadAll()`がSupabase側データで`S.tasks`等を丸ごと上書きするため、ローカル限定で
保存されたデータは画面から消える（＝他端末にも当然反映されない）。

電波の弱い場所・低速回線でCDN読み込みや認証確認が5秒を超えると発生しうる。

### 修正内容

- `init()`: Supabase接続待ちを5秒から20秒に延長。さらにタイムアウトしても未接続のまま
  ローカル限定モードにはフォールバックしないよう変更。`window._sbReady && window._SB`が
  揃わない限り`loadAll`/`seed`/孤立タスク修復などのデータ読み書きを一切行わず、
  赤いエラーバナー（`showConnError()`）を表示し、`waitForSBAndRecover()`が2秒おきに
  接続を確認、接続でき次第自動でデータを再取得して復旧する。
- `setupSB()`: 初期化失敗時に`window._sbReady=true`を立てて「準備完了」と偽装していた
  バグを修正。失敗時は4秒後に自動で`setupSB()`を再試行する（`window._sbSetupDone`フラグで
  二重初期化・認証リスナーの二重登録を防止）。

### 教訓

- オンライン専用（Supabaseが正）のアプリで、接続未確認のままデータ操作系の関数を
  「とりあえず動くローカル代替」にフォールバックさせると、エラーも出ないまま
  サイレントにデータが失われる。未接続時は機能を止めて再試行する方が安全。
- `_sbReady`のようなグローバルフラグを「失敗時にもtrueにする」実装は、呼び出し側が
  フラグだけを見て安全だと誤判断する典型的な事故パターン。失敗時はfalseのまま
  保つか専用のエラーフラグを使うこと。

---

## ⚠️ 作業開始前に必ず読むこと（事故防止）

### git push前の必須チェック

```bash
# 必ずpull --rebaseしてからpush
git pull --rebase
git push
```

**やってはいけないこと:**
- `git pull`なしでいきなり`git push` → リモートの最新コミットを上書き事故が発生する
- Claudeが別セッションで作業した変更がリモートにある場合、pushが競合で失敗 → `--force`で解決しようとすると最新データが消える

**push失敗時の対応:**
```bash
git pull --rebase
git push
# コンフリクトが出た場合
git checkout --theirs index.html   # リモート優先で解決（慎重に）
git add index.html
git rebase --continue --no-edit
git push
```

**再発防止のルール:**
1. 毎セッション開始時は必ず`git clone`からやり直す（古いローカルを使い回さない）
2. push直前に`git status` / `git log --oneline -3`で確認する
3. コンフリクト解決は`--theirs`（リモート優先）を基本とする

---

## ⚠️ FAST TAPとdrawerの相互作用（重要）

### 概要

`index.html`末尾付近に **FAST TAP** というグローバルリスナーがある：

```js
document.addEventListener('touchend', function(e) {
  const el = e.target.closest('[data-a],[data-k],button');
  e.preventDefault();
  el.click(); // touchendで強制click発火
}, {passive: false});
```

### 危険なケース

drawerが開いている状態で、drawerの背後にある要素（リスト行など）の上に
drawerの✕ボタンが重なっている場合：

1. `touchend` → FAST TAPが`e.target`（実際に触れた要素）を取得
2. drawerの背後の`[data-a]`要素をclick() → 意図しない処理が実行される
3. その後ブラウザのネイティブclickが来て正しい処理が走るが、順番が逆になる

### 対処済みの修正

```js
// drawer open時はdrawer外の要素へのFAST TAPを無効化
const dr = document.getElementById('drawer');
if (dr && dr.classList.contains('open') && !el.closest('#drawer')) return;
```

### 教訓

- drawerを新しいビューから開く実装をする時は必ずFAST TAPの影響を考慮する
- `close-note` / `close-drawer` などの閉じる操作は必ず `renderNoteDrawer()` + `renderContent()` の両方を呼ぶ
- searchビューでnoteを開いた際に✕が効かない症状が出たらFAST TAPを疑う

---

## 概要

| 項目 | 内容 |
|---|---|
| アプリ名 | Taskra（タスクラ） |
| リポジトリ | https://github.com/dat0925/task-app |
| 公開URL | https://app.taskra.jp |
| 種別 | PWA（Progressive Web App）/ シングルファイル構成 |
| フロントエンド | Vanilla JS + HTML（index.html 単一ファイル） |
| バックエンド | Supabase（プロジェクトref: `sfhtvtcmgueystyuhzvd`） |
| ホスティング | GitHub Pages（CNAME: app.taskra.jp） |
| デプロイ方法 | GitHub mainブランチへのpushで自動反映 |

---

## Supabase 構成

### 接続情報

| 項目 | 値 |
|---|---|
| Project URL | `https://sfhtvtcmgueystyuhzvd.supabase.co` |
| Anon Key | index.html内に直書き（anonキーはRLSで保護されているため公開可） |
| 注意 | `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` は予約語。Edge Functionsでは `SB_ANON_KEY` / `SB_SERVICE_ROLE_KEY` を使うこと |

### テーブル一覧・RLS状態

| テーブル | RLS | ポリシー概要 |
|---|---|---|
| `tasks` | ✅ 有効 | `user_id = auth.uid()` で自分のデータのみ |
| `projects` | ✅ 有効 | 同上 |
| `sections` | ✅ 有効 | 同上 |
| `tags` | ✅ 有効 | 同上 |
| `backups` | ✅ 有効 | 同上 |
| `app_settings` | ✅ 有効 | 同上（`user_id` + `key` で複合ユニーク） |
| `notes` | ✅ 有効 | 同上（2026-06-05 対応済み） |
| `task_comments` | ✅ 有効 | 同上 |
| `workspaces` | ✅ 有効 | メンバーのみ参照・ownerのみ編集削除 |
| `workspace_members` | ✅ 有効 | 同じワークスペースのメンバーのみ参照 |
| `user_plans` | ✅ 有効 | Stripe連携プラン管理 |
| `ai_usage` | ✅ 有効 | AIチャット使用量管理 |
| `push_notifications` | ✅ 有効 | プッシュ通知トークン管理 |

#### RLS ポリシーの型キャストについて

`notes` テーブルのみ `user_id::uuid = auth.uid()` の形式（他テーブルは `user_id = auth.uid()::text`）。
notesの `user_id` カラムは `text` 型だが、このSupabaseプロジェクトでは `auth.uid()` が `uuid` 型を返すため逆方向キャストが必要。

### Edge Functions

| 関数名 | 用途 |
|---|---|
| `ai-chat` | AIチャットプロキシ（JWT認証・プラン別使用制限） |
| `send-push` | プッシュ通知送信 |
| `cron-cleanup-notifications` | 通知クリーンアップ（定期実行） |
| `cron-line-reminder` | LINEリマインダー（定期実行） |
| `cron-repeat-start` | 繰り返しタスク開始処理（定期実行） |
| `cron-task-reminders` | タスクリマインダー（定期実行） |
| `line-webhook` | LINE Webhook受信 |
| `notify-mention` | メンション通知 |
| `stripe-portal` | Stripeカスタマーポータル |
| `stripe-webhook` | Stripe Webhook受信 |
| `mcp-server` | Claude.ai用 remote MCPサーバー（詳細は次セクション） |

---

## MCP連携（Claude.aiカスタムコネクタでTaskraを操作）

2026-06-26に追加。Claude.aiのチャットから直接Taskraのタスクを追加・更新・完了・削除できる。

### 仕組み（重要：シングルユーザー専用）

- Edge Function `mcp-server`（`supabase/functions/mcp-server/index.ts`）が remote MCP server として動作
- 認証はOAuthではなく**共有シークレットトークン方式**。Supabase Secretsの`MCP_SECRET_TOKEN`と、接続URLの`?token=`パラメータが一致すれば誰でも操作できてしまう
- どのSupabaseユーザーのデータを操作するかは`MCP_USER_EMAIL`（Secrets）で**固定**されている。マルチユーザー非対応
- **このトークンを知っている人は誰でもTaskraのデータを読み書きできる。** パスワードと同じ扱いで、チャットのスクショや公開リポジトリに値そのものを書かないこと（このファイルにも実際の値は書いていない）

### 再接続・初回設定の手順

1. Supabaseダッシュボード → Taskraプロジェクト（`sfhtvtcmgueystyuhzvd`） → Edge Functions → Secrets で以下が設定されていることを確認
   - `MCP_SECRET_TOKEN`：ランダムな長い文字列（実際の値は1Password/Notion等の非公開先を参照。このリポジトリには書かない）
   - `MCP_USER_EMAIL`：Taskraにログインしているメールアドレス
2. Claude.ai（Pro/Max）→ Customize → Connectors → 「＋」→ カスタムコネクタを追加
3. URLに以下を入力（`<TOKEN>`は上記`MCP_SECRET_TOKEN`の実際の値に置き換える）：
   ```
   https://sfhtvtcmgueystyuhzvd.supabase.co/functions/v1/mcp-server?token=<TOKEN>
   ```
4. OAuthのClient ID/Secret欄は空欄でよい
5. 「追加」→ Taskraコネクタが「未接続」から接続済みに変わればOK

### トークンを失効・再発行したい場合

1. 新しいトークンを生成（例：`python3 -c "import secrets; print(secrets.token_urlsafe(32))"`）
2. Supabase Secretsの`MCP_SECRET_TOKEN`を新しい値に更新
3. Claude.aiの既存「Taskra」コネクタを削除し、新トークン入りのURLで再追加（古いURLは無効化される）

### 提供しているツール（`mcp-server/index.ts`内`TOOLS`参照）

`list_tasks` / `add_task` / `update_task`（status指定で完了・未完了・アーカイブも可） / `delete_task` / `add_subtask` / `list_projects` / `add_project` / `list_tags` / `add_tag` / `add_note`

### トラブルシュート

- Claude.ai側で「サインインサービスへの登録ができませんでした」エラー → 大抵はSecrets未設定/値の打ち間違い（`=`や空白が混入するミスが多い）。Supabase:get_logsで`mcp-server`の401が出ていないか確認
- 動作確認はSupabase MCP（`Supabase:get_logs` service=`edge-function`）でリクエストログを見るのが早い

---

## プラン構成

| プラン | 月額 | タスク上限 | プロジェクト上限 | ノート上限 |
|---|---|---|---|---|
| Free | 無料 | 制限あり | 制限あり | 制限あり |
| Standard | ¥480 | 無制限 | 無制限 | 無制限 |
| Premium | ¥780 | 無制限 | 無制限 | 無制限 + AI機能 |

---

## フロントエンド設計

### 重要な実装ルール

- **日本語テキストを含むファイルの編集**: `str_replace` ツールはマルチバイト文字で失敗する。`python3 -c` インラインスクリプト（heredocで`/tmp/fix_xxx.py`に書いてから実行）で `str.replace()` を使うこと
- **Flex コンテナ内のテキスト**: テキストノードを直接 flex child にしない。必ず `<span>` で囲む
- **LINE内ブラウザ対応**: deep linkには `?openExternalBrowser=1` を付与してSafari/Chromeで開くようにする

### グローバル状態管理

- `S` オブジェクトに全アプリ状態を集約
- `_touchMoved` フラグでスクロールとタップを区別（touchstart でリセット）
- `_touchStartX` / `_touchStartY` で水平・垂直スワイプを両方検知
- `_touchTargetIsChev` でtouchstart時にchevron要素かどうかを判定（アコーディオン制御）
- `_lastFilterClickAt` でフィルタボタンの連打防止（400ms debounce）
- `_lastActionAt` で全ボタンの連打防止（350ms debounce）
- `_noDebounce` セット: `date-adj`系・`close-note`・`close-drawer` は連打防止対象外

### Supabase DBアクセス関数

| 関数 | 用途 |
|---|---|
| `dbAll(table)` | `user_id` フィルタ付き全件取得 |
| `dbAllNoFilter(table)` | フィルタなし全件取得（workspace_members等に使用） |
| `dbPut(table, item)` | upsert（`user_id` を自動付与） |
| `dbDel(table, id)` | id指定削除 |

### renderContentのオーバーライドに注意

searchビューの入力同期のため、`renderContent`が以下のようにラップされている：

```js
const _origRenderContent = renderContent;
renderContent = function() {
  _origRenderContent();
  if (S.view === 'search') {
    const srch = document.getElementById('srch');
    if (srch && srch.value !== S.search) srch.value = S.search;
  }
};
```

`renderContent`を参照・上書きする修正をする時は両方の参照に注意すること。

---

## UI仕様（スマホ）

### アコーディオン（サイドバー・タスク詳細）

- スマホ（≤768px）では **▶ chevron部分のタップのみ**で開閉
- バー全体タップでは開閉しない（誤操作防止）
- `touchstart`時に `_touchTargetIsChev` を判定して保持し、click時に参照
- chevronのCSSに `padding:10px` でタップ領域を拡大
- アコーディオンバーのタップ時の色変化は `pointer:coarse` で無効化済み

### mob-action-bar（タスク詳細・Note詳細）

**タスク詳細:** `削除 / 完了 / ••• / ↑ / ↓ / ✕`

`•••` メニュー内容:
- 📝 Noteに変換して削除
- 📋 複製する
- 🔗 タスクのURLをコピー

**Note詳細:** `削除 / ••• / ↑ / ↓ / ✕`

`•••` メニュー内容:
- ✅ タスクに変換して削除
- 📋 複製する
- 🔗 NoteのURLをコピー

### フィルタバー

現在・完了・共有 の固定ボタンに加え、タグクイックフィルターを追加:
- `S.tags` から「仕事」「個人」「開発」を名前で検索して動的表示
- タグが存在しない場合は非表示
- タップでON/OFF（排他選択・1タグのみ）
- ONの時はタグカラーでハイライト
- 削除済み: 優先ボタン・全開/全閉ボタン

---

## Task ↔ Note 相互変換

- **Task→Note**: `•••` メニュー「Noteに変換して削除」→ notes画面に遷移
  - `title`→`title` / `notes`→`body` / `tagIds`引き継ぎ / タスク削除
- **Note→Task**: `•••` メニュー「タスクに変換して削除」→ タスク詳細に遷移
  - `title`→`title` / `body`→`notes` / `tagIds`引き継ぎ / Note削除
- コメントは引き継がない（仕様）
- 変換前に確認モーダルあり

---

## Note検索の仕様

- 検索結果からNoteを開いても `S.view='search'` / `S.search` をリセットしない
- searchビューでも `if(S.noteOpen)renderNoteDrawer()` を呼ぶよう修正済み
- `close-note` は `renderNoteDrawer() + renderContent()` の両方を呼ぶ（片方だけでは閉じない）
- `close-note` は `_noDebounce` 対象（検索結果クリック直後でも確実に閉じられる）
- 閉じると検索結果一覧に戻る

---

## マイグレーション履歴

| ファイル | 内容 |
|---|---|
| `20250513_ai_usage.sql` | AI使用量テーブル |
| `20260513_enable_rls.sql` | 主要テーブルRLS有効化 |
| `20260513_user_plans_stripe.sql` | Stripeプラン管理テーブル |
| `20260514_grant_api_access.sql` | APIアクセス権限設定 |
| `20260515_task_comments.sql` | タスクコメントテーブル |
| `20260516_workspaces.sql` | チーム・ワークスペース機能 |
| `20260519_fix_workspace_invite_rls.sql` | ワークスペース招待RLSバグ修正 |
| `20260520_fix_workspace_rls_recursion.sql` | ワークスペースRLS再帰バグ修正 |
| `20260520_push_notifications.sql` | プッシュ通知テーブル |
| `20260605_enable_rls_notes.sql` | **notesテーブルRLS有効化（セキュリティ修正）** |

---

## 既知の注意事項・過去のバグ

- **Supabase Realtime 禁止**: WAL polling によりDisk IOが枯渇した。クライアント側Realtimeは削除済み・テーブルpublicationも無効化済み
- **プッシュ通知**: 過去にJSON stringify/parseミスマッチのバグあり（修正済み）
- **Google OAuth**: callbackページがないとリダイレクトループが起きる（修正済み）
- **`user_id=null` レコード**: `importFromIndexedDB` で古いデータを取り込む際に発生しうる。現在はRLSで保護されているが要注意
- **dt-memo-toggle重複**: 以前ハンドラが2箇所定義されていてチェックなし側が先に実行されるバグがあった（修正済み）
- **FAST TAP × drawer**: drawerが開いている時にFAST TAPがdrawer背後の要素を誤クリックする問題（修正済み・上記セクション参照）

---

## 関連プロダクト（raシリーズ）

| アプリ | URL | リポジトリ | 概要 |
|---|---|---|---|
| Taskra | app.taskra.jp | dat0925/task-app | タスク管理（本リポジトリ） |
| Flowra | flowra.taskra.jp | dat0925/flowra | 家計管理PWA |
| Tavera | tavera.taskra.jp | dat0925/tavera | 食事計画PWA |
| taskra-web | taskra.jp | dat0925/taskra-web | マーケティングサイト |

---

## デプロイ手順

```bash
# 1. 毎回必ずcloneからやり直す（使い回し禁止）
git clone https://github.com/dat0925/task-app.git
cd task-app

# 2. git設定（クローン直後に必須）
git config user.email "deploy@taskra.jp"
git config user.name "Taskra Deploy"

# 3. 編集後、必ずpull --rebaseしてからpush
git add index.html
git commit -m "feat: 変更内容"
git pull --rebase   # ← 必須。これを省くと上書き事故が起きる
git push https://<PAT>@github.com/dat0925/task-app.git main
```

GitHub PagesのCNAMEは `app.taskra.jp`。pushから反映まで数十秒〜1分程度。

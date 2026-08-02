// =====================================================================
// Taskra シークレットメモ E2EE 暗号ユーティリティ（フェーズ1）
//
// 設計思想:
//   - すべて「純関数」。状態（鍵）はここでは一切保持しない。
//     アプリ側（index.html）がマスター鍵をメモリ上のモジュールスコープ変数で
//     保持し、この関数群に引数として渡す。単体テストしやすくするため。
//   - 「マスター鍵」と「鍵のアンロック手段（パスフレーズ / リカバリーコード）」を
//     分離する。フェーズ2（WebAuthn PRF）では新しいアンロック手段でマスター鍵を
//     ラップし直すだけで済むよう、wrap/unwrap を汎用化してある。
//   - Web Crypto API のみ使用（外部暗号ライブラリ不可）。
//     ブラウザと Node.js 20+ の両方で globalThis.crypto.subtle が使えるため、
//     このファイルはそのまま実行時（<script type="module">）でも
//     単体テスト（node --test）でも動く。
//
// 【重要・仕様上の注意】
//   ここで暗号化した secret_note は、検索対象外・AIアシスタント連携対象外・
//   LINE通知対象外である。復号は所有者のブラウザ内でのみ行い、平文・鍵・
//   パスフレーズ・リカバリーコードは絶対にサーバーへ送信しない。
//   マスター鍵・導出鍵は localStorage / sessionStorage に保存しない。
// =====================================================================

/** @type {Crypto} */
const _crypto = globalThis.crypto;
if (!_crypto || !_crypto.subtle) {
  throw new Error('Web Crypto API が利用できない環境です');
}
const subtle = _crypto.subtle;

// PBKDF2 の反復回数。仕様の下限60万回を満たす。
export const PBKDF2_ITERATIONS = 600000;
// マスター鍵のバイト長（AES-256 = 32バイト）
const MASTER_KEY_BYTES = 32;
// AES-GCM の IV 長（96bit 推奨）
const IV_BYTES = 12;
// PBKDF2 salt 長
const SALT_BYTES = 16;
// パスフレーズ検証用の既知平文
const VERIFICATION_PLAINTEXT = 'taskra-secret-ok';

const _enc = new TextEncoder();
const _dec = new TextDecoder();

// ---------------------------------------------------------------------
// 低レベル: バイト列 <-> base64（ブラウザ / Node どちらでも動く）
// ---------------------------------------------------------------------

/** Uint8Array を base64 文字列にする */
export function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

/** base64 文字列を Uint8Array にする */
export function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 複数の Uint8Array を連結する */
function concatBytes(...arrays) {
  let total = 0;
  for (const a of arrays) total += a.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}

/** 暗号学的に安全なランダムバイト列を返す */
export function randomBytes(n) {
  return _crypto.getRandomValues(new Uint8Array(n));
}

// ---------------------------------------------------------------------
// 低レベル: 鍵導出 / AES-GCM
// ---------------------------------------------------------------------

/**
 * パスフレーズやリカバリーコードなどの文字列から、PBKDF2 で
 * AES-GCM 用のラップ鍵（CryptoKey）を導出する。
 * @param {string} secret パスフレーズ / リカバリーコード（サーバー送信禁止）
 * @param {Uint8Array} salt ユーザーごとのランダムsalt
 * @param {number} [iterations]
 * @returns {Promise<CryptoKey>} AES-GCM 256bit の導出鍵（非抽出）
 */
export async function deriveWrappingKey(secret, salt, iterations = PBKDF2_ITERATIONS) {
  const baseKey = await subtle.importKey(
    'raw', _enc.encode(secret), 'PBKDF2', false, ['deriveKey']
  );
  return subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false, // 非抽出（メモリ外に出さない）
    ['encrypt', 'decrypt']
  );
}

/**
 * AES-GCM で暗号化し、base64(iv + ciphertext) を返す。
 * @param {CryptoKey} key
 * @param {Uint8Array} data 平文バイト列
 * @returns {Promise<string>} base64(iv + ct)
 */
export async function aesGcmEncrypt(key, data) {
  const iv = randomBytes(IV_BYTES);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, data));
  return bytesToBase64(concatBytes(iv, ct));
}

/**
 * base64(iv + ciphertext) を AES-GCM で復号する。
 * 鍵が誤っている場合は GCM 認証タグ検証に失敗して例外を投げる
 * （＝これ自体がパスフレーズ検証にもなる）。
 * @param {CryptoKey} key
 * @param {string} blobB64 base64(iv + ct)
 * @returns {Promise<Uint8Array>} 平文バイト列
 */
export async function aesGcmDecrypt(key, blobB64) {
  const buf = base64ToBytes(blobB64);
  const iv = buf.slice(0, IV_BYTES);
  const ct = buf.slice(IV_BYTES);
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv }, key, ct));
}

// ---------------------------------------------------------------------
// マスター鍵の生成 / ラップ / アンラップ
//   マスター鍵は「生の32バイト（Uint8Array）」としてアプリのメモリ上に保持する。
//   ノート暗号化時に importKey で都度 CryptoKey 化する。
//   ラップ鍵（パスフレーズ由来 / リカバリー由来）で raw バイトを暗号化＝ラップ。
// ---------------------------------------------------------------------

/** 新しいマスター鍵（32バイトのランダム列）を生成する */
export function generateMasterKey() {
  return randomBytes(MASTER_KEY_BYTES);
}

/**
 * マスター鍵をラップ鍵で暗号化（ラップ）して base64 文字列にする。
 * フェーズ2で別のアンロック手段を足すときも、このラップ鍵を差し替えるだけで済む。
 * @param {CryptoKey} wrappingKey deriveWrappingKey の戻り値
 * @param {Uint8Array} masterKeyRaw
 * @returns {Promise<string>} base64(iv + ct)
 */
export async function wrapMasterKey(wrappingKey, masterKeyRaw) {
  return aesGcmEncrypt(wrappingKey, masterKeyRaw);
}

/**
 * ラップされたマスター鍵をラップ鍵で復号（アンラップ）して raw バイトに戻す。
 * @param {CryptoKey} wrappingKey
 * @param {string} wrappedB64
 * @returns {Promise<Uint8Array>} masterKeyRaw
 */
export async function unwrapMasterKey(wrappingKey, wrappedB64) {
  return aesGcmDecrypt(wrappingKey, wrappedB64);
}

// ---------------------------------------------------------------------
// ノート（secret_note）本文の暗号化 / 復号
//   マスター鍵の raw バイトから都度 CryptoKey を作る。
//   IV は暗号化のたびにランダム生成し、暗号文と共に保存する。
// ---------------------------------------------------------------------

/** マスター鍵 raw バイトからノート用 AES-GCM CryptoKey を作る */
async function importMasterKey(masterKeyRaw) {
  return subtle.importKey('raw', masterKeyRaw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/**
 * 平文文字列をマスター鍵で暗号化し base64(iv + ct) を返す。
 * この戻り値を tasks とは別テーブル task_secret_notes に保存する。
 * @param {Uint8Array} masterKeyRaw
 * @param {string} plaintext
 * @returns {Promise<string>} base64(iv + ct)
 */
export async function encryptNote(masterKeyRaw, plaintext) {
  const key = await importMasterKey(masterKeyRaw);
  return aesGcmEncrypt(key, _enc.encode(plaintext));
}

/**
 * base64(iv + ct) をマスター鍵で復号して平文文字列を返す。
 * @param {Uint8Array} masterKeyRaw
 * @param {string} blobB64
 * @returns {Promise<string>}
 */
export async function decryptNote(masterKeyRaw, blobB64) {
  const key = await importMasterKey(masterKeyRaw);
  return _dec.decode(await aesGcmDecrypt(key, blobB64));
}

// ---------------------------------------------------------------------
// パスフレーズ検証用ブロブ（既知平文をマスター鍵で暗号化したもの）
// ---------------------------------------------------------------------

/** 既知平文をマスター鍵で暗号化した検証ブロブを作る */
export async function makeVerificationBlob(masterKeyRaw) {
  return encryptNote(masterKeyRaw, VERIFICATION_PLAINTEXT);
}

/**
 * マスター鍵で検証ブロブを復号し、既知平文と一致するか確認する。
 * 一致すれば「このマスター鍵は正しい」＝パスフレーズ解錠成功。
 * @returns {Promise<boolean>}
 */
export async function verifyMasterKey(masterKeyRaw, verificationBlobB64) {
  try {
    const pt = await decryptNote(masterKeyRaw, verificationBlobB64);
    return pt === VERIFICATION_PLAINTEXT;
  } catch (_e) {
    return false; // 復号失敗＝鍵が誤り
  }
}

// ---------------------------------------------------------------------
// リカバリーコード生成
//   紛らわしい文字（0/O, 1/I/L 等）を除いた大文字英数から生成し、
//   4文字ごとにハイフンで区切って読みやすくする。
// ---------------------------------------------------------------------

const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 0,O,1,I,L を除外

/**
 * リカバリーコードを生成する。既定で 24文字（4文字×6グループ）。
 * 例: "AB3D-9FGH-..." エントロピー ≒ log2(31)*24 ≒ 118bit。
 * @param {number} [groups] グループ数
 * @param {number} [perGroup] 1グループの文字数
 * @returns {string}
 */
export function generateRecoveryCode(groups = 6, perGroup = 4) {
  const n = groups * perGroup;
  const rnd = randomBytes(n);
  let out = '';
  for (let i = 0; i < n; i++) {
    if (i > 0 && i % perGroup === 0) out += '-';
    out += RECOVERY_ALPHABET[rnd[i] % RECOVERY_ALPHABET.length];
  }
  return out;
}

/** リカバリーコードを正規化（大文字化・ハイフン/空白除去）。入力揺れを吸収する */
export function normalizeRecoveryCode(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// ---------------------------------------------------------------------
// 高レベル API: セットアップ / 解錠 / パスフレーズ変更 / リカバリー
//   これらは DB に保存する「鍵素材（key material）」オブジェクトを組み立て・展開する。
//   保存先カラム: kdf_salt / verification_blob / wrapped_master_key /
//                 wrapped_master_key_recovery
//   ※ salt はいずれも base64 文字列としてやり取りする。
//     wrapped_master_key_recovery はリカバリー用 salt を内包する自己完結ブロブ。
// ---------------------------------------------------------------------

/**
 * 初回セットアップ。マスター鍵を新規生成し、パスフレーズ鍵とリカバリー鍵で
 * それぞれラップした「鍵素材」と、平文表示すべきリカバリーコードを返す。
 * @param {string} passphrase
 * @returns {Promise<{material: object, recoveryCode: string}>}
 *   material = { kdf_salt, verification_blob, wrapped_master_key, wrapped_master_key_recovery }
 */
export async function setupSecretKeys(passphrase) {
  const masterKeyRaw = generateMasterKey();

  // パスフレーズ由来のラップ
  const pSalt = randomBytes(SALT_BYTES);
  const pKey = await deriveWrappingKey(passphrase, pSalt);
  const wrapped_master_key = await wrapMasterKey(pKey, masterKeyRaw);

  // リカバリーコード由来のラップ（salt を内包した自己完結ブロブにする）
  const recoveryCode = generateRecoveryCode();
  const rSalt = randomBytes(SALT_BYTES);
  const rKey = await deriveWrappingKey(normalizeRecoveryCode(recoveryCode), rSalt);
  const rWrappedInner = await wrapMasterKey(rKey, masterKeyRaw); // base64(iv+ct)
  // salt を先頭に付けて再度 base64 化（salt + rawブロブ）
  const wrapped_master_key_recovery = bytesToBase64(
    concatBytes(rSalt, base64ToBytes(rWrappedInner))
  );

  const verification_blob = await makeVerificationBlob(masterKeyRaw);

  return {
    material: {
      kdf_salt: bytesToBase64(pSalt),
      verification_blob,
      wrapped_master_key,
      wrapped_master_key_recovery,
    },
    recoveryCode,
  };
}

/**
 * パスフレーズでマスター鍵を解錠する。
 * @param {string} passphrase
 * @param {object} material 保存済み鍵素材
 * @returns {Promise<Uint8Array|null>} 成功時マスター鍵 raw、失敗時 null
 */
export async function unlockWithPassphrase(passphrase, material) {
  try {
    const pSalt = base64ToBytes(material.kdf_salt);
    const pKey = await deriveWrappingKey(passphrase, pSalt);
    const masterKeyRaw = await unwrapMasterKey(pKey, material.wrapped_master_key);
    // verification_blob で二重確認
    if (await verifyMasterKey(masterKeyRaw, material.verification_blob)) {
      return masterKeyRaw;
    }
    return null;
  } catch (_e) {
    return null; // アンラップ失敗＝パスフレーズ誤り
  }
}

/**
 * リカバリーコードでマスター鍵を解錠する（パスフレーズ忘却時）。
 * @param {string} recoveryCode
 * @param {object} material
 * @returns {Promise<Uint8Array|null>}
 */
export async function unlockWithRecovery(recoveryCode, material) {
  try {
    const buf = base64ToBytes(material.wrapped_master_key_recovery);
    const rSalt = buf.slice(0, SALT_BYTES);
    const innerBlobB64 = bytesToBase64(buf.slice(SALT_BYTES));
    const rKey = await deriveWrappingKey(normalizeRecoveryCode(recoveryCode), rSalt);
    const masterKeyRaw = await unwrapMasterKey(rKey, innerBlobB64);
    if (await verifyMasterKey(masterKeyRaw, material.verification_blob)) {
      return masterKeyRaw;
    }
    return null;
  } catch (_e) {
    return null;
  }
}

/**
 * パスフレーズ変更。現行のマスター鍵（解錠済み raw）を新パスフレーズ鍵で
 * ラップし直すだけ。secret_note の再暗号化は不要。
 * リカバリー側のラップは変更しない（リカバリーコードは不変）。
 * @param {Uint8Array} masterKeyRaw 解錠済みマスター鍵
 * @param {string} newPassphrase
 * @param {object} material 既存の鍵素材（wrapped_master_key_recovery を引き継ぐ）
 * @returns {Promise<object>} 更新後の鍵素材（kdf_salt / wrapped_master_key / verification_blob を更新）
 */
export async function rewrapForNewPassphrase(masterKeyRaw, newPassphrase, material) {
  const pSalt = randomBytes(SALT_BYTES);
  const pKey = await deriveWrappingKey(newPassphrase, pSalt);
  const wrapped_master_key = await wrapMasterKey(pKey, masterKeyRaw);
  const verification_blob = await makeVerificationBlob(masterKeyRaw);
  return {
    ...material,
    kdf_salt: bytesToBase64(pSalt),
    wrapped_master_key,
    verification_blob,
  };
}

/**
 * リカバリー解錠後に、新パスフレーズを設定する（＝再ラップ）。
 * rewrapForNewPassphrase と同じだが、意図を明確にするための別名。
 */
export const resetPassphraseAfterRecovery = rewrapForNewPassphrase;

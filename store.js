// 漫画進捗管理 — 端末内ストア（IndexedDB）
// PC版のローカルサーバー（server.py）と同じ操作・同じデータ形式を、端末の中だけで処理する。
// データは外部に送信しない。

const DB_NAME = 'manga-progress';
const DB_VERSION = 1;
const UNDO_LIMIT = 50;

let db = null;
let state = null;
let rev = 0;
const undo = [];               // [{label, snap}]
const thumbUrls = new Map();   // thumbId → objectURL

export class OpError extends Error { }

const nid = () => Math.random().toString(16).slice(2, 8) + Date.now().toString(16).slice(-6);
const clone = (o) => JSON.parse(JSON.stringify(o));
const emptyState = () => ({ version: 1, episodes: [], logs: [], active: null, meta: {} });

// ------------------------------------------------------------ IndexedDB

function req(r) {
  return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
}
function tx(stores, mode = 'readonly') { return db.transaction(stores, mode); }
function done(t) {
  return new Promise((res, rej) => { t.oncomplete = () => res(); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error); });
}

export async function open() {
  db = await new Promise((res, rej) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv');
      if (!d.objectStoreNames.contains('thumbs')) d.createObjectStore('thumbs');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  state = (await req(tx('kv').objectStore('kv').get('state'))) || emptyState();
  state.meta ||= {};
  try { await navigator.storage?.persist?.(); } catch { }
  cleanupThumbs().catch(() => { });
  return payload();
}

async function save() {
  const t = tx('kv', 'readwrite');
  t.objectStore('kv').put(state, 'state');
  await done(t);
}

export async function persisted() {
  try { return await navigator.storage?.persisted?.(); } catch { return false; }
}

// ------------------------------------------------------------ thumbnails

// 画像は Blob ではなく {type, buf: ArrayBuffer} で保存する（古い iOS の IndexedDB は Blob の保存に不具合があるため）
const toRecord = async (blob) => ({ type: blob.type || 'image/jpeg', buf: await blob.arrayBuffer() });
const toBlob = (rec) => (rec instanceof Blob ? rec : new Blob([rec.buf], { type: rec.type }));

export async function thumbUrl(id) {
  if (!id) return null;
  if (thumbUrls.has(id)) return thumbUrls.get(id);
  const rec = await req(tx('thumbs').objectStore('thumbs').get(id));
  if (!rec) return null;
  const u = URL.createObjectURL(toBlob(rec));
  thumbUrls.set(id, u);
  return u;
}
export function cachedThumbUrl(id) { return thumbUrls.get(id) || null; }

async function putThumbs(blobs) {
  const recs = [];
  for (const b of blobs) recs.push(await toRecord(b));  // 変換を済ませてから1回のトランザクションで書く
  const t = tx('thumbs', 'readwrite');
  const s = t.objectStore('thumbs');
  const ids = recs.map((r) => { const id = 't' + nid(); s.put(r, id); return id; });
  await done(t);
  return ids;
}

// 現在のデータと取消履歴のどこからも参照されていないサムネイルを消す
async function cleanupThumbs() {
  const refs = new Set();
  const add = (st) => st.episodes.forEach((e) => e.pages.forEach((p) => p.thumb && refs.add(p.thumb)));
  add(state);
  undo.forEach((u) => add(u.snap));
  const keys = await req(tx('thumbs').objectStore('thumbs').getAllKeys());
  const dead = keys.filter((k) => !refs.has(k));
  if (!dead.length) return;
  const t = tx('thumbs', 'readwrite');
  dead.forEach((k) => t.objectStore('thumbs').delete(k));
  await done(t);
}

// ------------------------------------------------------------ operations

const newPage = (no) => ({ id: nid(), no, target: null, targetLocked: false, completed: false, completedAt: null, thumb: null });

function getEp(id) {
  const ep = state.episodes.find((e) => e.id === id);
  if (!ep) throw new OpError('話が見つかりません');
  return ep;
}
function getPage(ep, id) {
  const p = ep.pages.find((x) => x.id === id);
  if (!p) throw new OpError('ページが見つかりません');
  return p;
}
function getLog(id) {
  const l = state.logs.find((x) => x.id === id);
  if (!l) throw new OpError('作業ログが見つかりません');
  return l;
}
function labelOf(eid, pid) {
  try { const ep = getEp(eid); return `${ep.number}話 ${getPage(ep, pid).no}P`; } catch { return '?'; }
}

function stopActive(end) {
  const a = state.active;
  if (!a) return null;
  end = Math.max(Math.floor(end), a.start);
  let log = null;
  if (end > a.start) {
    log = { id: nid(), episodeId: a.episodeId, pageId: a.pageId, start: a.start, end };
    state.logs.push(log);
  }
  state.active = null;
  return log;
}

function parseTarget(v) {
  if (v === null || v === undefined || v === '') return null;
  v = Math.floor(Number(v));
  if (!(v > 0) || v > 1000 * 60) throw new OpError('目標時間が不正です');
  return v;
}

const OPS = {
  create_episode(a, now) {
    const title = String(a.title ?? '').trim(), number = String(a.number ?? '').trim();
    const pages = Math.floor(Number(a.pages) || 0);
    if (!title) throw new OpError('作品名を入力してください');
    if (!number) throw new OpError('話数を入力してください');
    if (!(pages >= 1 && pages <= 500)) throw new OpError('総ページ数は 1〜500 で入力してください');
    if (!a.deadline) throw new OpError('締切日時を入力してください');
    const ep = { id: nid(), title, number, deadline: Math.floor(a.deadline), createdAt: now, pages: Array.from({ length: pages }, (_, i) => newPage(i + 1)) };
    state.episodes.push(ep);
    return { label: `${number}話を作成`, episodeId: ep.id };
  },

  update_episode(a) {
    const ep = getEp(a.episodeId);
    const title = String(a.title ?? ep.title).trim(), number = String(a.number ?? ep.number).trim();
    if (!title || !number) throw new OpError('作品名と話数は必須です');
    ep.title = title; ep.number = number;
    if (a.deadline) ep.deadline = Math.floor(a.deadline);
    const pages = Math.floor(Number(a.pages) || ep.pages.length);
    if (pages < ep.pages.length) throw new OpError('ページ数を減らすことはできません（進捗データ保護のため）');
    if (pages > 500) throw new OpError('総ページ数は 500 までです');
    while (ep.pages.length < pages) ep.pages.push(newPage(ep.pages.length + 1));
    return { label: `${number}話の設定を変更` };
  },

  delete_episode(a) {
    const ep = getEp(a.episodeId);
    if (state.active?.episodeId === ep.id) throw new OpError('計測中の話は削除できません。先に停止してください');
    state.episodes = state.episodes.filter((e) => e !== ep);
    state.logs = state.logs.filter((l) => l.episodeId !== ep.id);
    return { label: `${ep.number}話を削除` };
  },

  set_target(a) {
    const ep = getEp(a.episodeId), p = getPage(ep, a.pageId);
    if (p.targetLocked && !a.force) throw new OpError('このページの目標時間は作業開始時に固定されています');
    const v = parseTarget(a.minutes);
    if (p.targetLocked && v === null) throw new OpError('固定済みの目標時間は空にできません');
    if (v === p.target) return {};
    p.target = v;
    return { label: `${ep.number}話 ${p.no}P の目標時間を変更` };
  },

  start(a, now) {
    const ep = getEp(a.episodeId), p = getPage(ep, a.pageId);
    const act = state.active;
    if (act && act.pageId === p.id) return {};
    if (p.target == null) throw new OpError(`${p.no}P の目標時間が未入力です。先に目標時間を入力してください`);
    if (p.completed) throw new OpError(`${p.no}P は完成済みです。作業するには完成を解除してください`);
    if (act) {
      if (!a.switch) throw new OpError('他のページを計測中です');
      stopActive(now);
    }
    if (!p.targetLocked) { p.targetLocked = true; p.targetLockedAt = now; }
    state.active = { episodeId: ep.id, pageId: p.id, start: now, lastBeat: now };
    return { label: `${ep.number}話 ${p.no}P 作業開始` };
  },

  stop(a, now) {
    const act = state.active;
    if (!act) return {};
    const lbl = labelOf(act.episodeId, act.pageId);
    const log = stopActive(now);
    return { label: `${lbl} 作業停止`, log };
  },

  recover(a, now) {
    const act = state.active;
    if (!act) return {};
    const lbl = labelOf(act.episodeId, act.pageId);
    if (a.mode === 'continue') return {};
    if (a.mode === 'discard') { state.active = null; return { label: `${lbl} 未終了セッションを破棄` }; }
    let end;
    if (a.mode === 'lastBeat') end = act.lastBeat || act.start;
    else if (a.mode === 'now') end = now;
    else if (a.mode === 'custom') {
      end = Math.floor(a.end);
      if (!(end > act.start)) throw new OpError('終了時刻は開始時刻より後にしてください');
      end = Math.min(end, now);
    } else throw new OpError('不明な復元方法');
    stopActive(end);
    return { label: `${lbl} 未終了セッションを確定` };
  },

  set_complete(a, now) {
    const ep = getEp(a.episodeId), p = getPage(ep, a.pageId);
    const d = !!a.completed;
    if (d === p.completed) return {};
    if (d && state.active?.pageId === p.id) stopActive(now);
    p.completed = d;
    p.completedAt = d ? now : null;
    return { label: `${ep.number}話 ${p.no}P ${d ? '完成' : '完成解除'}` };
  },

  edit_log(a, now) {
    const log = getLog(a.logId);
    const start = Math.floor(a.start), end = Math.floor(a.end);
    if (!(end > start)) throw new OpError('終了時刻は開始時刻より後にしてください');
    if (end > now + 60000) throw new OpError('終了時刻が未来になっています');
    if (end - start > 48 * 3600000) throw new OpError('1回の作業が48時間を超えています。時刻を確認してください');
    log.start = start; log.end = end; log.edited = now;
    return { label: `${labelOf(log.episodeId, log.pageId)} の作業ログを修正` };
  },

  delete_log(a) {
    const log = getLog(a.logId);
    state.logs = state.logs.filter((l) => l !== log);
    return { label: `${labelOf(log.episodeId, log.pageId)} の作業ログを削除` };
  },

  // a.thumbIds は putThumbs 済みの ID（apply の外で保存してから呼ぶ）
  set_thumbs(a, now) {
    const ep = getEp(a.episodeId);
    const ids = a.thumbIds || [];
    if (!ids.length) throw new OpError('画像がありません');
    if (a.extend) while (ep.pages.length < ids.length && ep.pages.length < 500) ep.pages.push(newPage(ep.pages.length + 1));
    const n = Math.min(ids.length, ep.pages.length);
    for (let i = 0; i < n; i++) { ep.pages[i].thumb = ids[i]; ep.pages[i].thumbUpdatedAt = now; }
    ep.thumbsUpdatedAt = now;
    return { label: `${ep.number}話のサムネイル更新（${n}P）`, updated: n };
  },
};

function payload(extra) {
  return { ok: true, state, now: Date.now(), rev, undoLabel: undo.length ? undo[undo.length - 1].label : null, ...extra };
}

// サーバー版の /api/op と同じ形で結果を返す
export async function apply(op, args = {}) {
  const now = Date.now();
  try {
    if (op === 'heartbeat') {
      if (state.active) { state.active.lastBeat = now; await save(); }
      return { ok: true };
    }
    if (op === 'undo') {
      if (!undo.length) throw new OpError('取り消せる操作がありません');
      const { label, snap } = undo.pop();
      state = snap;
      rev++;
      await save();
      return payload({ result: { message: `「${label}」を取り消しました` } });
    }
    const fn = OPS[op];
    if (!fn) throw new OpError('不明な操作: ' + op);
    const snap = clone(state);
    let result;
    try {
      result = fn(args, now) || {};
    } catch (e) {
      state = snap;
      throw e;
    }
    const label = result.label;
    delete result.label;
    if (label) {
      undo.push({ label, snap });
      if (undo.length > UNDO_LIMIT) undo.shift();
      rev++;
      await save();
    }
    return payload({ result });
  } catch (e) {
    if (e instanceof OpError) return { ok: false, error: e.message };
    console.error(e);
    return { ok: false, error: '保存に失敗しました: ' + (e.message || e) };
  }
}

export async function setThumbs(episodeId, blobs, extend) {
  const thumbIds = await putThumbs(blobs);
  return apply('set_thumbs', { episodeId, thumbIds, extend });
}

export function getPayload() { return payload(); }

// ------------------------------------------------------------ CSV

function hm(minutes, signed = false) {
  if (minutes == null) return '';
  const sign = signed ? (minutes >= 0 ? '+' : '-') : '';
  const m = Math.floor(Math.abs(minutes));
  return `${sign}${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}
const p2 = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const hhmm = (d) => `${p2(d.getHours())}:${p2(d.getMinutes())}`;
const round1 = (x) => Math.round(x * 10) / 10;

function splitByDay(start, end) {
  const out = [];
  let cur = start;
  while (cur < end) {
    const d = new Date(cur);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const segEnd = Math.min(next, end);
    out.push({ start: cur, end: segEnd, toMidnight: segEnd === next });
    cur = segEnd;
  }
  return out;
}

export function buildCsv(episodeId) {
  const byPage = new Map();
  for (const l of state.logs) {
    if (!byPage.has(l.pageId)) byPage.set(l.pageId, []);
    byPage.get(l.pageId).push(l);
  }
  const q = (v) => { v = String(v ?? ''); return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
  const rows = [['作品名', '話数', 'ページ番号', '目標時間', '実績時間', '差分', '完成状態', '作業日', '作業開始時刻', '作業終了時刻', '作業時間',
    '目標(分)', '実績(分)', '差分(分)', '作業時間(分)', 'ログID']];
  for (const ep of state.episodes) {
    if (episodeId && ep.id !== episodeId) continue;
    for (const p of ep.pages) {
      const logs = (byPage.get(p.id) || []).slice().sort((a, b) => a.start - b.start);
      const actual = logs.reduce((s, l) => s + l.end - l.start, 0) / 60000;
      const tgt = p.target;
      const diff = p.completed && tgt != null ? actual - tgt : null;
      const base = [ep.title, ep.number, p.no, hm(tgt), hm(actual), diff != null ? hm(diff, true) : '', p.completed ? '完成' : '未完成'];
      const nums = [tgt ?? '', round1(actual), diff != null ? round1(diff) : ''];
      if (!logs.length) { rows.push([...base, '', '', '', '', ...nums, '', '']); continue; }
      for (const l of logs) {
        for (const s of splitByDay(l.start, l.end)) {
          const mins = (s.end - s.start) / 60000;
          rows.push([...base, ymd(new Date(s.start)), hhmm(new Date(s.start)), s.toMidnight ? '24:00' : hhmm(new Date(s.end)), hm(mins),
            ...nums, round1(mins), l.id]);
        }
      }
    }
  }
  return '﻿' + rows.map((r) => r.map(q).join(',')).join('\r\n');
}

// ------------------------------------------------------------ backup

const blobToDataUrl = (b) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
async function dataUrlToBlob(u) { return (await fetch(u)).blob(); }

// 全データ（サムネイル込み）を1つの JSON にする
export async function exportBackup() {
  const ids = new Set();
  state.episodes.forEach((e) => e.pages.forEach((p) => p.thumb && ids.add(p.thumb)));
  const thumbs = {};
  const store = tx('thumbs').objectStore('thumbs');
  const recs = {};
  for (const id of ids) recs[id] = await req(store.get(id));
  for (const [id, rec] of Object.entries(recs)) if (rec) thumbs[id] = await blobToDataUrl(toBlob(rec));
  return JSON.stringify({ app: 'manga-progress', format: 1, exportedAt: Date.now(), state, thumbs });
}

// 書き出したファイルを実際に保存できたときに呼ぶ
export async function markBackup() {
  state.meta.lastBackup = Date.now();
  await save();
}

export async function importBackup(text) {
  let data;
  try { data = JSON.parse(text); } catch { throw new OpError('バックアップファイルを読み込めません'); }
  // PC版の data.json（state のみ）も読み込める
  const st = data.app === 'manga-progress' ? data.state : data;
  if (!st || !Array.isArray(st.episodes) || !Array.isArray(st.logs)) throw new OpError('漫画進捗管理のバックアップではありません');
  const blobs = {};
  for (const [id, u] of Object.entries(data.thumbs || {})) blobs[id] = await toRecord(await dataUrlToBlob(u));
  // await を挟むとトランザクションが閉じるので、画像の変換が終わってからまとめて書き換える
  const t = tx('thumbs', 'readwrite');
  const s = t.objectStore('thumbs');
  s.clear();
  for (const [id, b] of Object.entries(blobs)) s.put(b, id);
  await done(t);
  st.meta ||= {};
  // PC版のサムネイルパス（thumbs/xxx.jpg）は端末に無いので外す
  st.episodes.forEach((e) => e.pages.forEach((p) => { if (p.thumb && !blobs[p.thumb]) p.thumb = null; }));
  thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  thumbUrls.clear();
  state = st;
  undo.length = 0;
  rev++;
  await save();
  return payload();
}

export function stats() {
  return { lastBackup: state.meta.lastBackup || null, logs: state.logs.length, episodes: state.episodes.length };
}

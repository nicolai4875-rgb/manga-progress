// 漫画進捗管理 v0.1 — iPad / ブラウザ版（PWA）
// 実績時間は常に作業ログから算出する（ページに実績値は保存しない）。
// データはすべて端末内（IndexedDB）に保存し、外部には送信しない。
import * as store from './store.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MIN = 60000, HOUR = 3600000, DAY = 86400000;

let S = null;            // 保存データ
let undoLabel = null;
let currentEpId = lsGet('currentEp');
let view = 'main';
let hview = 'episodes';
let hSel = { episodes: null, days: null };
let recoveryChecked = false;
let compact = false;     // 作業中画面（ポップアップモード）を表示しているか

// ホーム画面から起動しているか（Safari のタブとホーム画面アプリではデータが別になる）
const IS_STANDALONE = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
const IS_IOS = /iP(ad|hone|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

const now = () => Date.now();

function lsGet(k) { try { return localStorage.getItem('mp.' + k); } catch { return null; } }
function lsSet(k, v) { try { localStorage.setItem('mp.' + k, v); } catch { } }

// ------------------------------------------------------------ format

function fmtHM(ms) {                       // 4:18
  if (ms == null) return '—';
  const m = Math.floor(Math.abs(ms) / MIN);
  return `${ms < 0 ? '-' : ''}${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}
function fmtDiff(ms) {                     // +0:42 / -0:40
  if (ms == null) return '—';
  const m = Math.round(Math.abs(ms) / MIN);
  return `${ms >= 0 ? '+' : '-'}${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
}
function fmtHMS(ms) {                      // 01:42:18
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
}
function fmtDeadline(ms, long) {           // 2日 05:31 / 2日 05時間 31分
  const m = Math.floor(Math.abs(ms) / MIN);
  const d = Math.floor(m / 1440), h = Math.floor(m / 60) % 24, mi = m % 60;
  const p = (n) => String(n).padStart(2, '0');
  if (long) return `${d ? d + '日 ' : ''}${p(h)}時間 ${p(mi)}分`;
  return `${d ? d + '日 ' : ''}${p(h)}:${p(mi)}`;
}
function fmtDate(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}
function fmtDateTime(ms) {
  const d = new Date(ms);
  const w = '日月火水木金土'[d.getDay()];
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}(${w}) ${fmtClock(ms)}`;
}
function fmtClock(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function toLocalInput(ms) {                // datetime-local の値
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * MIN);
  return d.toISOString().slice(0, 16);
}
// 文字列の日時は Safari のバージョンで解釈が揺れるので、数値から組み立てる
function fromLocalInput(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5]).getTime() : null;
}
function dayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dayKeyDate(k) { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); }

// "6" → 360, "6:30" → 390, "1.5" → 90, "90m" → 90, "" → null
function parseTarget(v) {
  v = String(v).trim().replace(/[０-９：．]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
  if (!v) return null;
  let m;
  if ((m = v.match(/^(\d+):(\d{1,2})$/))) return +m[1] * 60 + +m[2];
  if ((m = v.match(/^(\d+)\s*(m|分)$/i))) return +m[1];
  if ((m = v.match(/^(\d+(?:\.\d+)?)\s*(h|時間)?$/i))) return Math.round(parseFloat(m[1]) * 60);
  return NaN;
}

// 作業ログを 0:00 で分割 → [{day, start, end}]
function splitByDay(start, end) {
  const out = [];
  let cur = start;
  while (cur < end) {
    const d = new Date(cur);
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
    const segEnd = Math.min(next, end);
    out.push({ day: dayKey(cur), start: cur, end: segEnd, toMidnight: segEnd === next });
    cur = segEnd;
  }
  return out;
}

// ------------------------------------------------------------ API

let chain = Promise.resolve();
// 操作は順番に処理する（目標入力 → 作業開始 などの順序を保証）
function queued(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => { });
  return p;
}
function op(name, args = {}) {
  return queued(async () => {
    const j = await store.apply(name, args);
    if (!j.ok) { toast(j.error, true); return null; }
    if (j.state) applyState(j);
    if (j.result?.message) toast(j.result.message);
    return j.result || {};
  });
}

async function load() {
  try {
    applyState(await store.open());
  } catch (e) {
    console.error(e);
    $('#empty').hidden = false;
    $('#empty').innerHTML = `<p><b>データを読み込めませんでした。</b></p>
      <p class="muted">プライベートブラウズでは保存できません。通常の Safari、またはホーム画面に追加したアプリから開いてください。</p>
      <p class="muted" style="font-size:12px">${esc(e?.message || e)}</p>`;
  }
}

function applyState(j) {
  S = j.state;
  undoLabel = j.undoLabel;
  if (!S.episodes.find((e) => e.id === currentEpId)) {
    const sorted = [...S.episodes].sort((a, b) => b.createdAt - a.createdAt);
    currentEpId = S.active?.episodeId || sorted[0]?.id || null;
  }
  render();
  renderNotice();
  if (!recoveryChecked) { recoveryChecked = true; checkRecovery(); }
}

// ------------------------------------------------------------ derived values

function logsByPage() {
  const m = new Map();
  for (const l of S.logs) {
    if (!m.has(l.pageId)) m.set(l.pageId, []);
    m.get(l.pageId).push(l);
  }
  return m;
}

function pageStats(page, logs, t = now()) {
  let actual = 0;
  for (const l of logs || []) actual += l.end - l.start;
  const running = S.active?.pageId === page.id ? Math.max(0, t - S.active.start) : 0;
  const act = actual + running;
  const tgt = page.target != null ? page.target * MIN : null;
  const rate = tgt ? act / tgt : null;
  const over = !page.completed && tgt != null && act > tgt;
  const remaining = page.completed ? 0 : (tgt == null || over) ? null : tgt - act;
  return { logged: actual, act, tgt, rate, over, remaining, diff: tgt != null ? act - tgt : null, running: running > 0 || S.active?.pageId === page.id };
}

function episodeStats(ep, lbp, t = now()) {
  let est = 0, overCount = 0, noTarget = 0, done = 0, actual = 0, target = 0;
  for (const p of ep.pages) {
    const st = pageStats(p, lbp.get(p.id), t);
    actual += st.act;
    if (st.tgt) target += st.tgt;
    if (p.completed) { done++; continue; }
    if (st.tgt == null) { noTarget++; continue; }
    if (st.over) overCount++;
    else est += st.remaining;
  }
  return { est, overCount, noTarget, done, actual, target, total: ep.pages.length };
}

const curEp = () => S?.episodes.find((e) => e.id === currentEpId) || null;
function findPage(pid) {
  for (const ep of S.episodes) for (const p of ep.pages) if (p.id === pid) return { ep, p };
  return null;
}

// ------------------------------------------------------------ render

function render() {
  if (!S) return;
  // 計測が終わったら（どこで停止・取消しても）通常表示に戻る
  if (compact && !S.active) exitCompact();
  renderTopbar();
  if (view === 'main') renderMain(); else renderHistory();
  renderActiveBar();
  renderMini();
}

function renderTopbar() {
  const sel = $('#epSelect');
  const eps = [...S.episodes].sort((a, b) => b.createdAt - a.createdAt);
  sel.innerHTML = eps.length
    ? eps.map((e) => `<option value="${e.id}" ${e.id === currentEpId ? 'selected' : ''}>${esc(e.title)} ${esc(e.number)}話</option>`).join('')
    : '<option>（話がありません）</option>';
  sel.disabled = !eps.length;
  $('#btnEditEp').disabled = !curEp();
  $('#btnPdf').disabled = false;
  const u = $('#btnUndo');
  u.disabled = !undoLabel;
  u.title = undoLabel ? `直前操作の取消: 「${undoLabel}」 (Ctrl+Z)` : '取り消せる操作はありません';
  $$('.tab').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  $('#viewMain').hidden = view !== 'main';
  $('#viewHistory').hidden = view !== 'history';
}

function renderMain() {
  const ep = curEp();
  $('#empty').hidden = !!ep;
  $('#summary').hidden = !ep;
  $('.gridtools').hidden = !ep;
  if (!ep) { $('#grid').innerHTML = ''; return; }
  lsSet('currentEp', ep.id);
  const lbp = logsByPage();
  $('#epInfo').innerHTML = `<b>${esc(ep.title)}</b> ${esc(ep.number)}話 ・ 全${ep.pages.length}P ・ 締切 ${fmtDateTime(ep.deadline)}`
    + (ep.thumbsUpdatedAt ? ` ・ サムネイル更新 ${fmtDate(ep.thumbsUpdatedAt)} ${fmtClock(ep.thumbsUpdatedAt)}` : '');
  renderSummary();

  const focused = document.activeElement?.classList.contains('target') ? document.activeElement.closest('.card')?.dataset.page : null;
  $('#grid').innerHTML = ep.pages.map((p) => cardHTML(ep, p, pageStats(p, lbp.get(p.id)))).join('');
  if (focused) $(`.card[data-page="${focused}"] .target`)?.focus();
  fillThumbs();
}

// サムネイルは端末内DBから非同期で読み込む
function fillThumbs() {
  $$('img[data-thumb]:not([src])').forEach(async (img) => {
    const u = await store.thumbUrl(img.dataset.thumb);
    if (u) img.src = u;
  });
}

function cardHTML(ep, p, st) {
  const pct = st.rate == null ? 0 : Math.min(100, Math.round(st.rate * 100));
  const cls = ['card', st.running && 'active', st.over && 'over', p.completed && 'done'].filter(Boolean).join(' ');
  let badge = '';
  if (st.running) badge = '<span class="badge run">計測中</span>';
  else if (p.completed) badge = '<span class="badge done">完成</span>';
  else if (st.over) badge = '<span class="badge over">超過中</span>';
  let rest;
  if (p.completed) rest = `<span class="k">差分</span><span class="v ${st.diff > 0 ? 'plus' : 'minus'}" data-f="diff">${fmtDiff(st.diff)}</span>`;
  else if (st.over) rest = `<span class="k">残り</span><span class="v over" data-f="rest">超過中</span>`;
  else rest = `<span class="k">残り</span><span class="v" data-f="rest">${fmtHM(st.remaining)}</span>`;
  const tgtVal = p.target != null ? fmtHM(p.target * MIN) : '';
  return `<div class="${cls}" data-page="${p.id}">
    <div class="thumb">
      ${p.thumb ? `<img data-thumb="${esc(p.thumb)}" ${store.cachedThumbUrl(p.thumb) ? `src="${store.cachedThumbUrl(p.thumb)}"` : ''} alt="" draggable="false">` : '<span class="noimg">No image</span>'}
      <div class="fill" data-h="${pct}" style="height:${pct}%"></div>
      ${badge}<span class="pno">${p.no}P</span>
      ${st.rate != null ? `<span class="pct" data-f="pct">${pct}%</span>` : ''}
    </div>
    <div class="meta">
      <span class="k">目標${p.targetLocked ? ' <span class="lock" title="作業開始時に固定済み（ログ画面から修正可）">🔒</span>' : ''}</span>
      <span class="v"><input class="target ${p.target == null ? 'unset' : ''}" value="${tgtVal}" placeholder="例 6:00" ${p.targetLocked ? 'disabled' : ''} title="目標時間（6 / 6:30 / 1.5 / 90m）" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" enterkeyhint="next"></span>
      <span class="k">実績</span><span class="v" data-f="act">${fmtHM(st.act)}</span>
      ${rest}
    </div>
    <div class="actions">
      ${st.running
      ? '<button class="btn start running" data-act="stop">■ 停止</button>'
      : `<button class="btn start" data-act="start" ${p.completed ? 'disabled' : ''} title="${p.target == null ? '目標時間を入力すると開始できます' : '作業開始'}">▶ 作業開始</button>`}
      <button class="btn complete ${p.completed ? 'on' : ''}" data-act="complete" title="${p.completed ? 'クリックで完成を解除' : '完成にする'}">${p.completed ? '完成済' : '完成'}</button>
      <button class="btn logs" data-act="logs" title="作業ログ">≡</button>
    </div>
  </div>`;
}

function renderSummary() {
  const ep = curEp();
  if (!ep) return;
  const t = now();
  const es = episodeStats(ep, logsByPage(), t);
  const dl = ep.deadline - t;
  const today = new Date(t); const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1).getTime();
  const stats = [
    dl >= 0 ? { k: '締切まで', v: fmtDeadline(dl, true), c: dl < DAY ? 'warn' : '' } : { k: '締切超過', v: fmtDeadline(dl, true), c: 'alert' },
    { k: '今日残り', v: fmtHM(midnight - t) },
    { k: '概算残り', v: fmtHM(es.est), c: es.est > dl ? 'alert' : '' },
    { k: '超過中', v: `${es.overCount}<small>P</small>`, c: es.overCount ? 'alert' : '' },
    { k: '完成', v: `${es.done}<small> / ${es.total}P</small>` },
    { k: '実績合計', v: fmtHM(es.actual) },
  ];
  if (es.noTarget) stats.push({ k: '目標未入力', v: `${es.noTarget}<small>P</small>`, c: 'warn' });
  $('#summary').innerHTML = stats.map((s) => `<div class="stat ${s.c || ''}"><div class="k">${s.k}</div><div class="v">${s.v}</div></div>`).join('');
}

function renderActiveBar() {
  const bar = $('#activeBar');
  const a = S.active;
  if (!a) { bar.hidden = true; return; }
  const f = findPage(a.pageId);
  bar.hidden = false;
  bar.innerHTML = `<span class="dot"></span><b>計測中</b>
    <span>${f ? `${esc(f.ep.title)} ${esc(f.ep.number)}話 ${f.p.no}P` : '?'}</span>
    <span class="clock" data-f="clock">${fmtHMS(now() - a.start)}</span>
    <span style="margin-left:auto"></span>
    ${a.episodeId !== currentEpId ? '<button class="btn sm" data-bar="goto">この話を表示</button>' : ''}
    <button class="btn sm" data-bar="mini">ミニ表示</button>
    <button class="btn sm stop" data-bar="stop">■ 停止</button>`;
}

// 1秒ごとの更新（DOM全体は作り直さない）
function tick() {
  if (!S) return;
  if (compact) { renderMini(); return; }
  const t = now();
  if (view === 'main' && curEp()) {
    renderSummary();
    if (S.active && S.active.episodeId === currentEpId) {
      const card = $(`.card[data-page="${S.active.pageId}"]`);
      const f = findPage(S.active.pageId);
      if (card && f) {
        const st = pageStats(f.p, logsByPage().get(f.p.id), t);
        const pct = st.rate == null ? 0 : Math.min(100, Math.round(st.rate * 100));
        const fill = $('.fill', card); fill.style.height = pct + '%'; fill.dataset.h = pct;
        const pe = $('[data-f=pct]', card); if (pe) pe.textContent = pct + '%';
        $('[data-f=act]', card).textContent = fmtHM(st.act);
        const r = $('[data-f=rest]', card);
        // 目標超過の瞬間はカード全体を描き直す
        if (st.over !== card.classList.contains('over')) renderMain();
        else if (r && !st.over) r.textContent = fmtHM(st.remaining);
      }
    }
  }
  if (S.active) {
    const c = $('[data-f=clock]', $('#activeBar'));
    if (c) c.textContent = fmtHMS(t - S.active.start);
  }
  renderMini();
}

// ------------------------------------------------------------ 作業中画面（ポップアップモード）
// iPad では他のアプリの上に重ねられないので、アプリ全体を「作業中」画面に切り替える。
// Slide Over / Split View で CLIP STUDIO の横に細く出しておくと、残り時間を見ながら作業できる。

function miniHTML() {
  const a = S.active;
  const f = a && findPage(a.pageId);
  if (!f) return '<div class="mini"><div class="ttl">計測していません</div></div>';
  const t = now();
  const es = episodeStats(f.ep, logsByPage(), t);
  const st = pageStats(f.p, logsByPage().get(f.p.id), t);
  const dl = f.ep.deadline - t;
  const d = new Date(t); const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
  const turl = f.p.thumb && store.cachedThumbUrl(f.p.thumb);
  return `<div class="mini">
    <div class="ttl">${esc(f.ep.number)}話 ${f.p.no}P<small>${esc(f.ep.title)}</small></div>
    <div class="elapsed"><span class="dot"></span>${fmtHMS(t - a.start)}</div>
    <div class="mini-body">
      ${turl ? `<div class="mini-thumb"><img src="${turl}" alt=""><div class="fill" style="height:${Math.min(100, Math.round((st.rate || 0) * 100))}%"></div></div>` : ''}
      <div class="mini-rows">
        <div class="r"><span>このページ</span><b class="${st.over ? 'over' : ''}">${fmtHM(st.act)} / ${fmtHM(st.tgt)}</b></div>
        <div class="r"><span>${dl >= 0 ? '締切まで' : '締切超過'}</span><b class="${dl < 0 ? 'over' : ''}">${fmtDeadline(dl)}</b></div>
        <div class="r"><span>今日残り</span><b>${fmtHM(midnight - t)}</b></div>
        <div class="r"><span>概算残り</span><b>${fmtHM(es.est)}</b></div>
        <div class="r"><span>超過中</span><b class="${es.overCount ? 'over' : ''}">${es.overCount}P</b></div>
      </div>
    </div>
    <p class="mini-hint">CLIP STUDIO に切り替えても計測は続きます</p>
    <div class="btns">
      <button class="stopbtn" data-mini="stop">■ 停止</button>
      <button class="expbtn" data-mini="expand" title="計測を続けたまま一覧に戻る">一覧</button>
    </div>
  </div>`;
}

function renderMini() {
  if (!compact) return;
  $('#compactRoot').innerHTML = miniHTML();
  const f = S.active && findPage(S.active.pageId);
  if (f?.p.thumb && !store.cachedThumbUrl(f.p.thumb)) store.thumbUrl(f.p.thumb).then((u) => u && renderMini());
}

function enterCompact() {
  if (!S?.active) return;
  compact = true;
  document.activeElement?.blur?.();
  document.body.classList.add('compact');
  window.scrollTo(0, 0);
  renderMini();
}
function exitCompact() {
  if (!compact) return;
  compact = false;
  document.body.classList.remove('compact');
  $('#compactRoot').innerHTML = '';
  render();
}
const openMini = enterCompact;
const closeMini = exitCompact;

// ------------------------------------------------------------ actions

async function startPage(pid) {
  const ep = curEp();
  const f = findPage(pid);
  if (!f) return;
  // 入力途中の目標時間があれば先に確定する（op キューで順序保証）
  const inp = $(`.card[data-page="${pid}"] .target`);
  if (inp && !inp.disabled) commitTarget(inp);
  let sw = false;
  if (S.active && S.active.pageId !== pid) {
    const cur = findPage(S.active.pageId);
    if (!confirm(`${cur ? cur.p.no + 'P' : '他のページ'} を計測中です。\n停止して ${f.p.no}P の作業を開始しますか？`)) return;
    sw = true;
  }
  if (await op('start', { episodeId: ep.id, pageId: pid, switch: sw })) enterCompact();
}

async function stopActive() {
  if (!S.active) return;
  await op('stop');
  closeMini();
}

function commitTarget(inp) {
  const pid = inp.closest('.card').dataset.page;
  const f = findPage(pid);
  if (!f || f.p.targetLocked) return;
  const v = parseTarget(inp.value);
  if (Number.isNaN(v) || v === 0) {
    toast('目標時間の形式が不正です（例: 6 / 6:30 / 1.5 / 90m）', true);
    inp.value = f.p.target != null ? fmtHM(f.p.target * MIN) : '';
    return;
  }
  if (v === f.p.target) { inp.value = v != null ? fmtHM(v * MIN) : ''; return; }
  inp.dataset.committed = '1';
  op('set_target', { episodeId: f.ep.id, pageId: pid, minutes: v });
}

function toggleComplete(pid) {
  const f = findPage(pid);
  if (!f) return;
  if (f.p.completed) {
    if (!confirm(`${f.p.no}P の完成を解除しますか？`)) return;
  } else if (S.active?.pageId === pid) {
    if (!confirm(`${f.p.no}P は計測中です。停止して完成にしますか？`)) return;
    closeMini();
  }
  op('set_complete', { episodeId: f.ep.id, pageId: pid, completed: !f.p.completed });
}

// ------------------------------------------------------------ modal

function modal(html, { wide = false, onMount } = {}) {
  const root = $('#modalRoot');
  const ov = document.createElement('div');
  ov.className = 'overlay';
  ov.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">${html}</div>`;
  root.appendChild(ov);
  const close = () => ov.remove();
  ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
  ov.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  $$('[data-close]', ov).forEach((b) => b.addEventListener('click', close));
  onMount?.(ov, close);
  const first = $('input:not([disabled]), button.primary', ov);
  first?.focus();
  return { el: ov, close };
}

function episodeForm(ep, presetPages) {
  const isNew = !ep;
  const dflt = new Date(now() + 7 * DAY); dflt.setHours(18, 0, 0, 0);
  const lastTitle = [...S.episodes].sort((a, b) => b.createdAt - a.createdAt)[0];
  const nextNo = lastTitle && /^\d+$/.test(lastTitle.number) ? String(+lastTitle.number + 1) : '';
  return new Promise((resolve) => {
    modal(`
      <h2>${isNew ? '新しい話を作成' : '話の設定'}</h2>
      <div class="row"><label>作品名</label><input type="text" name="title" value="${esc(ep?.title ?? lastTitle?.title ?? '')}"></div>
      <div class="row"><label>話数</label><input type="text" name="number" value="${esc(ep?.number ?? nextNo)}" placeholder="例 65"></div>
      <div class="row"><label>総ページ数${isNew ? '' : '（増やすことのみ可能）'}</label><input type="number" name="pages" min="${ep?.pages.length ?? 1}" max="500" value="${ep?.pages.length ?? presetPages ?? 20}"></div>
      <div class="row"><label>締切日時</label><input type="datetime-local" name="deadline" value="${toLocalInput(ep?.deadline ?? dflt.getTime())}"></div>
      <div class="foot">
        ${isNew ? '' : '<button class="btn danger left" data-del>この話を削除</button>'}
        <button class="btn" data-close>キャンセル</button>
        <button class="btn primary" data-ok>${isNew ? '作成' : '保存'}</button>
      </div>`, {
      onMount(el, close) {
        const submit = async () => {
          const v = (n) => $(`[name=${n}]`, el).value;
          const args = { title: v('title'), number: v('number'), pages: +v('pages'), deadline: fromLocalInput(v('deadline')) };
          const r = isNew ? await op('create_episode', args) : await op('update_episode', { ...args, episodeId: ep.id });
          if (r) { close(); resolve(r); }
        };
        $('[data-ok]', el).addEventListener('click', submit);
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !isComposing(e) && e.target.tagName === 'INPUT') submit(); });
        $('[data-del]', el)?.addEventListener('click', async () => {
          const n = S.logs.filter((l) => l.episodeId === ep.id).length;
          if (!confirm(`「${ep.title} ${ep.number}話」を削除しますか？\n作業ログ ${n} 件も削除されます。（直後なら「取消」で戻せます）`)) return;
          if (await op('delete_episode', { episodeId: ep.id })) { close(); resolve(null); }
        });
      },
    });
  });
}

async function newEpisode(presetPages) {
  const r = await episodeForm(null, presetPages);
  if (r?.episodeId) { currentEpId = r.episodeId; view = 'main'; render(); }
  return r;
}

// ページの作業ログ（修正・削除）
function openLogs(pid) {
  const f = findPage(pid);
  if (!f) return;
  const { ep, p } = f;
  const m = modal('<div data-body></div>', {
    wide: true, onMount(el, close) {
      const body = $('[data-body]', el);
      const draw = () => {
        const g = findPage(pid);
        if (!g) { close(); return; }
        const pg = g.p;
        const logs = S.logs.filter((l) => l.pageId === pid).sort((a, b) => a.start - b.start);
        const st = pageStats(pg, logs);
        body.innerHTML = `
          <h2>${esc(ep.title)} ${esc(ep.number)}話 ${pg.no}P — 作業ログ</h2>
          <p class="muted">目標 ${pg.target != null ? fmtHM(pg.target * MIN) : '未入力'}${pg.targetLocked ? '（固定済み）' : ''} ・ 実績 ${fmtHM(st.logged)}（ログ合計） ・ ${pg.completed ? `完成 ・ 差分 ${fmtDiff(st.logged - (st.tgt ?? 0))}` : st.over ? '超過中' : '未完成'}</p>
          ${logs.length ? `<table class="tbl"><thead><tr><th>開始</th><th>終了</th><th>作業時間</th><th></th></tr></thead><tbody>
          ${logs.map((l) => `<tr class="logrow" data-log="${l.id}">
              <td class="l"><input type="datetime-local" step="60" data-k="start" value="${toLocalInput(l.start)}"></td>
              <td class="l"><input type="datetime-local" step="60" data-k="end" value="${toLocalInput(l.end)}"></td>
              <td>${fmtHM(l.end - l.start)}${l.edited ? ' <span class="muted" title="手修正済み">✎</span>' : ''}</td>
              <td><button class="btn sm" data-save hidden>保存</button> <button class="btn sm danger" data-delete>削除</button></td>
            </tr>`).join('')}
          </tbody><tfoot><tr><td class="l" colspan="2">合計（${logs.length}件）</td><td>${fmtHM(st.logged)}</td><td></td></tr></tfoot></table>`
            : '<p class="muted">作業ログはまだありません。</p>'}
          ${S.active?.pageId === pid ? `<p>● 計測中: ${fmtDateTime(S.active.start)} から（停止すると記録されます）</p>` : ''}
          <h3>目標時間の修正</h3>
          <p class="muted" style="font-size:12px">目標時間は初回の作業開始時に固定されます。入力ミスの場合のみここで修正してください。</p>
          <div style="display:flex;gap:6px;align-items:center"><input type="text" class="target" style="width:90px" data-tgt value="${pg.target != null ? fmtHM(pg.target * MIN) : ''}"><button class="btn sm" data-settgt>目標を修正</button></div>
          <div class="foot"><button class="btn" data-close2>閉じる</button></div>`;
        $('[data-close2]', body).addEventListener('click', close);
      };
      draw();
      m_redraw = draw;
      body.addEventListener('input', (e) => {
        const row = e.target.closest('.logrow');
        if (row) { row.classList.add('dirty'); $('[data-save]', row).hidden = false; }
      });
      body.addEventListener('click', async (e) => {
        const row = e.target.closest('.logrow');
        if (e.target.closest('[data-save]') && row) {
          const s = fromLocalInput($('[data-k=start]', row).value), en = fromLocalInput($('[data-k=end]', row).value);
          if (await op('edit_log', { logId: row.dataset.log, start: s, end: en })) draw();
        } else if (e.target.closest('[data-delete]') && row) {
          if (!confirm('この作業ログを削除しますか？（直後なら「取消」で戻せます）')) return;
          if (await op('delete_log', { logId: row.dataset.log })) draw();
        } else if (e.target.closest('[data-settgt]')) {
          const v = parseTarget($('[data-tgt]', body).value);
          if (!v) { toast('目標時間の形式が不正です', true); return; }
          const pg = findPage(pid).p;
          if (pg.targetLocked && !confirm('固定済みの目標時間を変更します。実績比較の基準が変わりますがよろしいですか？')) return;
          if (await op('set_target', { episodeId: ep.id, pageId: pid, minutes: v, force: true })) draw();
        }
      });
    },
  });
  const obs = new MutationObserver(() => { if (!m.el.isConnected) { m_redraw = null; obs.disconnect(); } });
  obs.observe($('#modalRoot'), { childList: true });
}
let m_redraw = null;

// 未終了セッション（アプリが閉じられていた・iPad が裏で終了させた場合）
function checkRecovery() {
  const a = S.active;
  if (!a) return;
  const f = findPage(a.pageId);
  const t = now();
  const beat = a.lastBeat || a.start;
  modal(`
    <h2>計測中の作業があります</h2>
    <p><b>${f ? `${esc(f.ep.title)} ${esc(f.ep.number)}話 ${f.p.no}P` : '不明なページ'}</b></p>
    <p>開始: ${fmtDateTime(a.start)}<br>アプリを最後に見ていた時刻: ${fmtDateTime(beat)}（開始から ${fmtHM(beat - a.start)}）<br>現在: ${fmtDateTime(t)}（開始から ${fmtHM(t - a.start)}）</p>
    <p class="muted">アプリが閉じられていました（他のアプリを使っている間に iPad が自動で終了させることがあります）。計測は開始時刻から続いています。</p>
    <div class="choice">
      <button class="btn primary-choice" data-m="continue">計測を続ける<small>作業を続けていた場合はこれ。タイマーはそのまま進みます</small></button>
      <button class="btn" data-m="now">今の時刻で終了して記録 — ${fmtClock(t)}<small>今まで作業していたものとして記録します</small></button>
      <button class="btn" data-m="lastBeat">アプリを最後に見ていた時刻で記録 — ${fmtClock(beat)}<small>その時点で作業もやめていた場合</small></button>
      <div class="row-inline"><input type="datetime-local" data-end value="${toLocalInput(beat)}"><button class="btn" data-m="custom">指定した時刻で記録</button></div>
      <button class="btn danger" data-m="discard">記録を破棄<small>この作業記録を残しません</small></button>
    </div>`, {
    onMount(el, close) {
      el.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-m]');
        if (!b) return;
        const mode = b.dataset.m;
        if (mode === 'continue') { close(); enterCompact(); return; }
        if (mode === 'discard' && !confirm('作業記録を破棄しますか？')) return;
        const args = { mode };
        if (mode === 'custom') {
          args.end = fromLocalInput($('[data-end]', el).value);
          if (!args.end) { toast('時刻を入力してください', true); return; }
        }
        if (await op('recover', args)) close();
      });
    },
  });
}

// ------------------------------------------------------------ PDF

let pdfjs = null;
const canvasToBlob = (c) => new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('画像の生成に失敗しました'))), 'image/jpeg', 0.82));

async function importPdf(file) {
  if (!file || !/\.pdf$/i.test(file.name) && file.type !== 'application/pdf') { toast('PDFファイルを選んでください', true); return; }
  const prog = modal(`<h2>PDFを読み込み中…</h2><p class="muted" data-t>${esc(file.name)}</p><div class="progress"><div data-bar></div></div>`);
  const blobs = [];
  try {
    if (!pdfjs) {
      pdfjs = await import('./vendor/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
    }
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    if (doc.numPages > 500) throw new Error('ページ数が多すぎます（500ページまで）');
    // iPad はキャンバスのメモリ上限が小さいので、1枚を使い回して毎回解放する
    const c = document.createElement('canvas');
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i);
      const vp0 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: 420 / vp0.width });
      c.width = Math.round(vp.width); c.height = Math.round(vp.height);
      const ctx = c.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      blobs.push(await canvasToBlob(c));
      page.cleanup();
      $('[data-bar]', prog.el).style.width = `${(i / doc.numPages) * 100}%`;
      $('[data-t]', prog.el).textContent = `${file.name} — ${i} / ${doc.numPages} ページ`;
    }
    c.width = c.height = 0;
    await doc.destroy();
  } catch (e) {
    prog.close();
    const msg = e?.name === 'PasswordException' ? 'パスワード付きのPDFは読み込めません' : (e?.message || e);
    toast('PDFを読み込めませんでした: ' + msg, true);
    return;
  }
  prog.close();

  let ep = curEp();
  if (!ep) {
    toast(`PDF は ${blobs.length} ページです。話を作成してください`);
    const r = await newEpisode(blobs.length);
    if (!r?.episodeId) return;
    ep = curEp();
  }
  const n = blobs.length, m = ep.pages.length;
  let extend = false;
  if (n !== m) {
    const choice = await new Promise((resolve) => {
      modal(`
        <h2>ページ数が一致しません</h2>
        <p>PDF: <b>${n}ページ</b> ／ 登録済み（${esc(ep.number)}話）: <b>${m}ページ</b></p>
        <p class="muted">自動更新は行いません。どうするか選んでください。進捗データ（目標・ログ・完成状態）は変更されません。</p>
        <div class="choice">
          ${n > m ? `<button class="btn" data-c="extend">ページを ${n}P に増やして割り当て<small>${m + 1}〜${n}P を新規ページとして追加します</small></button>` : ''}
          <button class="btn" data-c="assign">先頭から ${Math.min(n, m)}ページ分だけ更新<small>${n > m ? `PDFの ${m + 1}ページ目以降は使いません` : `${n + 1}P 以降のサムネイルはそのまま残ります`}</small></button>
          <button class="btn" data-c="cancel">キャンセル</button>
        </div>`, {
        onMount(el, close) {
          el.addEventListener('click', (e) => { const b = e.target.closest('[data-c]'); if (b) { close(); resolve(b.dataset.c); } });
        },
      });
    });
    if (choice === 'cancel' || !choice) return;
    extend = choice === 'extend';
  }
  const epId = ep.id;
  const r = await queued(async () => {
    const j = await store.setThumbs(epId, blobs, extend);
    if (!j.ok) { toast(j.error, true); return null; }
    applyState(j);
    return j.result;
  });
  if (r) toast(`${ep.number}話のサムネイルを更新しました（${r.updated}P）`);
}

// ------------------------------------------------------------ history

function renderHistory() {
  $$('.subtab').forEach((b) => b.classList.toggle('on', b.dataset.hview === hview));
  if (hview === 'episodes') renderHistEpisodes(); else renderHistDays();
}

function renderHistEpisodes() {
  const lbp = logsByPage();
  const eps = [...S.episodes].sort((a, b) => b.createdAt - a.createdAt);
  if (!eps.find((e) => e.id === hSel.episodes)) hSel.episodes = currentEpId || eps[0]?.id;
  $('#hList').innerHTML = eps.map((e) => {
    const es = episodeStats(e, lbp);
    return `<button class="hitem ${e.id === hSel.episodes ? 'on' : ''}" data-hsel="${e.id}">
      <div class="t">${esc(e.title)} ${esc(e.number)}話</div>
      <div class="s">完成 ${es.done}/${es.total}P ・ 実績 ${fmtHM(es.actual)} ・ 締切 ${fmtDate(e.deadline)}</div></button>`;
  }).join('') || '<p class="muted" style="padding:12px">記録がありません</p>';
  const ep = S.episodes.find((e) => e.id === hSel.episodes);
  if (!ep) { $('#hDetail').innerHTML = ''; return; }
  let sumT = 0, sumA = 0, sumDoneT = 0, sumDoneA = 0;
  const rows = ep.pages.map((p) => {
    const logs = (lbp.get(p.id) || []).sort((a, b) => a.start - b.start);
    const st = pageStats(p, logs);
    const days = [...new Set(logs.flatMap((l) => splitByDay(l.start, l.end).map((s) => s.day)))];
    if (st.tgt) sumT += st.tgt;
    sumA += st.act;
    if (p.completed && st.tgt) { sumDoneT += st.tgt; sumDoneA += st.act; }
    const diff = p.completed && st.tgt != null ? st.act - st.tgt : null;
    return `<tr>
      <td>${p.no}P</td><td>${st.tgt != null ? fmtHM(st.tgt) : '—'}</td><td>${fmtHM(st.act)}</td>
      <td class="${diff > 0 ? 'plus' : diff < 0 ? 'minus' : ''}">${diff != null ? fmtDiff(diff) : '—'}</td>
      <td>${st.rate != null ? Math.round(st.rate * 100) + '%' : '—'}</td>
      <td>${p.completed ? '完成' : st.over ? '<span class="plus">超過中</span>' : st.running ? '計測中' : '未完成'}</td>
      <td class="l">${days.map((d) => d.slice(5).replace('-', '/')).join(', ') || '—'}</td>
      <td>${logs.length ? `<button class="link" data-plogs="${p.id}">${logs.length}件</button>` : '—'}</td></tr>
      <tr class="sub" data-sub="${p.id}" hidden><td colspan="8" class="l">${logs.map((l) => `${fmtDateTime(l.start)} – ${fmtClock(l.end)}（${fmtHM(l.end - l.start)}）`).join('<br>')}</td></tr>`;
  }).join('');
  $('#hDetail').innerHTML = `<h2>${esc(ep.title)} ${esc(ep.number)}話</h2>
    <p class="muted">締切 ${fmtDateTime(ep.deadline)} ・ 作成 ${fmtDateTime(ep.createdAt)}</p>
    <table class="tbl"><thead><tr><th>ページ</th><th>目標</th><th>実績</th><th>差分</th><th>消化率</th><th>状態</th><th class="l">作業日</th><th>ログ</th></tr></thead>
    <tbody>${rows}</tbody>
    <tfoot><tr><td>合計</td><td>${fmtHM(sumT)}</td><td>${fmtHM(sumA)}</td><td class="${sumDoneA - sumDoneT > 0 ? 'plus' : 'minus'}" title="完成済みページの差分合計">${sumDoneT ? fmtDiff(sumDoneA - sumDoneT) : '—'}</td><td colspan="4"></td></tr></tfoot></table>
    <div class="foot" style="display:flex;gap:8px;margin-top:12px"><button class="btn" data-open="${ep.id}">進捗画面で開く</button><button class="btn" data-csv="${ep.id}">この話のCSV</button></div>`;
}

function dailyIndex() {
  const days = new Map();
  for (const l of S.logs) {
    const f = findPage(l.pageId);
    for (const seg of splitByDay(l.start, l.end)) {
      if (!days.has(seg.day)) days.set(seg.day, { total: 0, segs: [] });
      const d = days.get(seg.day);
      d.total += seg.end - seg.start;
      d.segs.push({ ...seg, log: l, f });
    }
  }
  return days;
}

function renderHistDays() {
  const days = dailyIndex();
  const keys = [...days.keys()].sort().reverse();
  if (!days.has(hSel.days)) hSel.days = keys[0];
  $('#hList').innerHTML = keys.map((k) => {
    const d = dayKeyDate(k);
    return `<button class="hitem ${k === hSel.days ? 'on' : ''}" data-hsel="${k}">
      <div class="t">${d.getMonth() + 1}/${d.getDate()}（${'日月火水木金土'[d.getDay()]}） <span style="float:right">${fmtHM(days.get(k).total)}</span></div>
      <div class="s">${d.getFullYear()}</div></button>`;
  }).join('') || '<p class="muted" style="padding:12px">作業ログがありません</p>';
  const d = days.get(hSel.days);
  if (!d) { $('#hDetail').innerHTML = ''; return; }
  const per = new Map();
  for (const s of d.segs) {
    const key = s.log.pageId;
    if (!per.has(key)) per.set(key, { f: s.f, total: 0 });
    per.get(key).total += s.end - s.start;
  }
  const label = (f) => f ? `${esc(f.ep.title)} ${esc(f.ep.number)}話 ${f.p.no}P` : '（削除されたページ）';
  const perRows = [...per.values()].sort((a, b) => (a.f?.ep.createdAt ?? 0) - (b.f?.ep.createdAt ?? 0) || (a.f?.p.no ?? 0) - (b.f?.p.no ?? 0))
    .map((x) => `<tr><td>${label(x.f)}</td><td>${fmtHM(x.total)}</td></tr>`).join('');
  const segRows = d.segs.sort((a, b) => a.start - b.start).map((s) => `<tr>
      <td>${label(s.f)}</td><td>${fmtClock(s.start)}</td><td>${s.toMidnight ? '24:00' : fmtClock(s.end)}</td><td>${fmtHM(s.end - s.start)}</td>
      <td class="l muted" style="font-size:12px">${splitByDay(s.log.start, s.log.end).length > 1 ? `日跨ぎ（${fmtDateTime(s.log.start)} – ${fmtDateTime(s.log.end)}）` : ''}</td>
      <td>${s.f ? `<button class="link" data-editlog="${s.log.pageId}">修正</button>` : ''}</td></tr>`).join('');
  const dt = dayKeyDate(hSel.days);
  $('#hDetail').innerHTML = `<h2>${dt.getMonth() + 1}/${dt.getDate()}（${'日月火水木金土'[dt.getDay()]}）</h2>
    <p>総作業時間 <b style="font-size:18px">${fmtHM(d.total)}</b></p>
    <table class="tbl"><thead><tr><th>ページ</th><th>作業時間</th></tr></thead><tbody>${perRows}</tbody></table>
    <h3>作業ログ</h3>
    <table class="tbl"><thead><tr><th>ページ</th><th>開始</th><th>終了</th><th>時間</th><th></th><th></th></tr></thead><tbody>${segRows}</tbody></table>`;
}

// ------------------------------------------------------------ toast

let toastTimer = 0;
function toast(msg, err = false) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast' + (err ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, err ? 5000 : 2800);
}

// ------------------------------------------------------------ events

// 日本語入力の変換中の Enter（変換確定）は無視する
const isComposing = (e) => e.isComposing || e.keyCode === 229;

$('#epSelect').addEventListener('change', (e) => { currentEpId = e.target.value; render(); });
$('#btnNewEp').addEventListener('click', () => newEpisode());
$('#btnNewEp2').addEventListener('click', () => newEpisode());
$('#btnEditEp').addEventListener('click', () => { const ep = curEp(); if (ep) episodeForm(ep); });
$('#btnUndo').addEventListener('click', () => undo());
$('#btnPdf').addEventListener('click', () => $('#pdfInput').click());
$('#pdfInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importPdf(f); });
$$('.tab').forEach((b) => b.addEventListener('click', () => { view = b.dataset.view; render(); }));
$$('.subtab').forEach((b) => b.addEventListener('click', () => { hview = b.dataset.hview; render(); }));

async function undo() {
  if (!undoLabel) return;
  const wasActive = S.active?.pageId;
  await op('undo');
  if (!S.active && wasActive) closeMini();
  m_redraw?.();
}

$('#grid').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const pid = btn.closest('.card').dataset.page;
  const act = btn.dataset.act;
  if (act === 'start') startPage(pid);
  else if (act === 'stop') stopActive();
  else if (act === 'complete') toggleComplete(pid);
  else if (act === 'logs') openLogs(pid);
});
$('#grid').addEventListener('change', (e) => { if (e.target.classList.contains('target')) commitTarget(e.target); });
$('#grid').addEventListener('keydown', (e) => {
  if (!e.target.classList.contains('target') || isComposing(e)) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    commitTarget(e.target);
    // 次のページの入力欄へ
    const inputs = $$('#grid .target:not(:disabled)');
    const i = inputs.indexOf(e.target);
    (inputs[i + 1] || e.target).focus();
  } else if (e.key === 'Escape') { e.target.blur(); }
});
// iOS では focus 直後の select() が効かないことがあるので少し遅らせる
$('#grid').addEventListener('focusin', (e) => {
  const t = e.target;
  if (t.classList.contains('target')) setTimeout(() => { try { t.setSelectionRange(0, t.value.length); } catch { } }, 30);
});

$('#activeBar').addEventListener('click', (e) => {
  const b = e.target.closest('[data-bar]');
  if (!b) return;
  if (b.dataset.bar === 'stop') stopActive();
  else if (b.dataset.bar === 'mini') openMini();
  else if (b.dataset.bar === 'goto') { currentEpId = S.active.episodeId; view = 'main'; render(); }
});

$('#viewHistory').addEventListener('click', (e) => {
  const sel = e.target.closest('[data-hsel]');
  if (sel) { hSel[hview] = sel.dataset.hsel; render(); return; }
  const pl = e.target.closest('[data-plogs]');
  if (pl) { const r = $(`[data-sub="${pl.dataset.plogs}"]`); r.hidden = !r.hidden; return; }
  const op_ = e.target.closest('[data-open]');
  if (op_) { currentEpId = op_.dataset.open; view = 'main'; render(); return; }
  const el = e.target.closest('[data-editlog]');
  if (el) openLogs(el.dataset.editlog);
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName)) {
    e.preventDefault(); undo();
  }
});

// ドラッグ＆ドロップで PDF 取込
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth++; $('#dropOverlay').hidden = false; });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropOverlay').hidden = true; } });
window.addEventListener('drop', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault(); dragDepth = 0; $('#dropOverlay').hidden = true;
  const f = [...e.dataTransfer.files].find((x) => /\.pdf$/i.test(x.name));
  if (f) importPdf(f); else toast('PDFファイルをドロップしてください', true);
});

// ------------------------------------------------------------ ファイル書き出し・バックアップ

const fmtSize = (n) => (n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const stamp = () => { const d = new Date(); return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; };
const safeName = (s) => String(s).replace(/[\\/:*?"<>|]/g, '_');

function downloadFile(file) {
  const u = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = u; a.download = file.name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 60000);
}

// iPad では共有シート（「"ファイル"に保存」など）で書き出す。
// 共有はタップの直後でないと拒否されるので、ファイルを作ってから「保存する」ボタンを押してもらう。
function offerFile(file, { title, note, onSaved } = {}) {
  const useShare = IS_IOS && navigator.canShare?.({ files: [file] });
  modal(`<h2>${esc(title)}</h2>
    <p><b>${esc(file.name)}</b>（${fmtSize(file.size)}）</p>
    ${note ? `<p class="muted">${note}</p>` : ''}
    ${useShare ? '<p class="muted">「保存する」を押して、表示されたメニューから <b>「"ファイル"に保存」</b>（iCloud Drive など）を選んでください。</p>' : ''}
    <div class="foot"><button class="btn" data-close>閉じる</button><button class="btn primary" data-save>保存する</button></div>`, {
    onMount(el, close) {
      $('[data-save]', el).addEventListener('click', async () => {
        if (useShare) {
          try {
            await navigator.share({ files: [file], title: file.name });
            onSaved?.(); close(); toast('保存しました');
          } catch (e) {
            if (e?.name !== 'AbortError') { downloadFile(file); onSaved?.(); close(); }
          }
        } else {
          downloadFile(file); onSaved?.(); close();
        }
      });
    },
  });
}

function exportCsv(episodeId) {
  const ep = S.episodes.find((e) => e.id === episodeId);
  const name = `進捗_${ep ? safeName(`${ep.title}_${ep.number}話`) : '全話'}_${stamp()}.csv`;
  offerFile(new File([store.buildCsv(ep ? ep.id : null)], name, { type: 'text/csv' }), {
    title: 'CSV出力', note: 'Excel・Numbers でそのまま開けます。日を跨いだ作業は日付ごとの行に分かれます。',
  });
}

async function exportBackup() {
  const text = await queued(() => store.exportBackup());
  offerFile(new File([text], `漫画進捗_バックアップ_${stamp()}.json`, { type: 'application/json' }), {
    title: 'バックアップを書き出す',
    note: '全ての話・作業ログ・サムネイルが入っています。「バックアップから復元」で読み戻せます。',
    onSaved: async () => { await store.markBackup(); renderNotice(); },
  });
}

async function importBackupFile(file) {
  if (!confirm(`「${file.name}」から復元します。\n\n今この端末にあるデータは、すべてバックアップの内容に置き換わります。よろしいですか？`)) return;
  try {
    const text = await file.text();
    const j = await queued(() => store.importBackup(text));
    exitCompact();
    currentEpId = null;
    applyState(j);
    toast('バックアップから復元しました');
  } catch (e) {
    toast(e?.message || '復元できませんでした', true);
  }
}

async function openDataMenu() {
  const ep = curEp();
  const info = store.stats();
  const persisted = await store.persisted();
  const last = info.lastBackup ? `${fmtDateTime(info.lastBackup)}（${Math.floor((Date.now() - info.lastBackup) / DAY)}日前）` : 'まだありません';
  modal(`<h2>データ</h2>
    <h3>CSV出力</h3>
    <div class="choice">
      ${ep ? `<button class="btn" data-csv="${ep.id}">この話（${esc(ep.title)} ${esc(ep.number)}話）</button>` : ''}
      <button class="btn" data-csv="all" ${S.episodes.length ? '' : 'disabled'}>全ての話</button>
    </div>
    <h3>バックアップ</h3>
    <p class="muted" style="font-size:13px">データはこの端末の中だけに保存されています。アプリを削除すると消えるので、ときどき書き出して「ファイル」アプリや iCloud Drive に保存してください。</p>
    <p style="font-size:13px">最後のバックアップ: ${last}</p>
    <div class="choice">
      <button class="btn" data-backup ${S.episodes.length ? '' : 'disabled'}>バックアップを書き出す<small>全データ（サムネイル込み）を1つのファイルに保存</small></button>
      <button class="btn" data-restore>バックアップから復元<small>書き出したファイル、または PC 版の data.json を読み込む</small></button>
    </div>
    <p class="muted" style="font-size:12px;margin-top:12px">保存領域: ${persisted ? '保護されています（自動では消去されません）' : IS_IOS && !IS_STANDALONE ? 'Safari のタブで開いています。ホーム画面に追加して使うと安全です' : '通常'}</p>
    <div class="foot"><button class="btn" data-close>閉じる</button></div>`, {
    onMount(el, close) {
      el.addEventListener('click', (e) => {
        const c = e.target.closest('[data-csv]');
        if (c) { close(); exportCsv(c.dataset.csv === 'all' ? null : c.dataset.csv); return; }
        if (e.target.closest('[data-backup]')) { close(); exportBackup(); return; }
        if (e.target.closest('[data-restore]')) { close(); $('#restoreInput').click(); }
      });
    },
  });
}

// 画面上部のお知らせ（ホーム画面への追加・バックアップのすすめ）
let noticeDismissed = false;
function renderNotice() {
  const el = $('#notice');
  if (!el || !S) return;
  let html = '';
  const info = store.stats();
  if (IS_IOS && !IS_STANDALONE) {
    html = `<b>ホーム画面に追加して使ってください。</b> 共有ボタン <span class="ic">⬆︎</span> →「ホーム画面に追加」。Safari のタブで使うとデータが消えやすく、ホーム画面のアプリとはデータが別になります。`;
  } else if (!noticeDismissed && info.logs > 0 && (!info.lastBackup || Date.now() - info.lastBackup > 7 * DAY)) {
    html = `${info.lastBackup ? `最後のバックアップから ${Math.floor((Date.now() - info.lastBackup) / DAY)} 日経っています。` : 'まだバックアップがありません。'}
      <button class="btn sm" data-notice="backup">バックアップを書き出す</button> <button class="link" data-notice="close">あとで</button>`;
  }
  el.innerHTML = html;
  el.hidden = !html;
}
$('#notice').addEventListener('click', (e) => {
  const b = e.target.closest('[data-notice]');
  if (!b) return;
  if (b.dataset.notice === 'backup') exportBackup();
  noticeDismissed = true;
  renderNotice();
});

$('#btnCsv').addEventListener('click', () => openDataMenu());
$('#restoreInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importBackupFile(f); });
document.addEventListener('click', (e) => {
  const b = e.target.closest('#hDetail [data-csv]');
  if (b) exportCsv(b.dataset.csv);
});

// 表示サイズ
const zoom = $('#zoom');
zoom.value = lsGet('zoom') || 150;
const applyZoom = () => document.documentElement.style.setProperty('--card', zoom.value + 'px');
zoom.addEventListener('input', () => { applyZoom(); lsSet('zoom', zoom.value); });
applyZoom();

// 作業中画面: 停止 / 計測を続けたまま一覧へ
$('#compactRoot').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mini]');
  if (!b) return;
  if (b.dataset.mini === 'stop') stopActive();
  else if (b.dataset.mini === 'expand') exitCompact();
});

// 「アプリを最後に見ていた時刻」を記録する。iPad ではアプリが裏に回るとタイマーが止まり、
// そのまま終了させられることもあるので、裏に回る瞬間にも記録しておく。
const beat = () => { if (S?.active) store.apply('heartbeat'); };
setInterval(beat, 30000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) beat();
  else if (S) { render(); renderNotice(); }  // 戻ってきたら経過時間を描き直す（時間は開始時刻から計算するので途切れない）
});
window.addEventListener('pagehide', beat);

setInterval(tick, 1000);
// 日付が変わったときに全体を描き直す
let lastDay = dayKey(Date.now());
setInterval(() => { const d = dayKey(now()); if (d !== lastDay) { lastDay = d; render(); } }, 15000);

// オフラインで使えるようにする（Service Worker）
if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('./sw.js').then((reg) => {
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) toast('新しいバージョンがあります。アプリを開き直すと反映されます');
      });
    });
  }).catch(() => { });
}

load().then(renderNotice);

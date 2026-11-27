// ArkTalk 界面逻辑：只跟本地桥通信。完全独立的聊天软件，向外传输是 P2P。
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let ws = null;
let uiCfg = null;      // /api/config（uiToken 等）
let selfInfo = null;   // 本机账号资料 {accountId, nickname, avatar}
let friends = [];      // 联系人（本机管理）[{user_id, nickname, remark, avatar?, endpoint?, local}]
let groups = [];       // 群（本机管理）[{group_id, group_name, members?, local}]
let chats = [];        // [{chatKey, lastTime, lastPreview, unread}]
let activeChat = null; // {key, type:'p'|'g', id, name, avatar}
let peers = {};        // accountId -> 是否设备在线（P2P 直连）
let modalMode = null;  // 当前弹窗：friends | create-group | profile | null
const chatCache = new Map(); // chatKey -> {messages:[], loadedRemote}

/* ---------- 头像：本机生成（SVG data URI，零网络请求）；
   联系人头像用对方设备自报的（P2P 通讯得到），没有则本机生成 ---------- */
function localAvatar(name, seed) {
  const ch = [...String(name ?? '?')][0] ?? '?';
  const hue = [...String(seed ?? name ?? '')].reduce((a, c) => a + c.charCodeAt(0), 0) % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="14" fill="hsl(${hue},60%,86%)"/><text x="48" y="62" font-size="40" text-anchor="middle" fill="hsl(${hue},55%,35%)" font-family="sans-serif">${ch}</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
const contactOf = (uin) => friends.find((f) => String(f.user_id) === String(uin));
const avatarOfUser = (uin, name) => contactOf(uin)?.avatar || localAvatar(name ?? `账号 ${uin}`, uin);
const avatarOfGroup = (gid, name) => localAvatar(name ?? `群 ${gid}`, gid);

/* ---------- 连接 ---------- */
async function boot() {
  uiCfg = await fetch('/api/config').then((r) => r.json());
  connect(new URL(`/ws?token=${uiCfg.uiToken}`, location.href.replace(/^http/, 'ws')).href);
}
function connect(url) {
  ws = new WebSocket(url);
  ws.onopen = () => setStatus(true);
  ws.onclose = () => { setStatus(false); setTimeout(boot, 2000); };
  ws.onmessage = (e) => handleFrame(JSON.parse(e.data));
}
function setStatus(on) {
  $('conn-dot').className = `dot ${on ? 'on' : 'off'}`;
}

/* ---------- 帧处理 ---------- */
function handleFrame(m) {
  switch (m.type) {
    case 'hello': {
      selfInfo = m.self; friends = m.friends ?? []; groups = m.groups ?? []; chats = m.chats ?? [];
      peers = m.peers ?? {};
      renderSelf(); renderList(); updatePeerPill();
      break;
    }
    case 'peers': {
      peers = m.peers ?? {};
      renderList();
      updatePeerPill();
      renderMemberPanel();
      break;
    }
    case 'event': onEvent(m); break;
    case 'history': onHistory(m); break;
    case 'action-result': onActionResult(m); break;
    case 'self-msg': upsertLocal(m.chatKey, m.record); break;
    case 'unread': chats.forEach((c) => { if (m.unread[c.chatKey] !== undefined) c.unread = m.unread[c.chatKey]; }); renderList(); break;
    case 'file-progress': setFileStatus(m.fileId, m.size ? `接收中 ${Math.floor((m.received / m.size) * 100)}%` : `接收中 ${fmtSize(m.received)}`); break;
    case 'file-done': setFileStatus(m.fileId, '已保存 ✓'); break;
    case 'file-ack': setFileStatus(m.fileId, '对方已接收 ✓'); break;
    case 'file-error': setFileStatus(m.fileId, `失败：${m.error ?? '传输中止'}`); break;
  }
}

/** 对方设备在线状态 → 聊天头部的提示条。 */
function updatePeerPill() {
  const pill = $('chat-upstream');
  if (!activeChat || activeChat.type !== 'private') { pill.hidden = true; return; }
  const online = peers[String(activeChat.id)];
  pill.hidden = online !== false; // 只有明确离线才提示
}

/* ---------- 群成员面板（QQ NT 右侧栏） ---------- */
function renderMemberPanel() {
  const panel = $('member-panel');
  if (!activeChat || activeChat.type !== 'group') { panel.hidden = true; $('chat-pane').classList.remove('with-panel'); return; }
  panel.hidden = false;
  $('chat-pane').classList.add('with-panel');
  const kw = ($('mp-filter').value ?? '').trim().toLowerCase();
  const list = (groupMembers.get(activeChat.id) ?? groupMemberList(activeChat.id))
    .filter((m) => !kw || String(m.card || m.nickname || m.user_id).toLowerCase().includes(kw));
  const g = groups.find((x) => String(x.group_id) === activeChat.id);
  $('mp-count').textContent = g?.members?.length ?? list.length;
  const box = $('mp-list');
  box.innerHTML = '';
  for (const m of list) {
    const name = m.card || m.nickname || `账号 ${m.user_id}`;
    const online = peers[String(m.user_id)] === true;
    const row = document.createElement('div');
    row.className = 'mp-row';
    row.innerHTML = `<img class="avatar" src="${esc(avatarOfUser(m.user_id, name))}">
      <span class="mp-row-name">${esc(name)}</span>
      <span class="mp-online ${online ? 'on' : ''}" title="${online ? '设备在线' : '离线'}"></span>`;
    box.appendChild(row);
  }
}
$('mp-filter')?.addEventListener('input', renderMemberPanel);

/* ---------- 事件 → 界面 ---------- */
function onEvent(m) {
  // P2P 内核推来的消息：桥已落盘并带了完整记录
  if (m.record) {
    if (m.chats) chats = m.chats;
    upsertLocal(m.chatKey, m.record);
    return;
  }
  const event = m.event;
  if (!event) return;
  if (event.post_type === 'notice') {
    if (event.notice_type === 'friend_recall' || event.notice_type === 'group_recall') {
      markRecalled(m.chatKey, event.message_id);
    }
    return; // poke 等暂不展示
  }
}

/** 本机插入一条消息（自发消息先上屏；同一 message_id 只上一次屏，上游回推不重复）。 */
function upsertLocal(chatKey, record) {
  const cache = chatCache.get(chatKey);
  if (!cache || record == null) return;
  if (cache.messages.some((x) => String(x.message_id) === String(record.message_id))) return;
  cache.messages.push(record);
  let chat = chats.find((c) => c.chatKey === chatKey);
  if (!chat) {
    const isGroup = chatKey[0] === 'g';
    const id = chatKey.slice(1);
    const meta = isGroup ? groups.find((g) => String(g.group_id) === id) : friends.find((f) => String(f.user_id) === id);
    chat = { chatKey, lastTime: record.time, lastPreview: previewLocal(record), unread: 0,
      name: isGroup ? (meta?.group_name ?? `群 ${id}`) : (meta?.remark || meta?.nickname || `账号 ${id}`) };
    chats.unshift(chat);
  }
  chat.lastTime = record.time;
  chat.lastPreview = previewLocal(record);
  if (!record.self_sent && activeChat?.key !== chatKey) chat.unread = (chat.unread ?? 0) + 1;
  renderList();
  if (activeChat?.key === chatKey) appendMessage(record);
}

/* ---------- 消息渲染 ---------- */
function onHistory(m) {
  if (!activeChat || m.chatKey !== activeChat.key) return;
  const cache = chatCache.get(m.chatKey) ?? { messages: [], loadedRemote: false };
  chatCache.set(m.chatKey, cache);
  cache.messages = m.messages;
  renderMessages(cache.messages);
  scrollBottom();
}
function markRecalled(chatKey, messageId) {
  const cache = chatCache.get(chatKey);
  if (cache) cache.messages.forEach((x) => { if (String(x.message_id) === String(messageId)) x.recalled = true; });
  if (activeChat?.key === chatKey) renderMessages(cache.messages);
}
function onActionResult(m) {
  const p = pendingActions.get(m.reqId);
  if (!p) return;
  pendingActions.delete(m.reqId);
  m.ok ? p.resolve(m.data) : p.reject(new Error(m.error));
}
const pendingActions = new Map();
let actionSeq = 0;
function send(obj) { if (ws?.readyState === 1) ws.send(JSON.stringify(obj)); }

function renderSelf() {
  if (selfInfo) {
    const av = $('rail-avatar');
    if (av) av.src = selfInfo.avatar || localAvatar(selfInfo.nickname || selfInfo.accountId || '?', selfInfo.accountId ?? 'me');
  }
}

/* ---------- 左侧列表 ---------- */
let currentTab = 'chats';
function renderList() {
  const tab = currentTab;
  const kw = $('search').value.trim().toLowerCase();
  const box = $('list');
  box.innerHTML = '';
  const match = (s) => !kw || String(s ?? '').toLowerCase().includes(kw);

  if (tab === 'chats') {
    if (chats.length === 0) { box.innerHTML = '<div class="list-empty">暂无消息</div>'; return; }
    const sorted = [...chats].sort((a, b) => (b.lastTime ?? 0) - (a.lastTime ?? 0));
    for (const c of sorted) {
      if (!match(c.name) && !match(c.lastPreview)) continue;
      const meta = metaOf(c.chatKey);
      box.appendChild(itemEl(c.chatKey, meta.avatar, c.name || meta.name, c.lastPreview || '', fmtTime(c.lastTime), c.unread));
    }
  } else if (tab === 'friends') {
    for (const f of friends.filter((f) => match(f.nickname) || match(f.remark) || match(f.user_id))) {
      const key = `p${f.user_id}`;
      const c = chats.find((x) => x.chatKey === key);
      const name = f.remark || f.nickname || `账号 ${f.user_id}`;
      box.appendChild(itemEl(key, avatarOfUser(f.user_id, name), name,
        c?.lastPreview ?? '', '', c?.unread ?? 0, { delete: () => confirmRemoveFriend(f.user_id, name) }));
    }
    if (!friends.length) box.innerHTML = '<div class="list-empty">还没有联系人<br>点右上角 ＋ 添加</div>';
  } else if (tab === 'groups') {
    for (const g of groups.filter((g) => match(g.group_name) || match(g.group_id))) {
      const key = `g${g.group_id}`;
      const c = chats.find((x) => x.chatKey === key);
      const name = g.group_name || `群 ${g.group_id}`;
      box.appendChild(itemEl(key, avatarOfGroup(g.group_id, name), name,
        c?.lastPreview ?? '', '', c?.unread ?? 0, { delete: () => confirmDissolveGroup(g.group_id, name) }));
    }
    if (!groups.length) box.innerHTML = '<div class="list-empty">还没有群聊<br>点右上角 ＋ 创建</div>';
  }
}

/** 删除联系人（确认后调 rpc；聊天记录仍保留在本机）。 */
async function confirmRemoveFriend(userId, name) {
  if (!window.confirm(`删除联系人「${name}」？\n删除后需重新添加才能继续聊天；聊天记录仍保留在本机。`)) return;
  try {
    await rpc('remove-friend', { userId });
    friends = friends.filter((f) => String(f.user_id) !== String(userId));
    if (activeChat?.key === `p${userId}`) exitChatToMobileList();
    renderList();
    $('send-hint').textContent = '已删除';
  } catch (e) {
    $('send-hint').textContent = `删除失败：${e.message}`;
  }
  setTimeout(() => { $('send-hint').textContent = ''; }, 3000);
}

/** 删除（解散）本地群。 */
async function confirmDissolveGroup(groupId, name) {
  if (!window.confirm(`删除群聊「${name}」？\n仅从本机移除该群；聊天记录仍保留在本机。`)) return;
  try {
    await rpc('remove-group', { groupId });
    groups = groups.filter((g) => String(g.group_id) !== String(groupId));
    if (activeChat?.key === `g${groupId}`) exitChatToMobileList();
    renderList();
    $('send-hint').textContent = '已删除';
  } catch (e) {
    $('send-hint').textContent = `删除失败：${e.message}`;
  }
  setTimeout(() => { $('send-hint').textContent = ''; }, 3000);
}
function metaOf(chatKey) {
  const isGroup = chatKey[0] === 'g';
  const id = chatKey.slice(1);
  if (isGroup) {
    const g = groups.find((g) => String(g.group_id) === id);
    const name = g?.group_name ?? `群 ${id}`;
    return { name, avatar: avatarOfGroup(id, name) };
  }
  const f = friends.find((f) => String(f.user_id) === id);
  const name = f?.remark || f?.nickname || (String(id) === String(selfInfo?.accountId) ? `${selfInfo?.nickname || '我'}（我）` : `账号 ${id}`);
  return { name, avatar: avatarOfUser(id, name) };
}
function itemEl(key, avatar, name, preview, time, unread, opts = {}) {
  const div = document.createElement('div');
  div.className = 'item' + (activeChat?.key === key ? ' active' : '');
  // 联系人在线状态点（自检：打开时自动拨号 + 每 20s 心跳刷新，绿=可直连）
  const uid = key.slice(1);
  const isContact = key[0] === 'p' && Array.isArray(friends) && friends.some((f) => String(f.user_id) === uid);
  const online = isContact
    ? `<span class="on-dot ${peers?.[uid] ? 'on' : 'off'}" title="${peers?.[uid] ? 'P2P 直连在线' : '离线（消息会排队）'}"></span>`
    : '';
  div.innerHTML = `${online}<img class="avatar" src="${esc(avatar)}" onerror="this.style.visibility='hidden'">
    <div class="item-main"><div class="item-name">${esc(name)}</div><div class="item-preview">${esc(preview)}</div></div>
    ${time ? `<span class="item-time">${esc(time)}</span>` : ''}
    ${unread > 0 ? `<span class="badge">${unread > 99 ? '99+' : unread}</span>` : ''}
    ${opts.delete ? '<button class="item-del" title="删除">✕</button>' : ''}`;
  div.onclick = () => openChat(key);
  if (opts.delete) {
    div.querySelector('.item-del').onclick = (e) => { e.stopPropagation(); opts.delete(); };
  }
  return div;
}

/* ---------- 聊天窗 ---------- */
/** 本地群成员视图（@ 选择与气泡显示用）：群成员 + 联系人资料合并。 */
function groupMemberList(gid) {
  const g = groups.find((x) => String(x.group_id) === String(gid));
  return (g?.members ?? []).map((m) => {
    const f = contactOf(m.user_id);
    return { user_id: m.user_id, nickname: f?.nickname ?? '', card: f?.remark ?? '' };
  });
}
const groupMembers = new Map(); // gid -> 成员视图缓存
async function openChat(key) {
  const isGroup = key[0] === 'g';
  const meta = metaOf(key);
  activeChat = { key, type: isGroup ? 'group' : 'private', id: key.slice(1), name: meta.name, avatar: meta.avatar };
  $('chat-empty').hidden = true;
  $('chat-pane').hidden = false;
  document.body.classList.add('mobile-chat'); // 手机端：进入会话后聊天区占满整屏
  $('chat-name').textContent = meta.name;
  $('chat-avatar').src = meta.avatar;
  if (isGroup) {
    const g = groups.find((x) => String(x.group_id) === activeChat.id);
    $('chat-sub').textContent = `本地群 · ${g?.members?.length ?? 0} 名成员`;
    if (!groupMembers.has(activeChat.id)) groupMembers.set(activeChat.id, groupMemberList(activeChat.id));
  } else {
    $('chat-sub').textContent = `账号 ${activeChat.id}`;
  }
  updatePeerPill();
  renderMemberPanel();
  if (!chatCache.has(key)) chatCache.set(key, { messages: [], loadedRemote: false });
  renderMessages(chatCache.get(key).messages);
  send({ type: 'read', chatKey: key });
  chats.forEach((c) => { if (c.chatKey === key) c.unread = 0; });
  renderList();
  send({ type: 'history', chatKey: key, limit: 50 });
  // 触屏设备不自动弹软键盘（点输入框再弹）
  if (!window.matchMedia('(pointer: coarse)').matches) $('input').focus();
}
// 手机端返回列表（桌面端按钮隐藏，点了也没副作用）
function exitChatToMobileList() {
  document.body.classList.remove('mobile-chat');
  activeChat = null;
  $('chat-pane').hidden = true;
  $('chat-empty').hidden = false;
}
const _btnBack = $('btn-back');
if (_btnBack) _btnBack.addEventListener('click', exitChatToMobileList);
function memberName(gid, uid) {
  const list = groupMembers.get(gid) ?? groupMemberList(gid);
  const m = list.find((x) => String(x.user_id) === String(uid));
  const f = contactOf(uid);
  return m?.card || m?.nickname || f?.remark || f?.nickname || `账号 ${uid}`;
}

function renderMessages(list) {
  const box = $('messages');
  box.innerHTML = '';
  let lastDay = '';
  for (const msg of list) {
    const day = dayOf(msg.time);
    if (day !== lastDay) { lastDay = day; box.appendChild(dayEl(day)); }
    box.appendChild(messageEl(msg));
  }
  if (!list.length) box.innerHTML = '<div class="list-empty" style="margin:auto">还没有消息</div>';
  scrollBottom();
}
const dayOf = (t) => new Date((t ?? 0) * 1000).toLocaleDateString('zh-CN');
const fmtSize = (n) => {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};
const fmtTime = (t) => {
  if (!t) return '';
  const d = new Date(t * 1000);
  const today = new Date().toLocaleDateString('zh-CN');
  const time = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toLocaleDateString('zh-CN') === today ? time : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
};
function dayEl(day) { const d = document.createElement('div'); d.className = 'day-divider'; d.textContent = day; return d; }

function messageEl(msg) {
  const mine = msg.self_sent;
  const row = document.createElement('div');
  row.className = 'row' + (mine ? ' mine' : '');
  const uin = msg.sender?.user_id ?? msg.user_id;
  const name = mine ? (selfInfo?.nickname || '我') : (msg.sender?.card || msg.sender?.nickname || `账号 ${uin}`);
  row.innerHTML = `<img class="avatar" src="${esc(avatarOfUser(uin, name))}" onerror="this.style.visibility='hidden'">
    <div class="bubble-wrap">
      <div class="sender">${esc(name)} · ${esc(fmtTime(msg.time))}</div>
      <div class="bubble ${msg.recalled ? 'recalled' : ''}">${msg.recalled ? '（已撤回）' : renderSegments(msg.message, mine)}</div>
    </div>
    ${msg.recalled ? '' : '<button class="msg-quote-btn" title="引用这条消息">引用</button>'}`;
  row.querySelector('.msg-quote-btn')?.addEventListener('click', () => setReply(msg));
  return row;
}

/* ---------- 文件：发（📎 上传→发卡片）与收（点保存才拉取） ---------- */
function setFileStatus(fid, text) {
  document.querySelectorAll(`[data-fstatus="${CSS.escape(String(fid))}"]`).forEach((el) => { el.textContent = text; });
}
function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?token=${encodeURIComponent(uiCfg?.uiToken ?? '')}&name=${encodeURIComponent(file.name)}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total); };
    xhr.onload = () => { try { resolve(JSON.parse(xhr.responseText)); } catch { reject(new Error('上传响应异常')); } };
    xhr.onerror = () => reject(new Error('上传失败'));
    xhr.send(file);
  });
}
$('btn-file').onclick = () => {
  if (!activeChat) return;
  if (activeChat.type !== 'private') { $('send-hint').textContent = '文件暂只支持私聊'; setTimeout(() => { $('send-hint').textContent = ''; }, 3000); return; }
  $('file-input').click();
};
$('file-input').addEventListener('change', async () => {
  const file = $('file-input').files[0];
  $('file-input').value = '';
  if (!file || !activeChat || activeChat.type !== 'private') return;
  try {
    $('send-hint').textContent = `上传中… ${file.name}`;
    const up = await uploadFile(file, (p) => { $('send-hint').textContent = `上传中… ${file.name} ${Math.floor(p * 100)}%`; });
    await rpc('send-file', { userId: Number(activeChat.id), fileId: up.fileId, name: up.name, size: up.size });
    $('send-hint').textContent = '';
  } catch (e) {
    $('send-hint').textContent = `文件发送失败：${e.message}`;
    setTimeout(() => { $('send-hint').textContent = ''; }, 4000);
  }
});
$('messages').addEventListener('click', async (e) => {
  const btn = e.target.closest('.dl-btn');
  if (!btn || btn.disabled) return;
  btn.disabled = true;
  const fid = btn.dataset.dl;
  try {
    await rpc('download-file', { userId: Number(activeChat.id), fileId: fid, name: btn.dataset.name, size: Number(btn.dataset.size) });
    setFileStatus(fid, '请求中…');
  } catch (err) {
    setFileStatus(fid, `保存失败：${err.message}`);
    btn.disabled = false;
  }
});

/* ---------- 引用回复 ---------- */
let pendingReply = null; // {id, sender_name, text}
function setReply(msg) {
  if (!activeChat) return;
  const uin = msg.sender?.user_id ?? msg.user_id;
  const mine = msg.self_sent;
  pendingReply = {
    id: msg.message_id,
    sender_name: mine ? (selfInfo?.nickname || '我') : (msg.sender?.card || msg.sender?.nickname || `账号 ${uin}`),
    text: previewLocal(msg) || '[消息]'
  };
  renderPendingReply();
  $('input').focus();
}
function renderPendingReply() {
  const box = $('reply-box');
  if (!pendingReply) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  box.innerHTML = `<span class="reply-hint">回复 ${esc(pendingReply.sender_name)}：${esc(pendingReply.text)}</span>
    <button id="reply-cancel" title="取消引用">×</button>`;
  $('reply-cancel').onclick = () => { pendingReply = null; renderPendingReply(); };
}

function renderSegments(segs, mine = false) {
  if (typeof segs === 'string') return esc(segs);
  if (!Array.isArray(segs)) return '<span style="color:var(--text-sub)">[不支持的消息]</span>';
  let html = '';
  for (const seg of segs) {
    const d = seg.data ?? {};
    switch (seg.type) {
      case 'text': html += esc(d.text); break;
      case 'at': html += `<span class="at">@${esc(d.name ?? (d.qq === 'all' ? '全体成员' : d.qq))}</span> `; break;
      case 'face': html += `<span class="face-seg">[表情${d.id ?? ''}]</span>`; break;
      case 'image': {
        let src = d.url ?? '';
        if (!src && d.file && String(d.file).startsWith('base64://')) src = `data:image/png;base64,${String(d.file).slice('base64://'.length)}`;
        if (!src) src = d.file ?? '';
        html += `<img class="image-seg" src="${esc(src)}" loading="lazy">`;
        break;
      }
      case 'reply': html += `<div class="reply-quote">回复 ${esc(d.sender_name ?? '')}：${esc(d.text ?? '')}</div>`; break;
      case 'record': {
        const src = d.url ?? (d.file && String(d.file).startsWith('base64://') ? `data:audio/webm;base64,${String(d.file).slice('base64://'.length)}` : d.file);
        html += src ? `<audio controls src="${esc(src)}"></audio>` : '<span style="color:var(--text-sub)">[语音]</span>';
        break;
      }
      case 'video': html += d.url ? `<video controls src="${esc(d.url)}" style="max-width:220px;border-radius:6px"></video>` : '<span style="color:var(--text-sub)">[视频]</span>'; break;
      case 'file': html += `<div class="card-seg">[文件] ${esc(d.name ?? d.file_id ?? '')}</div>`; break;
      case 'file': {
        const fid = String(d.file_id ?? '');
        const nm = String(d.name ?? '文件');
        const sz = fmtSize(d.size);
        const status = `<span class="file-status" data-fstatus="${esc(fid)}"></span>`;
        html += mine
          ? `<div class="card-seg file-card">📎 ${esc(nm)}（${sz}）${status}</div>`
          : `<div class="card-seg file-card">📎 ${esc(nm)}（${sz}）
              <button class="mini primary dl-btn" data-dl="${esc(fid)}" data-name="${esc(nm)}" data-size="${esc(d.size ?? 0)}">保存</button>${status}</div>`;
        break;
      }
      case 'json': case 'ark': html += `<div class="card-seg">[卡片消息]</div>`; break;
      case 'forward': html += `<div class="card-seg">[合并转发]</div>`; break;
      default: html += `<div class="card-seg">[${esc(seg.type)}]</div>`;
    }
  }
  return html || '<span style="color:var(--text-sub)">[空消息]</span>';
}
function previewLocal(record) {
  const segs = Array.isArray(record.message) ? record.message : [];
  const parts = [];
  for (const s of segs) {
    if (s.type === 'text') parts.push(s.data?.text ?? '');
    else if (s.type === 'image') parts.push('[图片]');
    else if (s.type === 'face') parts.push('[表情]');
    else if (s.type === 'at') parts.push('@…');
    else     if (s.type === 'record') parts.push('[语音]');
    else if (s.type === 'reply') parts.push('[引用]');
    else parts.push(`[${s.type}]`);
  }
  return parts.join('').slice(0, 60);
}
function appendMessage(record) {
  const box = $('messages');
  const empty = box.querySelector('.list-empty');
  if (empty) empty.remove();
  // 日期分隔
  const last = box.querySelector('.row, .day-divider');
  const day = dayOf(record.time);
  if (!last || (last.classList.contains('row') && !box.textContent.includes(day))) {
    // 简化：仅当与上一条日期不同才插
  }
  const rows = box.querySelectorAll('.row');
  const lastRow = rows[rows.length - 1];
  if (!lastRow || lastRow.dataset.day !== day) {
    const el = dayEl(day); el.dataset.day = day; box.appendChild(el);
  }
  const el = messageEl(record);
  el.dataset.day = day;
  box.appendChild(el);
  scrollBottom();
}
function scrollBottom() { const b = $('messages'); b.scrollTop = b.scrollHeight; }

/* ---------- 发送 ---------- */
let pendingSegs = []; // 待发送的非文本分段（@ 提及等），随下一条消息一起发
function renderPendingSegs() {
  const box = $('pending-segs');
  box.hidden = pendingSegs.length === 0;
  box.innerHTML = '';
  pendingSegs.forEach((s, i) => {
    const chip = document.createElement('span');
    chip.className = 'seg-chip';
    chip.innerHTML = `@${esc(s.data.name)} <button title="移除">×</button>`;
    chip.querySelector('button').onclick = () => { pendingSegs.splice(i, 1); renderPendingSegs(); };
    box.appendChild(chip);
  });
}
$('btn-at').onclick = () => {
  if (!activeChat || activeChat.type !== 'group') { $('send-hint').textContent = '@ 仅在群聊可用'; setTimeout(() => { $('send-hint').textContent = ''; }, 3000); return; }
  let list = groupMembers.get(activeChat.id);
  if (!list) { list = groupMemberList(activeChat.id); groupMembers.set(activeChat.id, list); }
  if (!list.length) { $('send-hint').textContent = '群里还没有成员'; setTimeout(() => { $('send-hint').textContent = ''; }, 3000); return; }
  const old = document.getElementById('member-picker');
  if (old) { old.remove(); return; }
  const panel = document.createElement('div');
  panel.id = 'member-picker';
  for (const m of list) {
    const item = document.createElement('div');
    item.className = 'mp-item';
    const name = m.card || m.nickname || `账号 ${m.user_id}`;
    item.innerHTML = `<span class="mp-name">${esc(name)}</span><span class="mp-uid">${esc(m.user_id)}</span>`;
    item.onclick = () => {
      pendingSegs.push({ type: 'at', data: { qq: String(m.user_id), name } });
      renderPendingSegs();
      panel.remove();
      $('input').focus();
    };
    panel.appendChild(item);
  }
  $('composer').appendChild(panel);
  const dismiss = (e) => { if (!panel.contains(e.target) && e.target !== $('btn-at')) { panel.remove(); document.removeEventListener('click', dismiss); } };
  setTimeout(() => document.addEventListener('click', dismiss), 0);
};

async function doSend() {
  if (!activeChat) return;
  const text = $('input').value.trim();
  const segs = [...pendingSegs];
  if (pendingReply) segs.unshift({ type: 'reply', data: { id: pendingReply.id, sender_name: pendingReply.sender_name, text: pendingReply.text } });
  if (text) segs.push({ type: 'text', data: { text } });
  if (!segs.length) return;
  const isGroup = activeChat.type === 'group';
  $('btn-send').disabled = true;
  try {
    if (isGroup) {
      // 本地群：桥对每个成员经 P2P 私发，并落群会话 + 广播回显
      const res = await rpc('send-to-group', { groupId: Number(activeChat.id), message: segs });
      if (res?.failed > 0) {
        $('send-hint').textContent = `已发出，${res.failed} 名成员发送失败`;
        setTimeout(() => { $('send-hint').textContent = ''; }, 4000);
      }
    } else {
      // 私聊：桥经 P2P 直发并立即落账广播（自己发的马上可见；对方离线则排队补发）
      const res = await rpc('send-private', { userId: Number(activeChat.id), segs });
      if (res?.queued) {
        $('send-hint').textContent = '对方设备离线，消息已排队，可达后自动送达';
        setTimeout(() => { $('send-hint').textContent = ''; }, 4000);
      }
    }
    $('input').value = '';
    pendingSegs = [];
    renderPendingSegs();
    pendingReply = null;
    renderPendingReply();
    $('send-hint').textContent && setTimeout(() => { if ($('send-hint').textContent.startsWith('对方') || $('send-hint').textContent.startsWith('已发出')) $('send-hint').textContent = ''; }, 4000);
  } catch (e) {
    $('send-hint').textContent = `发送失败：${e.message}`;
    setTimeout(() => { $('send-hint').textContent = ''; }, 4000);
  } finally {
    $('btn-send').disabled = false;
    $('input').focus();
  }
}

/* ---------- 绑定 ---------- */
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.rail-btn[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.dataset.tab === tab));
  renderList();
  updateAddBtn();
}
document.querySelectorAll('.rail-btn[data-tab]').forEach((b) => b.onclick = () => switchTab(b.dataset.tab));
document.querySelectorAll('.tab').forEach((t) => t.onclick = () => switchTab(t.dataset.tab));
$('search').oninput = renderList;
switchTab('chats');

/* ---------- 软件功能：账号资料 / 加联系人 / 申请处理 / 建群 ---------- */
function rpc(name, params) {
  return new Promise((resolve, reject) => {
    const reqId = `rpc_${Date.now().toString(36)}_${actionSeq++}`;
    pendingActions.set(reqId, { resolve, reject });
    send({ type: 'rpc', name, params, reqId });
    setTimeout(() => { if (pendingActions.delete(reqId)) reject(new Error('操作超时')); }, 30000);
  });
}

function openModal(html) { $('modal').innerHTML = html; $('modal-backdrop').hidden = false; }
function closeModal() { modalMode = null; $('modal-backdrop').hidden = true; $('modal').innerHTML = ''; }
$('modal-backdrop').addEventListener('click', (e) => { if (e.target === $('modal-backdrop')) closeModal(); });

function updateAddBtn() {
  const tab = currentTab;
  const btn = $('btn-add');
  if (btn) btn.hidden = tab === 'chats';
}
$('btn-add').onclick = () => {
  currentTab === 'friends' ? openFriendsModal() : openCreateGroupModal();
};

/* 我的账号：昵称/头像手动设置（账号 ID 认设备，不可改） */
/** 等比压缩图片到 maxDim 以内（聊天发图用，避免大图撑爆 P2P 帧）。 */
function compressImage(file, maxDim = 1280) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * scale));
      c.height = Math.max(1, Math.round(img.height * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}
function shrinkImage(file, size) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = c.height = size;
      const ctx = c.getContext('2d');
      const scale = Math.max(size / img.width, size / img.height);
      const w = img.width * scale, h = img.height * scale;
      ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片读取失败')); };
    img.src = url;
  });
}
$('rail-avatar').onclick = () => {
  modalMode = 'profile';
  openModal(`<div class="modal-title">我的账号</div>
    <div class="profile-row">
      <img id="pf-avatar" class="avatar" src="${esc(selfInfo?.avatar || localAvatar(selfInfo?.nickname || '?', selfInfo?.accountId))}">
      <div>
        <button class="mini" id="pf-avatar-btn">更换头像</button>
        <input id="pf-avatar-input" type="file" accept="image/*" hidden>
        <div class="pf-hint">账号 ${esc(selfInfo?.accountId ?? '')}（认设备，不可改）</div>
      </div>
    </div>
    <div class="form-row"><input id="pf-nick" placeholder="昵称" value="${esc(selfInfo?.nickname ?? '')}" maxlength="30"></div>
    <div class="modal-sub">我的连接信息（复制后发给对方，对方粘贴即可添加我）</div>
    <div class="form-row ci-row">
      <input id="pf-ci" readonly value="${esc(myConnInfo())}">
      <button class="mini" id="pf-copy">复制</button>
    </div>
    <div class="modal-sub">跨网穿透（不在同一 WiFi/流量也能连）——到 console.openp2p.cn 注册后复制令牌，两台设备填同一个</div>
    <div class="form-row ci-row">
      <input id="pf-op2p" placeholder="${uiCfg?.op2pTokenSet ? '已启用（输入新令牌可更换）' : 'OpenP2P 令牌（选填）'}" autocomplete="off">
      <button class="mini" id="pf-op2p-save">保存</button>
    </div>
    <div class="form-err" id="pf-err" hidden></div>
    <div class="modal-actions"><button class="ghost" id="pf-cancel">取消</button><button id="pf-ok">保存</button></div>`);
  $('pf-cancel').onclick = closeModal;
  $('pf-avatar-btn').onclick = () => $('pf-avatar-input').click();
  $('pf-op2p-save').onclick = async () => {
    const t = $('pf-op2p').value.trim();
    if (!t) return;
    try {
      await rpc('set-openp2p-token', { token: t });
      $('pf-op2p').value = '';
      $('pf-op2p-save').textContent = '已启用';
      uiCfg.op2pTokenSet = true;
    } catch { $('pf-op2p-save').textContent = '失败'; }
    setTimeout(() => { const b = $('pf-op2p-save'); if (b) b.textContent = '保存'; }, 2500);
  };
  $('pf-copy').onclick = () => copyText(myConnInfo()).then((ok) => {
    $('pf-copy').textContent = ok ? '已复制' : '复制失败';
    setTimeout(() => { const b = $('pf-copy'); if (b) b.textContent = '复制'; }, 2000);
  });
  $('pf-avatar-input').addEventListener('change', () => {
    const file = $('pf-avatar-input').files[0];
    if (file) shrinkImage(file, 128).then((u) => { $('pf-avatar').src = u; }).catch(() => {});
  });
  $('pf-ok').onclick = async () => {
    const err = $('pf-err');
    err.hidden = true;
    $('pf-ok').disabled = true;
    try {
      const avatar = $('pf-avatar').src.startsWith('data:') ? $('pf-avatar').src : undefined;
      await rpc('set-profile', { nickname: $('pf-nick').value.trim(), avatar });
      closeModal();
    } catch (e) { err.textContent = e.message; err.hidden = false; }
    $('pf-ok').disabled = false;
  };
  setTimeout(() => $('pf-nick').focus(), 0);
};

/* 联系人弹窗：手动添加（对方账号 + 连接地址），支持粘贴对方发来的连接信息 */
function openFriendsModal() {
  modalMode = 'friends';
  openModal(`<div class="modal-title">添加联系人</div>
    <div class="form-row ci-row">
      <input id="af-uid" placeholder="对方账号或粘贴连接信息（账号@地址）" inputmode="text">
      <button class="mini" id="af-paste" title="从剪贴板粘贴连接信息">粘贴</button>
    </div>
    <div class="form-row"><input id="af-remark" placeholder="备注（可选）"></div>
    <div class="form-row"><input id="af-endpoint" placeholder="对方连接地址（可选，多个用逗号分隔）"></div>
    <div class="pf-hint">连接信息形如 772592327@192.168.1.5:3021 —— 让对方在「我的账号」里复制发给你。地址可填多个（换网自动轮换）；对方连上来后其最新地址也会自动记录。留空地址时消息会排队。</div>
    <div class="form-err" id="af-err" hidden></div>
    <div class="modal-actions">
      <button class="ghost" id="af-cancel">关闭</button>
      <button id="af-ok">添加</button>
    </div>`);
  $('af-cancel').onclick = closeModal;
  $('af-paste').onclick = async () => {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { /* WebView 可能禁读剪贴板 */ }
    if (!text) { $('af-uid').focus(); return; } // 读不到就让用户长按输入框自己粘
    applyConnInfo(text.trim());
  };
  $('af-ok').onclick = async () => {
    const err = $('af-err');
    err.hidden = true;
    $('af-ok').disabled = true;
    try {
      applyConnInfo($('af-uid').value.trim()); // 输入框里直接粘了"账号@地址"也能自动拆
      const res = await rpc('add-friend', {
        userId: $('af-uid').value.trim(),
        remark: $('af-remark').value.trim(),
        endpoint: $('af-endpoint').value.trim()
      });
      closeModal();
      $('send-hint').textContent = res?.exists ? '对方已在联系人里' : '已添加';
      setTimeout(() => { $('send-hint').textContent = ''; }, 3500);
    } catch (e) { err.textContent = e.message; err.hidden = false; }
    $('af-ok').disabled = false;
  };
  setTimeout(() => $('af-uid').focus(), 0);
}

/** 解析/填充连接信息：'账号@地址1,地址2' / 纯账号 / 纯地址 三种形态。 */
function applyConnInfo(text) {
  const t = String(text ?? '').trim();
  if (!t) return;
  if (t.includes('@')) {
    const at = t.indexOf('@');
    const uid = t.slice(0, at).replace(/\D/g, '');
    const addrs = t.slice(at + 1).trim();
    if (uid) $('af-uid').value = uid;
    if (addrs && !$('af-endpoint').value.trim()) $('af-endpoint').value = addrs;
  } else if (/^\d+$/.test(t)) {
    if (!$('af-uid').value.trim()) $('af-uid').value = t;
  } else if (!$('af-endpoint').value.trim()) {
    $('af-endpoint').value = t;
  }
}

/** 我的连接信息串：账号@IP1:端口,IP2:端口（本机所有局域网 IP，收方按连通性自动轮换） */
function myConnInfo() {
  const port = uiCfg?.p2pPort ?? 3021;
  const ips = Array.isArray(uiCfg?.lanAddrs) ? uiCfg.lanAddrs : [];
  return `${selfInfo?.accountId ?? ''}@${ips.map((ip) => `${ip}:${port}`).join(',')}`;
}

/** 写剪贴板（WebView/旧浏览器兜底走 execCommand）。 */
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fallthrough */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/* 创建群聊：群名 + 从联系人勾选成员 → 本地群，消息逐成员经 P2P 直发 */
function openCreateGroupModal() {
  modalMode = 'create-group';
  openModal(`<div class="modal-title">创建群聊</div>
    <div class="form-row"><input id="cg-name" placeholder="群名称"></div>
    <div class="modal-sub">选择成员（联系人）</div>
    <div id="cg-members" class="cg-members"></div>
    <div class="form-err" id="cg-err" hidden></div>
    <div class="modal-actions">
      <button class="ghost" id="cg-cancel">取消</button>
      <button id="cg-ok">创建</button>
    </div>`);
  const box = $('cg-members');
  if (!friends.length) box.innerHTML = '<div class="req-none">联系人列表为空，先在"联系人"页添加</div>';
  for (const f of friends) {
    const label = document.createElement('label');
    label.className = 'cg-member';
    const name = f.remark || f.nickname || `账号 ${f.user_id}`;
    label.innerHTML = `<input type="checkbox" value="${esc(f.user_id)}"><img class="avatar" src="${esc(avatarOfUser(f.user_id, name))}"><span>${esc(name)}</span>`;
    box.appendChild(label);
  }
  $('cg-cancel').onclick = closeModal;
  $('cg-ok').onclick = async () => {
    const err = $('cg-err');
    err.hidden = true;
    const memberIds = [...box.querySelectorAll('input:checked')].map((x) => x.value);
    $('cg-ok').disabled = true;
    try {
      const res = await rpc('create-group', { name: $('cg-name').value.trim(), memberIds });
      closeModal();
      $('send-hint').textContent = '群已创建';
      setTimeout(() => { $('send-hint').textContent = ''; }, 3000);
      if (res?.group_id) openChat(`g${res.group_id}`);
    } catch (e) { err.textContent = e.message; err.hidden = false; }
    $('cg-ok').disabled = false;
  };
  setTimeout(() => $('cg-name').focus(), 0);
}

$('btn-send').onclick = doSend;
$('input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
});
async function sendSeg(seg, hintWhileSending = '') {
  if (!activeChat) return;
  const isGroup = activeChat.type === 'group';
  if (hintWhileSending) $('send-hint').textContent = hintWhileSending;
  try {
    if (isGroup) {
      const res = await rpc('send-to-group', { groupId: Number(activeChat.id), message: [seg] });
      $('send-hint').textContent = res?.failed > 0 ? `已发出，${res.failed} 名成员失败` : '';
    } else {
      const res = await rpc('send-private', { userId: Number(activeChat.id), segs: [seg] });
      if (res?.queued) $('send-hint').textContent = '对方设备离线，消息已排队，可达后自动送达';
    }
    setTimeout(() => { $('send-hint').textContent = ''; }, 3500);
  } catch (e) {
    $('send-hint').textContent = `发送失败：${e.message}`;
    setTimeout(() => { $('send-hint').textContent = ''; }, 4000);
  }
}

$('btn-image').onclick = () => $('image-input').click();
$('image-input').addEventListener('change', async () => {
  const file = $('image-input').files[0];
  if (!file || !activeChat) return;
  $('image-input').value = '';
  try {
    const dataUrl = await compressImage(file, 1280);
    await sendSeg({ type: 'image', data: { url: dataUrl } }, '图片发送中…');
  } catch (e) {
    $('send-hint').textContent = `图片发送失败：${e.message}`;
    setTimeout(() => { $('send-hint').textContent = ''; }, 4000);
  }
});

/* ---------- 语音：点 🎤 开始录音，再点一次发送，Esc 取消，最长 60 秒 ---------- */
let recState = null;
const MAX_REC_MS = 60000;

async function startRecording() {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => window.MediaRecorder?.isTypeSupported?.(t)) ?? '';
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
  recorder.onstop = () => finishRecording();
  recState = { stream, recorder, chunks, start: Date.now(), cancelled: false };
  recorder.start();
  $('btn-voice').classList.add('recording');
  const ind = $('rec-indicator');
  ind.hidden = false;
  const tick = () => { if (recState) ind.textContent = `● 录音中 ${Math.floor((Date.now() - recState.start) / 1000)}s · 再点一次发送，Esc 取消`; };
  tick();
  recState.timer = setInterval(tick, 250);
  recState.autoStop = setTimeout(() => stopRecording(false), MAX_REC_MS);
}
function stopRecording(cancelled) {
  if (!recState) return;
  recState.cancelled = !!cancelled;
  clearTimeout(recState.autoStop);
  clearInterval(recState.timer);
  try { recState.recorder.stop(); } catch { cleanupRec(); }
}
function cleanupRec() {
  try { recState?.stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  recState = null;
  $('btn-voice').classList.remove('recording');
  $('rec-indicator').hidden = true;
}
async function finishRecording() {
  const st = recState;
  const ms = st ? Date.now() - st.start : 0;
  cleanupRec();
  if (!st || st.cancelled) return;
  if (ms < 400) { $('send-hint').textContent = '录音太短，已取消'; setTimeout(() => { $('send-hint').textContent = ''; }, 2500); return; }
  try {
    const blob = new Blob(st.chunks, { type: st.recorder.mimeType || 'audio/webm' });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const dataUrl = `data:audio/webm;base64,${btoa(bin)}`;
    await sendSeg({ type: 'record', data: { url: dataUrl, duration: Math.round(ms / 1000) } }, '语音发送中…');
  } catch (e) {
    $('send-hint').textContent = `语音发送失败：${e.message}`;
    setTimeout(() => { $('send-hint').textContent = ''; }, 4000);
  }
}
$('btn-voice').onclick = () => {
  if (!activeChat) return;
  if (recState) stopRecording(false);
  else startRecording().catch((e) => {
    $('send-hint').textContent = `无法录音：${e.message}`;
    setTimeout(() => { $('send-hint').textContent = ''; }, 4000);
  });
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && recState) { e.preventDefault(); stopRecording(true); }
});

boot();

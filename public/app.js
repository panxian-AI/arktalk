// ArkTalk 界面逻辑：只跟本地桥通信。完全独立的聊天软件，向外传输是 P2P。
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let ws = null;
let uiCfg = null;      // /api/config（uiToken 等）
let selfInfo = null;   // 本机账号资料 {accountId, nickname, avatar}
let friends = [];      // 联系人（本机管理）[{user_id, nickname, remark, avatar?, endpoint?, local}]
let friendRequests = []; // 好友申请 [{id, from, name, message, time, direction, status}]
let groups = [];       // 群（本机管理）[{group_id, group_name, members?, local}]
let chats = [];        // [{chatKey, lastTime, lastPreview, unread}]
let activeChat = null; // {key, type:'p'|'g', id, name, avatar}
let peers = {};        // accountId -> 是否设备在线（P2P 直连）
let modalMode = null;  // 当前弹窗：friends | create-group | profile | null
let restoredOnce = false; // 是否已经做过"恢复上次会话"（只在首条 hello 做一次）
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

/* ---------- 触屏 / 桌面文案适配：手机上不显示 Enter、Shift+Enter、(S) 这类键盘快捷键 ---------- */
function applyMobileUi() {
  const mobile = !!window.matchMedia?.('(max-width: 760px)').matches;
  const input = $('input'), send = $('btn-send');
  if (input) input.placeholder = mobile ? '输入消息…' : '输入消息，Enter 发送，Shift+Enter 换行';
  if (send) send.textContent = mobile ? '发送' : '发送(S)';
}
window.addEventListener('resize', applyMobileUi);

/* ---------- 连接 ---------- */
async function boot() {
  applyMobileUi();
  // 桥可能在重启（崩溃自动拉起/手动重启）：拉配置失败不能让重连链断掉，
  // 否则界面会永久停在旧状态（"收不到消息"但桥其实一直在收）。
  try {
    uiCfg = await fetch('/api/config').then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
    connect(new URL(`/ws?token=${uiCfg.uiToken}`, location.href.replace(/^http/, 'ws')).href);
  } catch {
    setTimeout(boot, 2000);
  }
}
function connect(url) {
  ws = new WebSocket(url);
  ws.onopen = () => setStatus(true);
  ws.onclose = () => { setStatus(false); setTimeout(boot, 2000); };
  ws.onmessage = (e) => {
    // 单帧处理出错不能连累整条连接：否则一次渲染异常就再也收不到消息
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    try { handleFrame(m); } catch (err) { console.error('handleFrame', err, m?.type); }
  };
}
function setStatus(on) {
  $('conn-dot').className = `dot ${on ? 'on' : 'off'}`;
}

/* ---------- 帧处理 ---------- */
function handleFrame(m) {
  switch (m.type) {
    case 'hello': {
      selfInfo = m.self; friends = m.friends ?? []; groups = m.groups ?? []; chats = m.chats ?? [];
      friendRequests = m.friendRequests ?? friendRequests;
      peers = m.peers ?? {};
      renderSelf(); renderList(); updatePeerPill(); renderFriendRequestBadge();
      // 首次 hello：恢复上次聊到一半的会话（手机端文件选择器导致页面重载时，不至于被甩回列表）
      if (!restoredOnce) {
        restoredOnce = true;
        const last = localStorage.getItem('ark.lastChat');
        if (last && !activeChat) {
          const id = last.slice(1);
          const ok = last[0] === 'g'
            ? (groups ?? []).some((g) => String(g.group_id) === id)
            : (friends ?? []).some((f) => String(f.user_id) === id);
          if (ok) { try { openChat(last); } catch { /* 列表还没就绪就算了 */ } }
        }
      } else if (activeChat) {
        // 断线重连后的 hello：把当前会话的记录补拉一遍（掉线期间漏掉的 event 帧不会再来）
        send({ type: 'history', chatKey: activeChat.key, limit: 50 });
        send({ type: 'read', chatKey: activeChat.key });
      }
      break;
    }
    case 'peers': {
      peers = m.peers ?? {};
      renderList();
      updatePeerPill();
      renderMemberPanel();
      break;
    }
    case 'friend-requests': {
      friendRequests = m.requests ?? [];
      renderFriendRequestBadge();
      if (modalMode === 'friendreq') openFriendRequestsModal();
      break;
    }
    case 'friend-request-new': {
      friendRequests = m.requests ?? friendRequests;
      renderFriendRequestBadge();
      // 收到新申请时自动弹窗提醒（若当前没开其它重要弹窗）
      if (!modalMode) openFriendRequestsModal();
      break;
    }
    case 'event': onEvent(m); break;
    case 'history': onHistory(m); break;
    case 'action-result': onActionResult(m); break;
    case 'self-msg': upsertLocal(m.chatKey, m.record); break;
    case 'read': { // 对方已读回执：把我方消息标成已读
      chats.forEach((c) => { if (c.chatKey === m.chatKey) c.readUpTo = m.upTo; });
      const cache = chatCache.get(m.chatKey);
      if (cache) {
        let changed = false;
        cache.messages.forEach((x) => {
          if (x.self_sent && Number(x.time ?? 0) <= m.upTo && !x.read) { x.read = true; changed = true; }
        });
        if (changed && activeChat?.key === m.chatKey) renderMessages(cache.messages);
      }
      break;
    }
    case 'unread': chats.forEach((c) => { if (m.unread[c.chatKey] !== undefined) c.unread = m.unread[c.chatKey]; }); renderList(); break;
    case 'recalled': markRecalled(m.chatKey, m.messageId); break;
    case 'message-deleted': {
      const cache = chatCache.get(m.chatKey);
      if (cache) {
        cache.messages = cache.messages.filter((x) => String(x.message_id) !== String(m.messageId));
        if (activeChat?.key === m.chatKey) renderMessages(cache.messages);
      }
      break;
    }
    case 'file-progress': setFileStatus(m.fileId, m.size ? `接收中 ${Math.floor((m.received / m.size) * 100)}%` : `接收中 ${fmtSize(m.received)}`); break;
    case 'file-done': {
      const where = m.where || m.path || '';
      setFileDone(m.fileId, where, m.path);
      break;
    }
    case 'file-ack': setFileStatus(m.fileId, '对方已接收 ✓'); break;
    case 'file-error': setFileStatus(m.fileId, `失败：${m.error ?? '传输中止'}`); break;
    case 'send-hint': $('send-hint').textContent = m.text ?? ''; if (m.text) setTimeout(() => { $('send-hint').textContent = ''; }, 6000); break;
  }
}

/** 对方设备在线状态 → 聊天头部的提示条。 */
function updatePeerPill() {
  const pill = $('chat-upstream');
  // 昵称旁的状态点：仅私聊联系人显示（群聊不显示）
  const dot = $('chat-dot');
  if (activeChat?.type === 'private' && Array.isArray(friends) && friends.some((f) => String(f.user_id) === String(activeChat.id))) {
    dot.hidden = false;
    dot.className = `on-dot ${peers[String(activeChat.id)] ? 'on' : 'off'}`;
    dot.title = peers[String(activeChat.id)] ? '在线（P2P 直连）' : '离线（消息会排队）';
    // 副标题写成文字：光靠圆点很容易误判"看不到在线"
    const sub = $('chat-sub');
    if (sub) sub.textContent = `账号 ${activeChat.id} · ${peers[String(activeChat.id)] ? '在线（P2P 直连）' : '离线（消息会排队）'}`;
  } else if (dot) {
    dot.hidden = true;
  }
  updateOnlineBar();
  if (!activeChat || activeChat.type !== 'private') { pill.hidden = true; return; }
  const online = peers[String(activeChat.id)];
  pill.hidden = online !== false; // 只有明确离线才提示
}

/** 侧栏顶部的在线概览：在线 N/M 与具体账号，避免"看不出来谁在线"。 */
function updateOnlineBar() {
  const bar = $('online-bar');
  if (!bar) return;
  const list = Array.isArray(friends) ? friends : [];
  const on = list.filter((f) => peers[String(f.user_id)]).map((f) => String(f.user_id));
  bar.hidden = list.length === 0;
  if (!list.length) return;
  bar.className = `online-bar ${on.length ? 'has-on' : ''}`;
  bar.innerHTML = on.length
    ? `<span class="ob-dot on"></span>在线 ${on.length}/${list.length}${on.length < list.length ? ` · <span class="ob-dim">离线 ${list.length - on.length}</span>` : ''}`
    : `<span class="ob-dot off"></span>联系人都离线（消息会排队）`;
  bar.title = on.length ? `在线账号：${on.join('、')}` : '当前没有任何联系人可达';
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
  if (activeChat?.key === chatKey) {
    appendMessage(record);
    // 正开着这个会话又收到新消息：立即回已读，不让对方干等"未读"
    if (!record.self_sent) send({ type: 'read', chatKey });
  }
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
        c?.lastPreview || (peers[String(f.user_id)] ? '在线 · 可直连' : '离线 · 消息会排队'), '', c?.unread ?? 0,
        { edit: () => editRemark(f.user_id, name), delete: () => confirmRemoveFriend(f.user_id, name) }));
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

/** 改联系人备注（仅本机生效，随时可改）。 */
function editRemark(userId, oldName) {
  modalMode = 'set-remark';
  openModal(`<div class="modal-title">修改备注</div>
    <div class="form-row"><input id="sr-remark" value="${esc(oldName || '')}" placeholder="备注名"></div>
    <div class="pf-hint">备注只显示在你这边，对方不会知道，也不会改变聊天记录。</div>
    <div class="form-err" id="sr-err" hidden></div>
    <div class="modal-actions">
      <button class="ghost" id="sr-cancel">取消</button>
      <button id="sr-ok">保存</button>
    </div>`);
  $('sr-cancel').onclick = closeModal;
  $('sr-ok').onclick = async () => {
    const err = $('sr-err'); err.hidden = true;
    $('sr-ok').disabled = true;
    try {
      await rpc('set-remark', { userId, remark: $('sr-remark').value });
      const f = friends.find((x) => String(x.user_id) === String(userId));
      if (f) f.remark = $('sr-remark').value.trim();
      closeModal(); renderList();
      if (activeChat?.key === `p${userId}`) $('chat-name').textContent = f?.remark || f?.nickname || oldName;
    } catch (e) { err.textContent = e.message; err.hidden = false; }
    $('sr-ok').disabled = false;
  };
  setTimeout(() => { $('sr-remark').focus(); $('sr-remark').select(); }, 0);
}

/** 删除联系人：可选连带删除本机聊天记录（不影响对方设备）。 */
function confirmRemoveFriend(userId, name) {
  modalMode = 'remove-friend';
  openModal(`
    <div class="modal-title">删除联系人「${esc(name)}」</div>
    <div class="modal-sub">聊天记录怎么处理？（只影响本机，不会删对方设备的记录）</div>
    <div class="del-choice">
      <label><input type="radio" name="del-scope" value="keep" checked> <span>保留聊天记录</span></label>
      <label><input type="radio" name="del-scope" value="all"> <span>删除全部聊天记录</span></label>
      <label><input type="radio" name="del-scope" value="sent"> <span>只删我发出的消息</span></label>
      <label><input type="radio" name="del-scope" value="received"> <span>只删收到的消息</span></label>
    </div>
    <div class="modal-actions"><button class="ghost" id="rf-cancel">取消</button><button id="rf-ok">删除联系人</button></div>`);
  $('rf-cancel').onclick = () => closeModal();
  $('rf-ok').onclick = async () => {
    const scope = document.querySelector('input[name="del-scope"]:checked')?.value ?? 'keep';
    closeModal();
    try {
      const r = await rpc('remove-friend', { userId, chatDelete: scope });
      friends = friends.filter((f) => String(f.user_id) !== String(userId));
      chatCache.delete(`p${userId}`); // 清缓存，下次进入重新读，已删消息不再出现
      if (activeChat?.key === `p${userId}`) exitChatToMobileList();
      renderList();
      $('send-hint').textContent = (r?.deletedMessages > 0)
        ? `已删除联系人，清理 ${r.deletedMessages} 条本地记录` : '已删除';
    } catch (e) {
      $('send-hint').textContent = `删除失败：${e.message}`;
    }
    setTimeout(() => { $('send-hint').textContent = ''; }, 3200);
  };
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
    ${opts.edit ? '<button class="item-edit" title="改备注">✎</button>' : ''}
    ${opts.delete ? '<button class="item-del" title="删除">✕</button>' : ''}`;
  div.onclick = () => openChat(key);
  if (opts.edit) {
    div.querySelector('.item-edit').onclick = (e) => { e.stopPropagation(); opts.edit(); };
  }
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
  // 私聊才有已读回执：自己发的消息在气泡下角标"已读/未读"（群聊收不到回执，不标）
  const readMark = mine && activeChat?.type === 'private'
    ? `<div class="read-mark ${msg.read ? 'is-read' : ''}">${msg.read ? '已读' : '未读'}</div>` : '';
  // 撤回按钮：只给自己发的、还没送达的消息（桥会校验，已发出的会拒绝）
  const recallBtn = (mine && msg.queued && !msg.recalled)
    ? '<button class="msg-quote-btn recall-btn" title="撤回这条消息">撤回</button>' : '';
  row.innerHTML = `<img class="avatar" src="${esc(avatarOfUser(uin, name))}" onerror="this.style.visibility='hidden'">
    <div class="bubble-wrap">
      <div class="sender">${esc(name)} · ${esc(fmtTime(msg.time))}</div>
      <div class="bubble ${msg.recalled ? 'recalled' : ''}">${msg.recalled ? '（已撤回）' : renderSegments(msg.message, mine)}</div>
      ${readMark}
    </div>
    ${msg.recalled ? '' : recallBtn + '<button class="msg-quote-btn" title="引用这条消息">引用</button>'}
    <button class="msg-quote-btn del-msg-btn" title="删除这条消息（仅本机）">删除</button>`;
  row.querySelector('.msg-quote-btn:not(.recall-btn):not(.del-msg-btn)')?.addEventListener('click', () => setReply(msg));
  row.querySelector('.recall-btn')?.addEventListener('click', () => recallMessage(msg));
  row.querySelector('.del-msg-btn')?.addEventListener('click', (e) => { e.stopPropagation(); confirmDeleteMessage(msg); });
  // 手机：长按气泡删除（与点击图片放大、文件卡片操作不冲突——只在 bubble-wrap 上长按）
  const bubbleWrap = row.querySelector('.bubble-wrap');
  if (bubbleWrap) {
    let lpTimer = null, lpX = 0, lpY = 0;
    bubbleWrap.addEventListener('touchstart', (e) => {
      if (e.touches.length !== 1) return;
      lpX = e.touches[0].clientX; lpY = e.touches[0].clientY;
      lpTimer = setTimeout(() => { lpTimer = null; confirmDeleteMessage(msg); }, 600);
    }, { passive: true });
    bubbleWrap.addEventListener('touchmove', (e) => {
      if (lpTimer && Math.hypot(e.touches[0].clientX - lpX, e.touches[0].clientY - lpY) > 10) {
        clearTimeout(lpTimer); lpTimer = null;
      }
    }, { passive: true });
    const cancel = () => { if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; } };
    bubbleWrap.addEventListener('touchend', cancel);
    bubbleWrap.addEventListener('touchcancel', cancel);
  }
  return row;
}

/** 撤回一条还没发出去的消息（对方离线时排队中的）。 */
function recallMessage(msg) {
  if (!activeChat) return;
  rpc('recall-message', { chatKey: activeChat.key, messageId: msg.message_id })
    .catch((e) => { alert(`撤回失败：${e.message}`); });
}

/** 删除单条消息：仅本机物理删除，不影响对方；电脑点「删除」按钮、手机长按气泡都走这里。 */
function confirmDeleteMessage(msg) {
  if (!activeChat || !window.confirm('删除这条消息？\n只从本机删除，不影响对方设备。')) return;
  rpc('delete-message', { chatKey: activeChat.key, messageId: msg.message_id })
    .then(() => {
      const cache = chatCache.get(activeChat.key);
      if (cache) {
        cache.messages = cache.messages.filter((x) => String(x.message_id) !== String(msg.message_id));
        renderMessages(cache.messages);
      }
    })
    .catch((e) => { alert(`删除失败：${e.message}`); });
}

/* ---------- 文件：发（📎 上传→发卡片）与收（点保存才拉取） ---------- */
function setFileStatus(fid, text) {
  document.querySelectorAll(`[data-fstatus="${CSS.escape(String(fid))}"]`).forEach((el) => { el.textContent = text; });
}
/** 下载完成：显示保存路径 + 附带"打开位置"按钮（资源管理器/下载应用直达）。 */
function setFileDone(fid, where, fullPath) {
  document.querySelectorAll(`[data-fstatus="${CSS.escape(String(fid))}"]`).forEach((el) => {
    el.textContent = where ? `已保存：${where}` : '已保存 ✓';
    if (where) el.title = where;
    if (fullPath) {
      const card = el.closest('.file-card');
      if (card) { card.dataset.dpath = fullPath; card.draggable = true; card.title = '拖到桌面/文件夹可直接复制'; }
      if (!el.parentElement.querySelector('.loc-btn')) {
        const b = document.createElement('button');
        b.className = 'mini loc-btn';
        b.textContent = '📁 位置';
        b.dataset.loc = fullPath;
        el.after(b);
      }
    }
  });
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
  // 安卓端走原生选择：桥直接收发，页面不参与 —— 系统选择器把页面盖住/Activity 重建都不影响发送
  if (window.arkNative) {
    rpc('pick-file', { kind: 'any', userId: Number(activeChat.id) })
      .then(() => { $('send-hint').textContent = '请在系统文件选择器中选择要发送的文件…'; setTimeout(() => { $('send-hint').textContent = ''; }, 8000); })
      .catch((e) => { $('send-hint').textContent = `文件发送失败：${e.message}`; setTimeout(() => { $('send-hint').textContent = ''; }, 4000); });
    return;
  }
  $('file-input').click();
};
/** 把一个本地 File 作为「文件消息」发送（📎 选择 / 拖入都走这里）。 */
async function sendLocalFile(file) {
  if (!file || !activeChat || activeChat.type !== 'private') return false;
  try {
    $('send-hint').textContent = `上传中… ${file.name}`;
    const up = await uploadFile(file, (p) => { $('send-hint').textContent = `上传中… ${file.name} ${Math.floor(p * 100)}%`; });
    await rpc('send-file', { userId: Number(activeChat.id), fileId: up.fileId, name: up.name, size: up.size });
    $('send-hint').textContent = '';
    return true;
  } catch (e) {
    $('send-hint').textContent = `文件发送失败：${e.message}`;
    setTimeout(() => { $('send-hint').textContent = ''; }, 4000);
    return false;
  }
}
$('file-input').addEventListener('change', async () => {
  const file = $('file-input').files[0];
  $('file-input').value = '';
  await sendLocalFile(file);
});
$('messages').addEventListener('click', async (e) => {
  const loc = e.target.closest('.loc-btn');
  if (loc) {
    try {
      await rpc('open-location', { path: loc.dataset.loc });
    } catch (err) { alert(`打开位置失败：${err.message}`); }
    return;
  }
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
        html += `<img class="image-seg" src="${esc(src)}" data-dname="${esc(d.name ?? '')}" loading="lazy" draggable="true" title="点击放大 / 拖到桌面保存">`;
        break;
      }
      case 'reply': html += `<div class="reply-quote">回复 ${esc(d.sender_name ?? '')}：${esc(d.text ?? '')}</div>`; break;
      case 'record': {
        const src = d.url ?? (d.file && String(d.file).startsWith('base64://') ? `data:audio/webm;base64,${String(d.file).slice('base64://'.length)}` : d.file);
        const dur = Number(d.duration) || 0;
        html += src
          ? `<div class="voice-card"><span class="voice-icon">🎤</span><span class="voice-label">${dur ? `${dur}″` : '语音'}</span><audio controls preload="metadata" src="${esc(src)}"></audio></div>`
          : '<span style="color:var(--text-sub)">[语音]</span>';
        break;
      }
      case 'video': html += d.url ? `<video controls src="${esc(d.url)}" style="max-width:220px;border-radius:6px"></video>` : '<span style="color:var(--text-sub)">[视频]</span>'; break;
      case 'file': {
        const fid = String(d.file_id ?? '');
        const nm = String(d.name ?? '文件');
        const sz = fmtSize(d.size);
        // 下过的文件直接显示"已保存"路径，不再误导人重新下载；按钮保留可重下
        const status = `<span class="file-status" data-fstatus="${esc(fid)}">${d.downloaded ? `已保存：${esc(d.where ?? '')}` : ''}</span>`;
        const dlBtn = mine ? '' : `<button class="mini primary dl-btn" data-dl="${esc(fid)}" data-name="${esc(nm)}" data-size="${esc(d.size ?? 0)}">${d.downloaded ? '重新下载' : '保存'}</button>`;
        const locBtn = d.downloaded && d.dpath ? `<button class="mini loc-btn" data-loc="${esc(d.dpath)}" title="打开文件所在位置">📁 位置</button>` : '';
        html += `<div class="card-seg file-card" ${d.downloaded && d.dpath ? `data-dpath="${esc(d.dpath)}" draggable="true" title="拖到桌面/文件夹可直接复制"` : ''}><span class="file-name">📎 ${esc(nm)}（${sz}）</span><span class="file-actions">${dlBtn}${locBtn}</span>${status}</div>`;
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
/* ---------- 头像 1:1 裁切：选图 → 弹出裁切框（拖动定位 + 滚轮/滑块缩放）→ 确认成正方形 ---------- */
let cropState = null; // {img, scale, minScale, x, y, size}
function openAvatarCropper(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    const size = 240;              // 裁切框显示尺寸
    const minScale = Math.min(size / img.width, size / img.height); // 至少铺满
    cropState = { img, scale: minScale, minScale, x: 0, y: 0, size };
    openModal(`<div class="modal-title">裁切头像（1:1）</div>
      <div class="crop-stage" id="crop-stage"><canvas id="crop-canvas" width="${size}" height="${size}"></canvas></div>
      <div class="crop-controls">
        <span>缩放</span>
        <input type="range" id="crop-zoom" min="${Math.round(minScale * 100)}" max="${Math.round(minScale * 4 * 100)}" value="${Math.round(minScale * 100)}">
      </div>
      <div class="pf-hint" style="text-align:center">拖动图片调整位置，滚轮或滑块缩放，确认后保存为正方形头像</div>
      <div class="modal-actions"><button class="ghost" id="crop-cancel">取消</button><button id="crop-ok">使用这张</button></div>`);
    const cvs = $('crop-canvas');
    const ctx = cvs.getContext('2d');
    const draw = () => {
      const s = cropState;
      const w = s.img.width * s.scale, h = s.img.height * s.scale;
      ctx.clearRect(0, 0, s.size, s.size);
      ctx.fillStyle = '#eceff4'; ctx.fillRect(0, 0, s.size, s.size);
      ctx.drawImage(s.img, (s.size - w) / 2 + s.x, (s.size - h) / 2 + s.y, w, h);
    };
    // 限制拖动范围：图边缘不能露白
    const clamp = () => {
      const s = cropState;
      const w = s.img.width * s.scale, h = s.img.height * s.scale;
      const maxX = Math.max(0, (w - s.size) / 2), maxY = Math.max(0, (h - s.size) / 2);
      s.x = Math.max(-maxX, Math.min(maxX, s.x));
      s.y = Math.max(-maxY, Math.min(maxY, s.y));
    };
    let drag = null;
    cvs.addEventListener('pointerdown', (e) => { drag = { x: e.clientX, y: e.clientY, ox: cropState.x, oy: cropState.y }; cvs.setPointerCapture(e.pointerId); });
    cvs.addEventListener('pointermove', (e) => { if (!drag) return; cropState.x = drag.ox + e.clientX - drag.x; cropState.y = drag.oy + e.clientY - drag.y; clamp(); draw(); });
    cvs.addEventListener('pointerup', () => { drag = null; });
    cvs.addEventListener('wheel', (e) => {
      e.preventDefault();
      const s = cropState;
      s.scale = Math.max(s.minScale, Math.min(s.minScale * 4, s.scale * (e.deltaY > 0 ? 0.92 : 1.08)));
      clamp(); draw();
      $('crop-zoom').value = Math.round(s.scale * 100);
    }, { passive: false });
    $('crop-zoom').oninput = (e) => { cropState.scale = Number(e.target.value) / 100; clamp(); draw(); };
    $('crop-cancel').onclick = () => { cropState = null; openProfileModal(); };
    $('crop-ok').onclick = () => {
      const s = cropState;
      const out = document.createElement('canvas');
      out.width = out.height = 256;
      const octx = out.getContext('2d');
      const w = s.img.width * s.scale, h = s.img.height * s.scale;
      octx.fillStyle = '#eceff4'; octx.fillRect(0, 0, 256, 256);
      octx.drawImage(s.img, (256 - w) / 2 + s.x * (256 / s.size), (256 - h) / 2 + s.y * (256 / s.size), w, h);
      const dataUrl = out.toDataURL('image/jpeg', 0.88);
      cropState = null;
      openProfileModal(dataUrl);
    };
    draw();
  };
  img.onerror = () => { alert('图片读取失败'); };
  img.src = url;
}

$('rail-avatar').onclick = () => openProfileModal();
/** 打开「我的账号」弹窗；pendingAvatar 为裁切好的头像 data URL（有则预填）。 */
function openProfileModal(pendingAvatar) {
  modalMode = 'profile';
  openModal(`<div class="modal-title">我的账号</div>
    <div class="profile-row">
      <img id="pf-avatar" class="avatar" src="${esc(pendingAvatar || selfInfo?.avatar || localAvatar(selfInfo?.nickname || '?', selfInfo?.accountId))}">
      <div>
        <button class="mini" id="pf-avatar-btn">上传并裁切头像</button>
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
    <div class="modal-sub">跨网穿透令牌（不在同一 WiFi/流量也能连）——可保存多个令牌随时切换，两台设备填同一个令牌才能互通</div>
    <div class="token-box">
      <div class="token-list" id="pf-token-list"><div class="pf-hint">读取中…</div></div>
      <div class="token-add">
        <input id="pf-token-name" class="tk-name-input" placeholder="备注名" maxlength="16">
        <input id="pf-token-value" placeholder="粘贴 OpenP2P 令牌" autocomplete="off">
        <button class="mini" id="pf-token-add">添加</button>
      </div>
    </div>
    <div class="op2p-diag">
      <div class="diag-head"><span id="pf-op2p-dot" class="on-dot off"></span><span id="pf-op2p-status">穿透状态：读取中…</span><button class="mini" id="pf-op2p-diag">诊断包</button><button class="mini" id="pf-op2p-refresh">刷新</button></div>
      <pre class="diag-log" id="pf-op2p-log"></pre>
    </div>
    ${window.arkNative ? `<div class="op2p-diag">
      <div class="diag-head"><span id="pf-dns-dot" class="on-dot off"></span><span id="pf-dns-status">DNS 修复：读取中…</span><button class="mini" id="pf-dns-btn">开启</button></div>
      <div class="pf-hint">有些运营商（如广电物联网卡）会拦截境外 DNS，穿透程序只会卡在「等待登录…」。开启后只接管公共 DNS 的 53 端口查询、改用本机运营商 DNS，不影响其它上网流量。</div>
    </div>` : ''}
    ${window.arkDesktop?.isElectron ? `<div class="modal-sub">存储位置（聊天记录与接收的文件）</div>
    <div class="storage-box" id="pf-storage-box">
      <div class="storage-line"><span>数据目录</span><code id="pf-storage-data">读取中…</code></div>
      <div class="storage-line"><span>接收文件</span><code id="pf-storage-dl">读取中…</code></div>
      <div class="update-actions">
        <button class="mini" id="pf-storage-data-btn">更改数据目录…</button>
        <button class="mini" id="pf-storage-dl-btn">更改接收目录…</button>
      </div>
      <div class="pf-hint">更改后会把已有数据复制到新目录并重启应用；原目录保留不删除。</div>
    </div>` : ''}
    <div class="modal-sub">数据备份（聊天记录 + 配置，可迁移到其他设备）</div>
    <div class="backup-box" id="pf-backup-box">
      <div class="backup-stat" id="pf-backup-stat">读取中…</div>
      <div class="update-actions">
        <button class="mini primary" id="pf-backup-export">导出备份</button>
        <button class="mini" id="pf-backup-import">导入备份</button>
      </div>
      <label class="backup-check"><input type="checkbox" id="pf-backup-replace"> 导入时用备份里的账号身份替换本机（换设备时勾选）</label>
      <div class="pf-hint">导出的 .zip 含全部聊天记录、联系人、令牌设置和已发送的文件，未来版本也能导入。导入采用「合并」方式，不会删除现有消息；重复导入不会产生重复内容。</div>
      <div class="backup-msg" id="pf-backup-msg" hidden></div>
      <input type="file" id="pf-backup-file" accept=".zip,application/zip" hidden>
    </div>
    <div class="modal-sub">软件更新（只有被标记为「正式稳定版」的版本才会提示）</div>
    <div class="update-box" id="pf-update-box">
      <div class="update-line"><span id="pf-update-status">检查中…</span><button class="mini" id="pf-update-check">重新检查</button></div>
      <div class="update-notes" id="pf-update-notes" hidden></div>
      <div class="update-actions" id="pf-update-actions" hidden>
        <button class="mini primary" id="pf-update-do">下载并安装</button>
        <button class="mini" id="pf-update-later">跳过此版</button>
      </div>
      <div class="update-actions" id="pf-update-rollback-box" hidden>
        <button class="mini" id="pf-update-rollback">回退到上一个版本</button>
      </div>
    </div>
    <div class="form-err" id="pf-err" hidden></div>
    <div class="modal-actions"><button class="ghost" id="pf-cancel">取消</button><button id="pf-ok">保存</button></div>`);
  $('pf-cancel').onclick = closeModal;
  $('pf-avatar-btn').onclick = () => $('pf-avatar-input').click();
  // 多令牌管理：列表 + 添加 + 切换 + 删除
  const renderTokens = async () => {
    const box = $('pf-token-list');
    if (!box) return;
    try {
      const r = await rpc('list-tokens');
      const list = Array.isArray(r.tokens) ? r.tokens : [];
      if (!list.length) {
        box.innerHTML = '<div class="pf-hint">还没有保存令牌。在下方粘贴令牌并起个备注名即可添加。</div>';
        return;
      }
      box.innerHTML = list.map((t) => `<div class="token-item ${t.active ? 'active' : ''}" data-id="${esc(t.id)}">
        <span class="tk-name" title="${esc(t.name)}">${esc(t.name)}</span>
        <span class="tk-masked">${esc(t.masked)}</span>
        ${t.active ? '<span class="tk-badge">使用中</span>' : `<button class="mini tk-use">启用</button>`}
        <button class="mini tk-del" title="删除">✕</button>
      </div>`).join('');
      box.querySelectorAll('.token-item').forEach((el) => {
        const id = el.dataset.id;
        const use = el.querySelector('.tk-use');
        if (use) use.onclick = async () => {
          use.disabled = true;
          try { await rpc('switch-token', { id }); await renderTokens(); uiCfg.op2pTokenSet = true; setTimeout(refreshRelayStatus, 1500); setTimeout(refreshRelayStatus, 6000); }
          catch (e) { use.disabled = false; alert('切换失败：' + e.message); }
        };
        const del = el.querySelector('.tk-del');
        if (del) del.onclick = async () => {
          if (!confirm('确定删除这个令牌？')) return;
          try { await rpc('remove-token', { id }); await renderTokens(); setTimeout(refreshRelayStatus, 1200); }
          catch (e) { alert('删除失败：' + e.message); }
        };
      });
    } catch (e) { box.innerHTML = `<div class="pf-hint">读取失败：${esc(e.message)}</div>`; }
  };
  $('pf-token-add').onclick = async () => {
    const name = $('pf-token-name').value.trim();
    const token = $('pf-token-value').value.trim();
    if (!token) { alert('请先粘贴令牌'); return; }
    const btn = $('pf-token-add');
    btn.disabled = true; btn.textContent = '添加中…';
    try {
      await rpc('add-token', { name, token });
      $('pf-token-name').value = ''; $('pf-token-value').value = '';
      await renderTokens(); uiCfg.op2pTokenSet = true;
      setTimeout(refreshRelayStatus, 1500); setTimeout(refreshRelayStatus, 6000);
    } catch (e) { alert('添加失败：' + e.message); }
    btn.disabled = false; btn.textContent = '添加';
  };
  renderTokens();
  $('pf-copy').onclick = () => copyText(myConnInfo()).then((ok) => {
    $('pf-copy').textContent = ok ? '已复制' : '复制失败';
    setTimeout(() => { const b = $('pf-copy'); if (b) b.textContent = '复制'; }, 2000);
  });
  // 穿透状态自检：显示进程是否在跑 / 登录是否成功 / 最近输出
  const refreshRelayStatus = async () => {
    const st = $('pf-op2p-status');
    if (!st) return;
    try {
      const r = await rpc('relay-status');
      const dot = $('pf-op2p-dot');
      const ok = !!r.running;
      dot.className = `on-dot ${ok ? 'on' : 'off'}`;
      st.textContent = `${ok ? '✅' : '⚠️'} ${r.status || (r.tokenSet ? '未知' : '未设置令牌')}｜节点 ${r.node || '-'}`;
      const logEl = $('pf-op2p-log');
      const lines = Array.isArray(r.log) ? r.log : [];
      const crash = (r.crash || '').trim();
      logEl.textContent = (lines.length ? lines.slice(-10).join('\n') : '（暂无输出）')
        + (crash ? `\n— 上次崩溃 —\n${crash.slice(-600)}` : '');
    } catch (e) {
      st.textContent = `⚠️ 读取失败：${e.message}`;
    }
  };
  refreshRelayStatus();
  $('pf-op2p-refresh').onclick = refreshRelayStatus;
  $('pf-op2p-diag').onclick = async () => {
    const btn = $('pf-op2p-diag');
    btn.textContent = '采集中…';
    try {
      const r = await rpc('diag-pack');
      const txt = JSON.stringify(r, null, 1);
      const logEl = $('pf-op2p-log');
      if (logEl) logEl.textContent = (r && r.file ? `📄 已保存文件：${r.file}\n\n` : '') + txt;
      const ok = await copyText(txt);
      btn.textContent = ok ? '已复制' : '已生成';
    } catch (e) {
      btn.textContent = '失败';
      const logEl = $('pf-op2p-log');
      if (logEl) logEl.textContent = `诊断包生成失败：${e.message}`;
    }
    setTimeout(() => { const b = $('pf-op2p-diag'); if (b) b.textContent = '诊断包'; }, 2500);
  };

  // DNS 修复隧道（仅安卓原生壳里有）：接管穿透程序发出的 DNS 查询
  const refreshDnsStatus = async () => {
    const st = $('pf-dns-status');
    if (!st) return;
    try {
      const r = await rpc('dns-tunnel');
      const dot = $('pf-dns-dot');
      dot.className = `on-dot ${r.running ? 'on' : 'off'}`;
      if (r.running) {
        st.textContent = `✅ 已开启｜接管 ${r.intercepted || 0} 次查询｜上游 ${r.upstream || '读取中'}`;
      } else if (r.otherVpn) {
        st.textContent = '⚠️ 检测到其它 VPN 正在运行，请先关闭再开启';
      } else if (!r.authorized) {
        st.textContent = '⚠️ 未授权（点「开启」按提示允许 VPN）';
      } else {
        st.textContent = `⚠️ 未开启${r.err ? '：' + r.err : ''}`;
      }
      const btn = $('pf-dns-btn');
      if (btn) btn.textContent = r.running ? '重启' : '开启';
    } catch (e) {
      st.textContent = `⚠️ 读取失败：${e.message}`;
    }
  };
  refreshDnsStatus();
  if ($('pf-dns-btn')) {
    $('pf-dns-btn').onclick = () => {
      // 自定义 scheme 交给原生壳处理（授权 → 起隧道服务）
      location.href = 'arktalk://dns-fix';
      setTimeout(refreshDnsStatus, 1500);
      setTimeout(refreshDnsStatus, 4000);
    };
  }
  $('pf-avatar-input').addEventListener('change', () => {
    const file = $('pf-avatar-input').files[0];
    if (file) openAvatarCropper(file);
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
  // ---------- 软件更新（两端统一入口：PC 走 arkDesktop，安卓走桥 RPC） ----------
  const upd = {
    check: () => (window.arkDesktop?.isElectron ? window.arkDesktop.updateCheck() : rpc('update-check')),
    prepare: () => (window.arkDesktop?.isElectron ? window.arkDesktop.updatePrepare() : rpc('update-prepare')),
    apply: () => (window.arkDesktop?.isElectron ? window.arkDesktop.updateApply() : rpc('update-apply')),
    skip: (v) => (window.arkDesktop?.isElectron ? window.arkDesktop.updateSkip(v) : rpc('update-skip', { version: v })),
    rollback: () => (window.arkDesktop?.isElectron ? window.arkDesktop.updateRollback() : rpc('update-rollback'))
  };
  const renderUpdate = async () => {
    const st = $('pf-update-status'), box = $('pf-update-box');
    if (!st || !box) return;
    try {
      const r = await upd.check();
      if (r.error) { st.textContent = `检查失败：${r.error}`; return; }
      if (r.dev) { st.textContent = '当前为开发模式（发行版才有自动更新）'; return; }
      if (r.available && !r.skipped) {
        st.textContent = `✅ 有正式更新：${r.current} → ${r.latest}${r.published ? `（${r.published}）` : ''}${r.source ? ` · 线路 ${r.source}` : ''}`;
        const notes = $('pf-update-notes');
        if (r.notes) { notes.textContent = r.notes; notes.hidden = false; }
        $('pf-update-actions').hidden = false;
        $('pf-update-do').onclick = async () => {
          const btn = $('pf-update-do');
          btn.disabled = true; btn.textContent = '下载中…';
          try {
            const p = await upd.prepare();
            if (p?.ok === false) throw new Error(p.error);
            btn.textContent = '安装并重启…';
            const a = await upd.apply();
            if (a?.ok === false) throw new Error(a.error);
          } catch (e) { st.textContent = `更新失败：${e.message}`; btn.disabled = false; btn.textContent = '下载并安装'; }
        };
        $('pf-update-later').onclick = async () => { await upd.skip(r.latest); $('pf-update-actions').hidden = true; st.textContent = `已跳过 ${r.latest}（需要时点「重新检查」）`; };
      } else if (r.available && r.skipped) {
        st.textContent = `有新版本 ${r.latest}（你已选择跳过）`;
        $('pf-update-actions').hidden = false;
        $('pf-update-later').textContent = '取消跳过';
        $('pf-update-later').onclick = async () => { await upd.skip(''); location.reload(); };
        $('pf-update-do').onclick = async () => {
          const btn = $('pf-update-do'); btn.disabled = true; btn.textContent = '下载中…';
          try { const p = await upd.prepare(); if (p?.ok === false) throw new Error(p.error); btn.textContent = '安装并重启…'; const a = await upd.apply(); if (a?.ok === false) throw new Error(a.error); }
          catch (e) { st.textContent = `更新失败：${e.message}`; btn.disabled = false; btn.textContent = '下载并安装'; }
        };
      } else {
        st.textContent = `✅ 已是最新正式版（${r.current || '?'}）`;
      }
      // 回退入口（PC 有备份 / 安卓有备份的 APK 时显示）
      const canRollback = window.arkNative
        ? (await rpc('update-has-backup').catch(() => ({ ok: false }))).ok
        : !!r.canRollback;
      if (canRollback) {
        $('pf-update-rollback-box').hidden = false;
        $('pf-update-rollback').onclick = async () => {
          try { const a = await upd.rollback(); if (a?.ok === false) throw new Error(a.error); }
          catch (e) { st.textContent = `回退失败：${e.message}`; }
        };
      }
    } catch (e) { st.textContent = `检查失败：${e.message}`; }
  };
  $('pf-update-check').onclick = renderUpdate;
  renderUpdate();

  // ---------- 存储位置（仅电脑版）：读当前路径 / 选目录 / 迁移并重启 ----------
  const initStorage = async () => {
    if (!window.arkDesktop?.isElectron || !$('pf-storage-data')) return;
    try {
      const info = await rpc('storage-info');
      const showData = $('pf-storage-data'), showDl = $('pf-storage-dl');
      if (showData) showData.textContent = info.dataDir || '-';
      if (showDl) showDl.textContent = info.downloadsDir || '-';
      const change = async (kind) => {
        const isData = kind === 'data';
        const title = isData ? '选择聊天记录与文件存储目录' : '选择接收文件保存目录';
        const dir = await window.arkDesktop.storageChoose(title);
        if (!dir) return;
        const what = isData ? '数据目录' : '接收文件目录';
        if (!confirm(`确定把${what}改为：\n${dir}\n\n已有数据会复制到新目录，随后自动重启应用。原目录会保留，不会删除。`)) return;
        const btn = $(isData ? 'pf-storage-data-btn' : 'pf-storage-dl-btn');
        if (btn) { btn.disabled = true; btn.textContent = '迁移中…'; }
        try {
          const r = await window.arkDesktop.storageSet({
            dataDir: isData ? dir : null,
            downloadsDir: isData ? null : dir,
            migrate: isData
          });
          if (r?.ok === false) throw new Error(r.error || '未知错误');
        } catch (e) {
          alert(`修改失败：${e.message}`);
          if (btn) { btn.disabled = false; btn.textContent = '更改…'; }
        }
      };
      $('pf-storage-data-btn').onclick = () => change('data');
      $('pf-storage-dl-btn').onclick = () => change('dl');
    } catch (e) {
      const el = $('pf-storage-data');
      if (el) el.textContent = `读取失败：${e.message}`;
    }
  };
  initStorage();

  // ---------- 数据备份（两端通用）：导出 / 导入 ----------
  const backupMsg = (text, kind = '') => {
    const el = $('pf-backup-msg');
    if (!el) return;
    el.textContent = text; el.hidden = !text;
    el.className = 'backup-msg' + (kind ? ' ' + kind : '');
  };
  const initBackup = async () => {
    const stat = $('pf-backup-stat');
    if (!stat) return;
    try {
      const info = await rpc('backup-info');
      stat.innerHTML = `当前：<b>${info.messages || 0}</b> 条消息 · <b>${info.chats || 0}</b> 个会话 · <b>${info.friends || 0}</b> 联系人 · <b>${info.files || 0}</b> 个文件`;
    } catch (e) { stat.textContent = `读取失败：${e.message}`; }

    $('pf-backup-export').onclick = async () => {
      const btn = $('pf-backup-export');
      btn.disabled = true; btn.textContent = '导出中…'; backupMsg('');
      try {
        const r = await rpc('backup-export');
        if (!r?.base64) throw new Error(r?.error || '导出失败');
        // 触发浏览器/网页下载
        const bin = atob(r.base64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const blob = new Blob([bytes], { type: 'application/zip' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        a.href = url; a.download = `arktalk-backup-${stamp}.zip`;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 5000);
        const extra = r.where ? `，也已保存到 ${r.where}` : (r.file ? `，也已保存到 ${r.file}` : '');
        backupMsg(`✅ 已导出 ${r.counts?.messages || 0} 条消息 / ${r.counts?.files || 0} 个文件${extra}`, 'ok');
      } catch (e) { backupMsg(`导出失败：${e.message}`, 'err'); }
      btn.disabled = false; btn.textContent = '导出备份';
    };

    const fileInput = $('pf-backup-file');
    $('pf-backup-import').onclick = () => fileInput.click();
    fileInput.onchange = async () => {
      const f = fileInput.files?.[0];
      if (!f) return;
      fileInput.value = '';
      const replace = !!$('pf-backup-replace')?.checked;
      backupMsg('正在导入…');
      try {
        const base64 = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onload = () => {
            const s = String(fr.result || '');
            resolve(s.slice(s.indexOf(',') + 1)); // 去掉 data: 前缀
          };
          fr.onerror = () => reject(new Error('读取文件失败'));
          fr.readAsDataURL(f);
        });
        const r = await rpc('backup-import', { base64, policy: replace ? 'replace-profile' : 'merge' });
        if (!r?.ok) throw new Error(r?.error || '导入失败');
        const im = r.imported || {};
        const warn = r.warn ? `\n⚠️ ${r.warn}` : '';
        backupMsg(`✅ 导入完成：${im.messages || 0} 条消息 / ${im.friends || 0} 联系人 / ${im.groups || 0} 群 / ${im.files || 0} 个文件（重复 ${r.skipped || 0} 条已跳过）${warn}\n请关闭并重新打开设置或刷新界面以查看新数据。`, 'ok');
        if (typeof loadHistory === 'function') { /* 历史在打开会话时按会话拉取 */ }
      } catch (e) { backupMsg(`导入失败：${e.message}`, 'err'); }
    };
  };
  initBackup();

  setTimeout(() => $('pf-nick').focus(), 0);
};

/* 联系人弹窗：发好友申请（只需对方账号）为主，手动加地址为高级选项 */
function openFriendsModal() {
  modalMode = 'friends';
  const incoming = (friendRequests ?? []).filter((r) => r.direction === 'in' && r.status === 'pending').length;
  openModal(`<div class="modal-title">添加联系人</div>
    <div class="form-row"><input id="af-uid" placeholder="对方账号（数字）" inputmode="numeric"></div>
    <div class="form-row"><input id="af-name" placeholder="你的昵称（对方看到的名字，可选）"></div>
    <div class="form-row"><input id="af-msg" placeholder="附言（可选，如：我是XX）"></div>
    <div class="pf-hint">填对方账号发申请，对方同意后即可聊天，无需交换 IP。需双方都开着 ArkTalk 且填了同一个跨网令牌。</div>
    <div class="form-err" id="af-err" hidden></div>
    <div class="modal-actions">
      <button class="ghost" id="af-reqs">好友申请${incoming ? `（${incoming} 条待处理）` : ''}</button>
      <button class="ghost" id="af-advanced">手动添加</button>
    </div>
    <div id="af-adv-box" hidden style="margin-top:10px">
      <div class="form-row ci-row">
        <input id="af-endpoint" placeholder="对方连接地址（可选，多个用逗号分隔）">
        <button class="mini" id="af-paste" title="从剪贴板粘贴连接信息">粘贴</button>
      </div>
      <div class="pf-hint">连接信息形如 772592327@192.168.1.5:3021 —— 手动直连时用，一般发申请即可。</div>
    </div>
    <div class="modal-actions">
      <button class="ghost" id="af-cancel">关闭</button>
      <button id="af-ok">发送申请</button>
    </div>`);
  $('af-cancel').onclick = closeModal;
  $('af-reqs').onclick = () => openFriendRequestsModal();
  $('af-advanced').onclick = () => { const b = $('af-adv-box'); b.hidden = !b.hidden; };
  $('af-paste').onclick = async () => {
    let text = '';
    try { text = await navigator.clipboard.readText(); } catch { /* WebView 可能禁读剪贴板 */ }
    if (!text) { $('af-uid').focus(); return; }
    applyConnInfo(text.trim());
  };
  $('af-ok').onclick = async () => {
    const err = $('af-err');
    err.hidden = true;
    const uid = $('af-uid').value.trim();
    const endpoint = $('af-endpoint')?.value.trim() ?? '';
    $('af-ok').disabled = true;
    try {
      // 填了连接地址走旧的手动添加（立即生效）；否则发好友申请
      if (endpoint) {
        const res = await rpc('add-friend', { userId: uid, remark: $('af-name').value.trim(), endpoint });
        closeModal();
        $('send-hint').textContent = res?.exists ? '对方已在联系人里' : '已添加';
      } else {
        const res = await rpc('send-friend-request', {
          userId: uid, name: $('af-name').value.trim(), message: $('af-msg').value.trim()
        });
        closeModal();
        $('send-hint').textContent = res?.duplicate ? '已发过申请，等对方同意' : (res?.queued ? '申请已发出（对方上线后收到）' : '申请已发出');
      }
      setTimeout(() => { $('send-hint').textContent = ''; }, 3500);
    } catch (e) { err.textContent = e.message; err.hidden = false; }
    $('af-ok').disabled = false;
  };
  setTimeout(() => $('af-uid').focus(), 0);
}

/** 好友申请列表弹窗：待处理的申请可同意/拒绝，发出的显示状态 */
function openFriendRequestsModal() {
  modalMode = 'friendreq';
  const list = friendRequests ?? [];
  const pending = list.filter((r) => r.direction === 'in' && r.status === 'pending');
  const others = list.filter((r) => !(r.direction === 'in' && r.status === 'pending'));
  const row = (r) => {
    const isIn = r.direction === 'in';
    const statusTxt = r.status === 'accepted' ? '已同意' : r.status === 'rejected' ? '已拒绝' : '等待对方同意';
    const when = r.time ? new Date(r.time * 1000).toLocaleString() : '';
    return `<div class="fr-item">
      <div class="fr-head"><b>${esc(r.name || ('账号 ' + r.from))}</b><span class="fr-meta">账号 ${esc(r.from)} · ${when}</span></div>
      ${r.message ? `<div class="fr-msg">${esc(r.message)}</div>` : ''}
      ${isIn && r.status === 'pending'
        ? `<div class="fr-actions"><button class="mini" data-fr-accept="${esc(r.id)}">同意</button><button class="mini ghost" data-fr-reject="${esc(r.id)}">拒绝</button></div>`
        : `<div class="fr-status">${isIn ? '' : '发出：'}${statusTxt}</div>`}
    </div>`;
  };
  openModal(`<div class="modal-title">好友申请</div>
    <div class="fr-list">${pending.length ? pending.map(row).join('') : '<div class="list-empty">没有待处理的申请</div>'}</div>
    ${others.length ? `<div class="fr-subtitle">历史</div><div class="fr-list">${others.slice(-10).map(row).join('')}</div>` : ''}
    <div class="modal-actions"><button class="ghost" id="fr-close">关闭</button></div>`);
  $('fr-close').onclick = () => { closeModal(); };
  document.querySelectorAll('[data-fr-accept]').forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try { await rpc('respond-friend-request', { id: b.getAttribute('data-fr-accept'), accept: true }); }
    catch (e) { alert(e.message); }
  });
  document.querySelectorAll('[data-fr-reject]').forEach((b) => b.onclick = async () => {
    b.disabled = true;
    try { await rpc('respond-friend-request', { id: b.getAttribute('data-fr-reject'), accept: false }); }
    catch (e) { alert(e.message); }
  });
}

/** 联系人 tab 上的待处理申请角标 */
function renderFriendRequestBadge() {
  const badge = $('fr-badge');
  if (!badge) return;
  const n = (friendRequests ?? []).filter((r) => r.direction === 'in' && r.status === 'pending').length;
  badge.hidden = n === 0;
  badge.textContent = n > 9 ? '9+' : String(n);
  const tab = $('rail-friends');
  if (tab) tab.title = n ? `联系人（${n} 条好友申请待处理）` : '联系人';
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

/* ---------- 图片：发（压缩/原图）与看（点击放大、保存） ---------- */
// 原图开关：勾选后跳过 canvas 压缩，按原文件字节发（>25MB 自动转压缩，防止撑爆 P2P 帧）
let sendOriginal = localStorage.getItem('ark.original') === '1';
function renderOriginalBtn() {
  const b = $('btn-original');
  if (b) { b.classList.toggle('active', sendOriginal); b.title = sendOriginal ? '原图模式已开启（点击关闭，恢复压缩）' : '发送原图（不压缩）'; }
}
renderOriginalBtn();
$('btn-original').onclick = () => {
  sendOriginal = !sendOriginal;
  localStorage.setItem('ark.original', sendOriginal ? '1' : '0');
  renderOriginalBtn();
};

/** 原样读取文件为 dataURL（不重编码，保真）。 */
function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('图片读取失败'));
    r.readAsDataURL(file);
  });
}

$('btn-image').onclick = () => {
  // 安卓端走原生选择（压缩/原图都在桥里完成，页面不参与）
  if (window.arkNative && activeChat) {
    rpc('pick-file', { kind: 'image', userId: Number(activeChat.id), original: sendOriginal })
      .then(() => { $('send-hint').textContent = '请在系统选择器中选择图片…'; setTimeout(() => { $('send-hint').textContent = ''; }, 8000); })
      .catch((e) => { $('send-hint').textContent = `图片发送失败：${e.message}`; setTimeout(() => { $('send-hint').textContent = ''; }, 4000); });
    return;
  }
  $('image-input').click();
};
/** 把一个本地图片 File 作为「图片消息」发送（🖼️ 选择 / 拖入都走这里）。 */
async function sendLocalImage(file) {
  if (!file || !activeChat) return false;
  try {
    let dataUrl, isOriginal = false;
    if (sendOriginal && file.size <= 25 * 1024 * 1024) {
      dataUrl = await readFileAsDataURL(file);
      isOriginal = true;
    } else {
      if (sendOriginal && file.size > 25 * 1024 * 1024) {
        $('send-hint').textContent = '原图超过 25MB，已自动转为压缩发送';
        setTimeout(() => { $('send-hint').textContent = ''; }, 3000);
      }
      dataUrl = await compressImage(file, 1280);
    }
    await sendSeg({ type: 'image', data: { url: dataUrl, ...(isOriginal ? { original: true } : {}) } }, '图片发送中…');
    return true;
  } catch (e) {
    $('send-hint').textContent = `图片发送失败：${e.message}`;
    setTimeout(() => { $('send-hint').textContent = ''; }, 4000);
    return false;
  }
}
$('image-input').addEventListener('change', async () => {
  const file = $('image-input').files[0];
  $('image-input').value = '';
  await sendLocalImage(file);
});

/* ---------- 图片灯箱：点聊天里的图片放大看 + 一键保存 ---------- */
let lightboxUrl = '';
let lightboxName = '图片.png';
let lightboxSavedPath = '';
function openLightbox(src, name = '图片.png') {
  lightboxUrl = src;
  lightboxName = String(name || '图片.png').replace(/[\\/:*?"<>|]/g, '_');
  lightboxSavedPath = '';
  $('lightbox-img').src = src;
  $('lightbox-save').textContent = '保存图片';
  $('lightbox-open').hidden = true;
  $('lightbox').hidden = false;
}
function closeLightbox() {
  $('lightbox').hidden = true;
  $('lightbox-img').src = '';
  lightboxUrl = '';
}
// 事件委托：聊天区里的图片点击即放大（含历史消息重渲染后的新节点）
$('messages').addEventListener('click', (e) => {
  const img = e.target.closest('.image-seg');
  if (img?.src) openLightbox(img.src);
});
$('lightbox-close').onclick = closeLightbox;
$('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) closeLightbox(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('lightbox').hidden) closeLightbox(); });
$('lightbox-save').onclick = async () => {
  if (!lightboxUrl) return;
  try {
    const res = await rpc('save-image', { dataUrl: lightboxUrl, name: lightboxName });
    $('lightbox-save').textContent = res?.where ? `已保存：${res.where}` : '已保存';
    if (res?.path) lightboxSavedPath = res.path;
    // 电脑端有精确路径可定位；安卓端 open-location 直接开"下载"应用，无需路径
    $('lightbox-open').hidden = !(lightboxSavedPath || window.arkNative);
  } catch (e) {
    alert(`保存失败：${e.message}`);
  }
};
$('lightbox-open').onclick = async () => {
  if (!lightboxSavedPath && !window.arkNative) return;
  try { await rpc('open-location', { path: lightboxSavedPath }); }
  catch (e) { alert(`打开位置失败：${e.message}`); }
};

/* ---------- 语音：点 🎤 开始录音，再点一次发送，Esc 取消，最长 60 秒 ---------- */
let recState = null;
const MAX_REC_MS = 60000;

async function startRecording() {
  // 部分 WebView/设备：带处理链的 audio 请求会报 NotReadableError，关掉全部处理再试一次
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    if (e.name === 'NotReadableError' || e.name === 'OverconstrainedError') {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 }
      });
    } else { throw e; }
  }
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
    // 常见失败按名字归类，给出可执行的指引而不是干巴巴的报错
    const hint = e.name === 'NotAllowedError'
      ? '无法录音：麦克风权限被拒绝。请到 系统设置 → 应用 → ArkTalk → 权限，开启麦克风后再试'
      : e.name === 'NotFoundError'
        ? '无法录音：设备上没有找到可用的麦克风'
        : e.name === 'NotReadableError'
          ? '无法录音：麦克风被其他应用占用，关闭占用后重试'
          : `无法录音：${e.name || ''} ${e.message}`;
    $('send-hint').textContent = hint;
    setTimeout(() => { $('send-hint').textContent = ''; }, 6000);
  });
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && recState) { e.preventDefault(); stopRecording(true); }
});

/* ---------- 桌面端：拖出复制 + 拖入发送（带二次确认） ---------- */
// 拖出：图片/已下载文件 → 系统原生文件（可拖进桌面、资源管理器、其它程序）
document.addEventListener('dragstart', (e) => {
  const desk = window.arkDesktop;
  if (!desk?.isElectron) return;
  const img = e.target.closest?.('.image-seg');
  const card = e.target.closest?.('.file-card');
  let payload = null;
  if (img?.src) {
    payload = { dataUrl: img.src, name: img.dataset.dname || '' };
  } else if (card?.dataset.dpath) {
    payload = { filePath: card.dataset.dpath };
  }
  if (!payload) return;
  const res = desk.dragOut(payload);
  if (res?.ok === false) {
    e.preventDefault();
    $('send-hint').textContent = `拖拽失败：${res.error}`;
    setTimeout(() => { $('send-hint').textContent = ''; }, 4000);
  }
});
// 拖入：只接受文件；松手弹二次确认框，确认后才发送
let dragDepth = 0;
const hasFiles = (e) => !!e.dataTransfer?.types && Array.from(e.dataTransfer.types).includes('Files');
document.addEventListener('dragenter', (e) => {
  if (!hasFiles(e) || window.arkNative) return;
  e.preventDefault();
  dragDepth++;
  $('drop-overlay').hidden = false;
});
document.addEventListener('dragover', (e) => {
  if (!hasFiles(e) || window.arkNative) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('drop-overlay').hidden = true;
});
document.addEventListener('drop', async (e) => {
  if (!hasFiles(e) || window.arkNative) return;
  e.preventDefault();
  dragDepth = 0;
  $('drop-overlay').hidden = true;
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (!files.length) return;
  if (!activeChat) { $('send-hint').textContent = '请先选择一个会话再拖入文件'; setTimeout(() => { $('send-hint').textContent = ''; }, 3000); return; }
  if (activeChat.type !== 'private') { $('send-hint').textContent = '文件/图片拖拽发送暂只支持私聊'; setTimeout(() => { $('send-hint').textContent = ''; }, 3000); return; }
  pendingDropFiles = files;
  $('dc-target').textContent = `发送给：${activeChat.name ?? `账号 ${activeChat.id}`}`;
  const list = $('dc-list');
  list.innerHTML = '';
  for (const f of files) {
    const row = document.createElement('div');
    row.className = 'dc-row';
    row.innerHTML = `<span class="dc-fname"></span><span class="dc-fsize">${fmtSize(f.size)}</span>`;
    row.querySelector('.dc-fname').textContent = (f.type.startsWith('image/') ? '🖼️ ' : '📎 ') + f.name;
    list.appendChild(row);
  }
  $('drop-confirm').hidden = false;
});
let pendingDropFiles = [];
function closeDropConfirm() { $('drop-confirm').hidden = true; pendingDropFiles = []; $('dc-asfile').checked = false; }
$('dc-cancel').onclick = closeDropConfirm;
$('drop-confirm').addEventListener('click', (e) => { if (e.target === $('drop-confirm')) closeDropConfirm(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('drop-confirm').hidden) closeDropConfirm(); });
$('dc-ok').onclick = async () => {
  const files = pendingDropFiles.slice();
  const asFile = $('dc-asfile').checked;
  closeDropConfirm();
  let ok = 0;
  for (const f of files) {
    const sent = !asFile && f.type.startsWith('image/') ? await sendLocalImage(f) : await sendLocalFile(f);
    if (sent) ok++;
  }
  if (ok) { $('send-hint').textContent = `已发送 ${ok} 个文件`; setTimeout(() => { $('send-hint').textContent = ''; }, 2500); }
};

// 安卓原生壳用：点通知后直接进入对应会话
window.arkOpenChat = (id) => {
  const key = 'p' + String(id);
  try { openChat(key); } catch { /* 联系人还没加载完就忽略 */ }
};

// 托盘「检查更新」→ 打开我的账号弹窗（更新区在里面）
window.arkDesktop?.onOpenUpdate?.(() => { try { openProfileModal(); } catch { /* ignore */ } });

boot();

// 消息工具：chatKey 推导与列表预览文本。桥与测试共用。

/** 从一条消息事件/记录推导 chatKey：私聊 p<uin>，群聊 g<群号>。 */
export function chatKeyOf(m) {
  if (!m) return null;
  if (m.message_type === 'group' || (m.group_id !== undefined && m.message_type !== 'private')) {
    if (m.group_id !== undefined && m.group_id !== null) return `g${m.group_id}`;
  }
  if (m.message_type === 'private' || m.user_id !== undefined) {
    const uin = m.user_id ?? m.sender?.user_id;
    if (uin !== undefined && uin !== null) return `p${uin}`;
  }
  return null;
}

/** 生成会话列表的预览文本（只取文本段，图片/语音等给占位符）。 */
export function previewOf(record) {
  if (!record) return '';
  const segs = Array.isArray(record.message) ? record.message : [];
  const parts = [];
  for (const seg of segs) {
    if (seg.type === 'text') parts.push(seg.data?.text ?? '');
    else if (seg.type === 'image') parts.push('[图片]');
    else if (seg.type === 'face') parts.push('[表情]');
    else if (seg.type === 'record') parts.push('[语音]');
    else if (seg.type === 'video') parts.push('[视频]');
    else if (seg.type === 'file') parts.push('[文件]');
    else if (seg.type === 'at') parts.push(`@${seg.data?.qq ?? ''}`);
    else if (seg.type === 'reply') parts.push('[回复]');
    else if (seg.type === 'json' || seg.type === 'ark') parts.push('[卡片]');
    else parts.push(`[${seg.type}]`);
  }
  return parts.join('').slice(0, 60);
}

// 上游连接自发现：SnowLuma 的 token 按账号分文件（<homeDir>/config/onebot_<QQ号>.json），
// HTTP 与 WS 是两个不同的 token、两个不同端口。换账号后旧 token 直接 401，
// 所以「不猜，真去问一次 get_login_info，谁通就用谁」——与 qq-bridge 的 snowluma-conn.js 同一套思路。
//
// 候选顺序：
//   1) 显式配置的 token（尊重用户选择）
//   2) SnowLuma 主目录下所有 onebot_*.json 的 HTTP token（真实来源）
import fs from 'node:fs';
import path from 'node:path';

/** 读取 SnowLuma 主目录下所有账号配置：[{uin, file, http:{token,host,port}, ws:{token,host,port}}] */
export function readOneBotAccounts(homeDir) {
  if (!homeDir) return [];
  const dir = path.join(homeDir, 'config');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isFile()) continue;
    const m = /^onebot_(\d+)\.json$/i.exec(e.name);
    if (!m) continue;
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, e.name), 'utf8').replace(/^\uFEFF/, ''));
      const nets = j?.networks ?? {};
      const http = Array.isArray(nets.httpServers) ? nets.httpServers[0] : null;
      const ws = Array.isArray(nets.wsServers) ? nets.wsServers[0] : null;
      out.push({
        uin: m[1], file: path.join(dir, e.name),
        http: http ? { token: String(http.accessToken ?? ''), host: http.host || '127.0.0.1', port: Number(http.port) || 3000 } : null,
        ws: ws ? { token: String(ws.accessToken ?? ''), host: ws.host || '127.0.0.1', port: Number(ws.port) || 3001 } : null
      });
    } catch { /* 单个文件坏了不影响其它 */ }
  }
  return out.sort((a, b) => a.uin.localeCompare(b.uin));
}

/** 试一次 get_login_info；返回 data 或 null。 */
async function probe(baseUrl, token, timeoutMs) {
  try {
    const res = await fetch(`${baseUrl}/get_login_info`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!res.ok) return null;
    const body = await res.json().catch(() => ({}));
    if (body.status === 'ok' && Number(body.retcode) === 0) return body.data;
    return null;
  } catch { return null; }
}

/**
 * 找出一条真实可用的上游连接。
 * @returns {Promise<{ok:boolean, wsUrl?:string, accessToken?:string, httpUrl?:string, self?:object, source?:string, error?:string}>}
 */
export async function discoverUpstream({ homeDir, httpUrl, wsUrl, accessToken, timeoutMs = 4000, log = () => {} } = {}) {
  const tried = [];
  const candidates = [];
  if (accessToken) candidates.push({ token: accessToken, ws: { token: accessToken, host: hostOf(wsUrl), port: portOf(wsUrl) }, source: '显式配置' });
  for (const a of readOneBotAccounts(homeDir)) {
    if (a.http) candidates.push({ token: a.http.token, ws: a.ws, http: a.http, source: `onebot_${a.uin}.json` });
  }
  if (candidates.length === 0) {
    candidates.push({ token: '', ws: { token: '', host: hostOf(wsUrl), port: portOf(wsUrl) }, source: '无 token 兜底' });
  }

  for (const c of candidates) {
    const base = c.http ? `http://${c.http.host}:${c.http.port}` : (httpUrl ?? 'http://127.0.0.1:3000');
    const self = await probe(base, c.token, timeoutMs);
    tried.push(`${c.source}@${base} → ${self ? '通' : '不通'}`);
    if (self) {
      const w = c.ws ?? {};
      const wsUrl2 = wsUrl && c.source === '显式配置' ? wsUrl : `ws://${w.host ?? '127.0.0.1'}:${w.port ?? 3001}`;
      log(`上游自发现成功（${c.source}）：账号 ${self.user_id} ${self.nickname}，WS=${wsUrl2}`);
      return { ok: true, wsUrl: wsUrl2, accessToken: w.token ?? c.token, httpUrl: base, self, source: c.source };
    }
  }
  return { ok: false, error: `所有候选 token 都不可用（${tried.join('；')}）。请确认 SnowLuma 已登录且 OneBot 服务已开启。` };
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return '127.0.0.1'; }
}
function portOf(url) {
  try { return Number(new URL(url).port) || (new URL(url).protocol === 'https:' ? 443 : 80); } catch { return 3001; }
}

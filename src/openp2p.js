// OpenP2P 跨网穿透管理（可选功能，填了令牌才启用）。
//
// 原理（与 OpenP2P 官方远程联机同款）：
//   · 本机跑一个 openp2p 节点：arktalk-<我的账号>（token 相同的设备组成私有网络）
//   · 为每个联系人建一条 P2PApp 隧道：本机 127.0.0.1:131xx → 对方节点 arktalk-<账号> 的 3021
//   · ArkTalk 拨号时把 127.0.0.1:131xx 也作为对方地址之一——局域网不通就走隧道
//   · OpenP2P 先尝试 P2P 打洞（UDP/TCP、NAT1-4、IPv6），打不通自动用公共共享节点中继
//
// 令牌：到 console.openp2p.cn 注册后复制，两台设备填同一个即可互通。
import { spawn, exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const RELAY_BASE = 13100; // 本地隧道端口从 13100 起按联系人顺序分配

export class OpenP2PManager {
  /**
   * @param {object} opts
   * @param {string} opts.exePath openp2p 可执行文件路径
   * @param {string} opts.workDir 工作目录（config.json 写在这里）
   * @param {function} [opts.log]
   */
  constructor({ exePath, workDir, log = () => {} }) {
    this.exePath = exePath;
    this.workDir = workDir;
    this.log = log;
    this.proc = null;
    this.relayMap = {}; // friendId -> '127.0.0.1:port'
    this._stoppedByUs = false;
    this.lines = [];      // 最近若干行输出（诊断用）
    this.status = '未启用'; // 给人看的一句话状态
    this.node = '';
  }

  /** 诊断视图：进程是否在跑、节点名、最近输出。 */
  info() {
    return {
      running: !!this.proc,
      node: this.node,
      status: this.proc ? (this.status || '运行中') : this.status,
      log: this.lines.slice(-14)
    };
  }

  _note(s) {
    this.status = s;
    this.log(`OpenP2P：${s}`, 'warn');
  }

  /** 为空/无 exe/无联系人时直接返回空映射。 */
  start(token, selfId, friendIds) {
    this._stoppedByUs = false;
    this.stop();
    this.relayMap = {};
    const ids = [...new Set(friendIds.map(String))].filter(Boolean);
    this.node = `arktalk-${selfId}`;
    if (!token || !ids.length) {
      this.status = !token ? '未设置令牌' : '没有联系人（无需隧道）';
      return this.relayMap;
    }
    if (!fs.existsSync(this.exePath)) {
      this._note(`找不到穿透程序 ${this.exePath}`);
      return this.relayMap;
    }
    fs.mkdirSync(this.workDir, { recursive: true });
    // OpenP2P v3 的 Token 是 uint64 数值类型（json 严格解析，字符串会导致整个 config.json 加载失败）。
    // 令牌超出 JS 安全整数，不能用 Number——用占位符把数字原样写进 JSON。
    const tokenStr = String(token).trim();
    if (!/^\d{1,20}$/.test(tokenStr)) {
      this._note('令牌无效——必须是 console.openp2p.cn 个人资料里那串数字');
      return this.relayMap;
    }
    const apps = ids.map((id, i) => ({
      AppName: `arktalk-f${id}`,
      Protocol: 'tcp',
      SrcPort: RELAY_BASE + i,
      PeerNode: `arktalk-${id}`,
      DstPort: 3021,
      DstHost: 'localhost',
      Enabled: 1 // 不写默认是 0（禁用）！Go 零值
    }));
    ids.forEach((id, i) => { this.relayMap[id] = `127.0.0.1:${RELAY_BASE + i}`; });
    const cfg = {
      network: {
        Node: `arktalk-${selfId}`,
        Token: '__TOKEN__', // 写盘前替换为纯数字（uint64 超出 JS 安全整数）
        ShareBandwidth: 10, // 默认贡献 10mbps 给共享网络（换来别人节点中继的资格）
        ServerHost: 'api.openp2p.cn',
        ServerPort: 27183
      },
      apps
    };
    // OpenP2P v3 启动时 os.Chdir(exe 所在目录)——config.json 必须放在 exe 旁边，CWD 无效
    const cfgPath = path.join(path.dirname(path.resolve(this.exePath)), 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2).replace('"__TOKEN__"', tokenStr));
    this.log(`OpenP2P：启动穿透（节点 arktalk-${selfId}，${apps.length} 条隧道）`, 'info');
    try {
      this._ensureInvokerLayer();
      // CLI 参数再兜底一遍（配置文件万一被别的实例改写也不失联）
      this.proc = spawn(this.exePath, ['-node', `arktalk-${selfId}`, '-token', tokenStr],
        { cwd: this.workDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      this.proc.stdout?.on('data', (d) => this._pump(d, 'info'));
      this.proc.stderr?.on('data', (d) => this._pump(d, 'warn'));
      this.status = '穿透进程启动中（等待登录）';
      // error 事件必须接住：spawn 失败（权限/文件缺失等）不能把整个桥进程崩掉
      this.proc.on('error', (e) => {
        this.proc = null;
        this._note(`启动失败：${e.message}（Windows 下通常因官方程序要求管理员权限，已自动注册免提权标记，重启应用即可）`);
      });
      this.proc.on('exit', (code) => {
        const wasOurs = this._stoppedByUs;
        this.proc = null;
        if (!wasOurs) this._note(`进程退出（code=${code}）`);
      });
    } catch (e) {
      this.log(`OpenP2P 启动失败：${e.message}`, 'warn');
    }
    return this.relayMap;
  }

  /**
   * Windows：官方 openp2p.exe 内嵌 requireAdministrator 清单，普通权限 spawn 会 EACCES。
   * 用微软官方兼容性标记 RUNASINVOKER 强制以当前权限运行（HKCU，只影响本用户，幂等）。
   */
  _ensureInvokerLayer() {
    if (process.platform !== 'win32') return;
    const key = 'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers';
    const exe = path.resolve(this.exePath);
    try {
      exec(`reg add "${key}" /v "${exe}" /t REG_SZ /d "~ RUNASINVOKER" /f`, { windowsHide: true }, () => {});
    } catch { /* 失败不影响启动（比如已手动设过） */ }
  }

  stop() {
    this._stoppedByUs = true;
    if (this.proc) { try { this.proc.kill(); } catch { /* ignore */ } this.proc = null; }
    this.status = '未运行';
  }

  _pump(buf, level) {
    for (const line of String(buf).split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      this.lines.push(t.slice(0, 200));
      if (this.lines.length > 60) this.lines.splice(0, this.lines.length - 60);
      // 从输出里提炼一句话状态（登录成功 / 对端在线状态）
      if (/login ok/i.test(t)) {
        const m = t.match(/user=([^,\s]+)[,\s]+node=([^\s,]+)/i);
        this.status = `已登录${m ? `（${m[1]}）` : ''}，节点 ${this.node}`;
      } else if (/peer online|peerOnline/i.test(t)) {
        this.status = '对端节点已上线，隧道已接通';
      } else if (/peer offline/i.test(t) && this.status.includes('已登录')) {
        this.status = '已登录，但对端节点离线（对方穿透未运行）';
      } else if (/login fail|token.*(invalid|error)|userNotFound/i.test(t)) {
        this._note(`登录失败：${t.slice(0, 120)}`);
      }
      this.log(`OpenP2P｜${t.slice(0, 200)}`, level);
    }
  }
}

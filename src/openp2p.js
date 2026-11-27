// OpenP2P 跨网穿透管理（可选功能，填了令牌才启用）。
//
// 原理（与 OpenP2P 官方远程联机同款）：
//   · 本机跑一个 openp2p 节点：arktalk-<我的账号>（token 相同的设备组成私有网络）
//   · 为每个联系人建一条 P2PApp 隧道：本机 127.0.0.1:131xx → 对方节点 arktalk-<账号> 的 3021
//   · ArkTalk 拨号时把 127.0.0.1:131xx 也作为对方地址之一——局域网不通就走隧道
//   · OpenP2P 先尝试 P2P 打洞（UDP/TCP、NAT1-4、IPv6），打不通自动用公共共享节点中继
//
// 令牌：到 console.openp2p.cn 注册后复制，两台设备填同一个即可互通。
import { spawn } from 'node:child_process';
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
  }

  /** 为空/无 exe/无联系人时直接返回空映射。 */
  start(token, selfId, friendIds) {
    this.stop();
    this.relayMap = {};
    const ids = [...new Set(friendIds.map(String))].filter(Boolean);
    if (!token || !ids.length) return this.relayMap;
    if (!fs.existsSync(this.exePath)) {
      this.log(`OpenP2P：找不到 ${this.exePath}，穿透未启用`, 'warn');
      return this.relayMap;
    }
    fs.mkdirSync(this.workDir, { recursive: true });
    const apps = ids.map((id, i) => ({
      AppName: `arktalk-f${id}`,
      Protocol: 'tcp',
      SrcPort: RELAY_BASE + i,
      PeerNode: `arktalk-${id}`,
      DstPort: 3021,
      DstHost: 'localhost'
    }));
    ids.forEach((id, i) => { this.relayMap[id] = `127.0.0.1:${RELAY_BASE + i}`; });
    const cfg = {
      network: {
        Node: `arktalk-${selfId}`,
        Token: String(token),
        ShareBandwidth: 10, // 默认贡献 10mbps 给共享网络（换来别人节点中继的资格）
        ServerHost: 'api.openp2p.cn',
        ServerPort: 27183
      },
      apps
    };
    fs.writeFileSync(path.join(this.workDir, 'config.json'), JSON.stringify(cfg, null, 2));
    this.log(`OpenP2P：启动穿透（节点 arktalk-${selfId}，${apps.length} 条隧道）`, 'info');
    try {
      this.proc = spawn(this.exePath, [], { cwd: this.workDir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      this.proc.stdout?.on('data', (d) => this._pump(d, 'info'));
      this.proc.stderr?.on('data', (d) => this._pump(d, 'warn'));
      this.proc.on('exit', (code) => {
        this.proc = null;
        if (!this._stoppedByUs) this.log(`OpenP2P 进程退出（code=${code}）`, 'warn');
      });
    } catch (e) {
      this.log(`OpenP2P 启动失败：${e.message}`, 'warn');
    }
    return this.relayMap;
  }

  stop() {
    this._stoppedByUs = true;
    if (this.proc) { try { this.proc.kill(); } catch { /* ignore */ } this.proc = null; }
    this._stoppedByUs = false;
  }

  _pump(buf, level) {
    for (const line of String(buf).split(/\r?\n/)) {
      const t = line.trim();
      if (t) this.log(`OpenP2P｜${t.slice(0, 200)}`, level);
    }
  }
}

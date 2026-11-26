// 一次性工具：从 assets/icon-original.jpg 生成多尺寸 PNG，并打包成 Windows .ico
// 运行：node_modules/.bin/electron scripts/gen-icon.cjs
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

app.whenReady().then(() => {
  try {
    const root = path.join(__dirname, '..');
    const src = path.join(root, 'assets', 'icon-original.jpg');
    const img = nativeImage.createFromPath(src);
    if (img.isEmpty()) throw new Error('源图读取失败：' + src);
    const sizes = [256, 128, 64, 48, 32, 16];
    const pngs = {};
    for (const s of sizes) {
      const buf = img.resize({ width: s, height: s, quality: 'best' }).toPNG();
      pngs[s] = buf;
      fs.writeFileSync(path.join(root, 'assets', `icon_${s}.png`), buf);
    }
    fs.copyFileSync(path.join(root, 'assets', 'icon_256.png'), path.join(root, 'public', 'icon.png'));

    // ICO（Vista+ 支持内嵌 PNG）：ICONDIR(6) + ICONDIRENTRY(16)×N + PNG 数据
    // ICONDIRENTRY：bWidth@0 bHeight@1 bColorCount@2 bReserved@3 wPlanes@4 wBitCount@6 dwBytesInRes@8 dwImageOffset@12
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);            // 保留
    header.writeUInt16LE(1, 2);            // 类型：图标
    header.writeUInt16LE(sizes.length, 4); // 数量
    let offset = 6 + 16 * sizes.length;
    const entries = sizes.map((s) => {
      const e = Buffer.alloc(16);
      e.writeUInt8(s >= 256 ? 0 : s, 0); // 宽（0 = 256）
      e.writeUInt8(s >= 256 ? 0 : s, 1); // 高
      e.writeUInt8(0, 2);
      e.writeUInt8(0, 3);
      e.writeUInt16LE(1, 4);             // planes
      e.writeUInt16LE(32, 6);            // bitCount
      e.writeUInt32LE(pngs[s].length, 8); // 数据长度
      e.writeUInt32LE(offset, 12);       // 数据偏移
      offset += pngs[s].length;
      return e;
    });
    const ico = Buffer.concat([header, ...entries, ...sizes.map((s) => pngs[s])]);
    fs.writeFileSync(path.join(root, 'assets', 'icon.ico'), ico);
    console.log(`[gen-icon] OK: assets/icon.ico (${ico.length} B) + ${sizes.join('/')} PNG + public/icon.png`);
    app.quit();
  } catch (e) {
    console.error('[gen-icon] 失败：', e.message);
    app.exit(1);
  }
});

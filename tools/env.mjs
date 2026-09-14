// 部署 / 线上测试所需的环境变量检查：缺失时给出清晰提示，而不是抛一个看不懂的错。
//
//   GS_HOST    服务器地址（IP 或域名）
//   GS_PORT    SSH 端口，默认 22
//   GS_USER    SSH 用户名，默认 root
//   GS_PASS    SSH 密码
//   GS_DOMAIN  对外访问的游戏域名（用于 HTTPS / wss 测试）
//
export function needEnv(keys) {
  const missing = keys.filter((k) => !process.env[k]);
  if (!missing.length) return;
  console.error('缺少环境变量：' + missing.join('、'));
  console.error('');
  console.error('示例（Windows PowerShell）：');
  console.error('  $env:GS_HOST="1.2.3.4"; $env:GS_USER="root"; $env:GS_PASS="你的密码"');
  console.error('  $env:GS_DOMAIN="game.example.com"');
  console.error('  node tools/test-final.mjs');
  console.error('');
  console.error('示例（Linux / macOS）：');
  console.error('  GS_HOST=1.2.3.4 GS_USER=root GS_PASS=你的密码 node tools/test-final.mjs');
  process.exit(2);
}

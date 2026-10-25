// Fixed, actionable UI messages. Never forward raw exceptions or response bodies.
const descriptions = {
  AUTH_REQUIRED: ['网络学堂登录已失效，请点击底部“浏览器登录”重新认证，或手动更新 Cookie。', '在独立浏览器中手动登录，程序会自动同步本站 Cookie；也可使用“更新 Cookie”。'],
  CSRF_INVALID: ['登录校验已失效，请更新同一会话的 Cookie 后重试。', '点击“更新 Cookie”保存新会话，程序会自动重新读取 CSRF。'],
  NETWORK_ERROR: ['无法连接网络学堂或请求超时，请检查网络后点击“立即刷新”。', '确认浏览器可以访问网络学堂；网络恢复后可手动刷新。'],
  CONFIG_ERROR: ['本地配置无法读取或字段无效，请检查 config/local.json。', '保留原有配置，对照 config/example.json 检查 JSON、Cookie 格式及协议文件路径。'],
  RATE_LIMITED: ['网络学堂暂时限制请求，请稍后再刷新。', '保持程序单实例运行，稍后重试。'],
  UPSTREAM_ERROR: ['网络学堂服务暂不可用，请稍后再刷新。', '查看浏览器能否正常访问课程页面，站点恢复后重试。'],
  PROTOCOL_CHANGED: ['网络学堂返回的页面或数据格式不符合预期。', '先确认登录有效；仍失败时检查接口及页面适配。'],
  INTERNAL_ERROR: ['读取程序遇到未预期错误，请重新启动程序。', '检查本地依赖和编译结果，运行 npm run check。'],
};

export function refreshErrorEvent(error) {
  if (error?.code === 'ERR_MODULE_NOT_FOUND') {
    return { event: 'error', code: 'CONFIG_ERROR', message: '后台依赖或编译文件缺失，请在原项目执行 npm ci 和 npm run build。', remediation: '完成构建后重新启动桌面程序。' };
  }
  const code = Object.hasOwn(descriptions, error?.code) ? error.code : 'INTERNAL_ERROR';
  const [message, remediation] = descriptions[code];
  return { event: 'error', code, message, remediation };
}

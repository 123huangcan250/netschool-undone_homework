export type ErrorCode =
  | 'CONFIG_ERROR' | 'AUTH_REQUIRED' | 'CSRF_INVALID' | 'NETWORK_ERROR'
  | 'RATE_LIMITED' | 'UPSTREAM_ERROR' | 'PROTOCOL_CHANGED' | 'NOT_FOUND'
  | 'INVALID_INPUT' | 'DEADLINE_PASSED' | 'DEADLINE_UNKNOWN'
  | 'FILE_NOT_ALLOWED' | 'SUBMISSION_REJECTED' | 'SUBMISSION_UNCERTAIN'
  | 'SUBMISSION_BUSY' | 'STATE_ERROR' | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly remediation = '',
  ) { super(message); this.name = 'AppError'; }
}

export function asAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  return new AppError('INTERNAL_ERROR', '处理失败。未向客户端回传底层异常，以免暴露会话信息。', false, '检查配置后重试；使用 npm test 检查本地环境。');
}

export const protocolError = (message: string) => new AppError(
  'PROTOCOL_CHANGED', message, false, '使用浏览器 Network 核对接口响应，并更新本地 protocol.json；不要重复提交。',
);

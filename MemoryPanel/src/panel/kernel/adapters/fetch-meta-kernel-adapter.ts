import type { MetaKernelPort } from '../ports/meta-kernel-port.js';
import type { MetaEnvelope } from '../envelope.js';
import type { MetaCallContext } from '../types.js';
import { CoreUpstreamError } from '../../domain/errors.js';

/**
 * 基于 fetch 的 meta 数据面适配器：POST /v3/meta/{action}。
 *
 * 用于 team/user/agent/task 元数据管理，直连 MemoryProxy。
 * baseUrl 由环境变量 META_PROXY_URL 配置。
 */
export class FetchMetaKernelAdapter implements MetaKernelPort {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async invoke(action: string, body: Record<string, unknown>, ctx: MetaCallContext): Promise<MetaEnvelope<unknown>> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (ctx.instanceId) headers['x-tdai-service-id'] = ctx.instanceId;
      if (ctx.userKey) headers['x-tdai-user-key'] = ctx.userKey;
      if (ctx.reqId) headers['x-request-id'] = ctx.reqId;

      // 使用 ctx.gatewayEndpoint（来自 metadata-instances.json），而非固定的 baseUrl
      const endpoint = ctx.gatewayEndpoint || this.baseUrl;
      const resp = await fetch(`${endpoint.replace(/\/+$/, '')}/v3/meta/${action}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      let json: MetaEnvelope<unknown>;
      try {
        json = (await resp.json()) as MetaEnvelope<unknown>;
      } catch {
        throw new CoreUpstreamError('CORE_UPSTREAM_ERROR', resp.status, `HTTP ${resp.status} (invalid JSON)`, 0);
      }

      if (resp.status >= 400 && resp.status < 600) {
        throw new CoreUpstreamError(
          'CORE_UPSTREAM_ERROR',
          resp.status,
          json.message || `HTTP ${resp.status}`,
          json.code,
        );
      }

      return json;
    } finally {
      clearTimeout(timer);
    }
  }
}

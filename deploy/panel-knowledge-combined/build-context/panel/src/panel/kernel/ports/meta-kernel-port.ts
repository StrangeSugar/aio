import type { MetaEnvelope } from '../envelope.js';
import type { MetaCallContext } from '../types.js';

/**
 * 内核 /v3/meta/* 数据面透明代理端口。
 * 用于 team/user/agent/task 元数据管理（走 MemoryProxy）。
 */
export interface MetaKernelPort {
  invoke(action: string, body: Record<string, unknown>, ctx: MetaCallContext): Promise<MetaEnvelope<unknown>>;
}

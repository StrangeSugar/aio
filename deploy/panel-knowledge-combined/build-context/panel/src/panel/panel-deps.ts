import type { InstanceEntry } from './config/instance-registry.js';
import type { PanelConfig } from './config/panel-config.js';
import { InstanceRegistry } from './config/instance-registry.js';
import { ConsoleLogger } from './infra/console-logger.js';
import type { Logger } from './infra/logger.js';
import type { KnowledgeClientPort } from './kernel/ports/knowledge-client-port.js';
import type { MetaKernelPort } from './kernel/ports/meta-kernel-port.js';
import { HttpKnowledgeClient } from './kernel/adapters/http-knowledge-client.js';
import { FetchMetaKernelAdapter } from './kernel/adapters/fetch-meta-kernel-adapter.js';
import { IngestProgressStore } from './state/ingest-progress-store.js';

export interface PanelDeps {
  config: PanelConfig;
  logger: Logger;
  instanceRegistry: InstanceRegistry;
  /** 按请求 instanceId 构造 KS 客户端（x-tdai-service-id = instanceId）。 */
  knowledgeClientFactory: (instanceId: string) => KnowledgeClientPort;
  /** MemoryProxy meta 数据面适配器（team/user/agent 元数据管理）。 */
  metaKernel: MetaKernelPort;
  /** Wiki ingest 细粒度进度（KS ingest_progress 回调写入；wiki/get 聚合读出）。 */
  ingestProgressStore: IngestProgressStore;
}

export function buildPanelDeps(config: PanelConfig): PanelDeps {
  const logger = new ConsoleLogger({
    level: config.log.level,
    format: config.log.format,
  });
  const instanceRegistry = InstanceRegistry.load(config.metadataInstancesConfig);
  const knowledgeClientFactory = (instanceId: string): KnowledgeClientPort =>
    new HttpKnowledgeClient({
      baseUrl: config.knowledge.baseUrl,
      authToken: config.knowledge.authToken,
      serviceId: instanceId,
      timeoutMs: config.knowledge.timeoutMs,
    });
  const metaKernel = new FetchMetaKernelAdapter(config.metaProxyUrl, config.metadataRemoteTimeoutMs);
  const ingestProgressStore = new IngestProgressStore();
  return {
    config,
    logger,
    instanceRegistry,
    knowledgeClientFactory,
    metaKernel,
    ingestProgressStore,
  };
}

export type { InstanceEntry };

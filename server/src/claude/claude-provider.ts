import type { AgentProvider, AgentStatus } from '../providers.js';
import { PROVIDER_DEFINITIONS, type AgentProviderId } from '../provider-registry.js';
import { claudeCliStatus } from './claude-auth.js';

export class ClaudeProvider implements AgentProvider {
  id: AgentProviderId = 'claude';
  displayName = PROVIDER_DEFINITIONS.claude.displayName;

  async getVersion() {
    return (await claudeCliStatus()).version;
  }

  async listModels() {
    const models = [
      { id:'default', displayName:'Default', description:'Claude Code 默认模型', available:true },
      { id:'sonnet', displayName:'Sonnet', description:'Claude Code 官方稳定 alias', available:true },
      { id:'opus', displayName:'Opus', description:'Claude Code 官方稳定 alias', available:true },
    ];
    return { models, current:'default', error:null };
  }

  async status(): Promise<AgentStatus> {
    return claudeCliStatus();
  }
}

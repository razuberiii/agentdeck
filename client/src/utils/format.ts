import type { ProviderId, ProviderStatus, RuntimeConnection } from '../api/types';

export function statusLabel(s?:string){ return ({idle:'空闲',submitting:'提交中',planning:'生成计划中',waiting_plan_approval:'计划完成',executing_approved_plan:'执行计划中',plan_cancelled:'计划已取消',running:'执行中',waiting_approval:'等待审批',waiting_input:'等待回答',cancelling:'正在停止',output_draining:'正在收尾',completed:'已完成',active:'空闲',failed:'失败',interrupted:'已中断',unknown:'未知',notLoaded:'可继续'} as any)[s||''] || s || '空闲'; }
export function connectionLabel(s?:string){ return ({connected:'已连接',reconnecting:'重连中',offline:'离线',checking:'检查中',recovering:'恢复中',unavailable:'不可用',disconnected:'已断开',unknown:'未知'} as any)[s||''] || s || '未知'; }
export function formatTime(ms?:number){ if(!ms) return '未知时间'; return new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(ms)); }
export function formatSize(bytes:number){ if(bytes<1024) return `${bytes} B`; if(bytes<1024*1024) return `${(bytes/1024).toFixed(1)} KB`; return `${(bytes/1024/1024).toFixed(2)} MB`; }
export function projectName(path:string){ return path.split('/').filter(Boolean).pop() || path; }
export function shortError(e:any){ return String(e?.userMessage || e?.message || e); }
export function normalizeRuntimeConnection(value:any):RuntimeConnection {
  const s=String(value||'unknown');
  if(['connected','checking','recovering','unavailable','disconnected','unknown'].includes(s)) return s as RuntimeConnection;
  return 'recovering';
}
export function modeLabel(mode?:string){ if(mode==='read-only')return 'Read Only'; if(mode==='workspace-write')return 'Workspace Write'; return 'YOLO'; }
export function providerLabel(id?:string){ return id==='claude' ? 'Claude Code' : id==='antigravity' ? 'Antigravity' : id==='gemini' ? 'Gemini' : 'Codex'; }
export function providerAuthLabel(status?:ProviderStatus|null){
  if(status?.availability==='unavailable') return '服务不可用';
  if(status?.availability==='error') return '状态异常';
  return ({checking:'正在检查',authenticated:'已登录',unauthenticated:'未登录',authenticating:'正在登录',unknown:'状态未知',not_applicable:'无需登录',error:'状态异常'} as any)[status?.auth || 'unknown'] || '状态未知';
}
export function shortProviderReason(status?:ProviderStatus|null){
  return String(status?.message || status?.error || status?.reasonCode || '简短原因').split(/[。\n]/)[0].slice(0, 28);
}
export function sessionProvider(session:{provider_id?:ProviderId;providerId?:ProviderId}){ return session.provider_id || session.providerId || 'codex'; }

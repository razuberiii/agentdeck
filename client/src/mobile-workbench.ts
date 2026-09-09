import type { Session } from './api/types';

export type TaskFilter = 'all' | 'running' | 'waiting';
export type LaunchDraft = { version:1; text:string; mode:'direct'|'plan'; workspace:string };
export const LAUNCH_DRAFT_KEY = 'agentdeck:launchDraft:v1';

export function clearSubmittedDraft(current:LaunchDraft, submitted:string):LaunchDraft {
  return submitted && current.text === submitted ? {...current,text:''} : current;
}

export function loginErrorMessage(error:unknown):string {
  const value = error as {status?:number;code?:string} | null;
  if (value?.status === 401) return '密码不正确，请检查后重试。';
  if (value?.status === 403) return '当前访问地址未获允许，请使用管理员配置的网站地址。';
  if (value?.status === 429) return '尝试次数过多，请稍后再试。';
  if (error instanceof TypeError) return '网络连接失败，请检查网络后重试。';
  return '服务暂时不可用，请稍后重试。';
}
export function taskBucket(session:Pick<Session,'status'|'activeTurn'>):'running'|'waiting'|'other' {
  const status = session.activeTurn?.status || session.status;
  if (['waiting_approval','waiting_input','waiting_plan_approval'].includes(status)) return 'waiting';
  if (['running','submitting','planning','recovering','executing_approved_plan','cancelling','output_draining'].includes(status)) return 'running';
  return 'other';
}
export function matchesTask(session:Pick<Session,'title'|'project_dir'|'status'|'activeTurn'>, query:string, label:string):boolean {
  return [session.title,session.project_dir,session.status,session.activeTurn?.status,label].join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
}
export function parseLaunchDraft(raw:string|null):LaunchDraft {
  const empty:LaunchDraft = {version:1,text:'',mode:'direct',workspace:''};
  try {
    const value = JSON.parse(raw || 'null');
    if (!value || value.version !== 1) return empty;
    return {version:1,text:typeof value.text === 'string' ? value.text : '',mode:value.mode === 'plan' ? 'plan' : 'direct',workspace:typeof value.workspace === 'string' ? value.workspace : ''};
  } catch { return empty; }
}

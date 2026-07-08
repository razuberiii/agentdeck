import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { loginMethodViews, type LoginMethodView } from './login-methods';
import { attachmentIconLabel, isImageAttachment } from './attachment-preview';
import { applyTimelineMessage, applyTimelineSnapshot, emptyTimelineState, reconcileTimelineEvents, resolveTurnUiStatus, runtimeMessageSequence, type TimelineState, type TurnUiStatus } from './timeline-reducer';
import { api } from './api/client';
import type { ApprovalRequest, Attachment, DisplayEvent, ModelOption, Project, ProviderId, ProviderInstallJob, ProviderInstaller, ProviderStatus, RuntimeConnection, Session, Status, Toast } from './api/types';
import { connectionLabel, formatSize, formatTime, modeLabel, normalizeRuntimeConnection, projectName, providerAuthLabel, providerLabel, sessionProvider, shortError, shortProviderReason, statusLabel } from './utils/format';
import { draftAttachmentsKey, draftKey, loadDraftAttachments, saveDraftAttachments, sequenceKey } from './utils/storage';
import './styles.css';

const FALLBACK_WORKSPACE = '/opt/agentdeck';
const APP_NAME = 'Agent Deck';
const CHUNK_SIZE = 24 * 1024;
const PUBLIC_UPLOAD_TARGET_BYTES = 650 * 1024;
const MOBILE_CONTEXT_MARKER = '[[CODEX_MOBILE_CLIENT_CONTEXT]]';
const RECOVERY_CONTEXT_MARKER = '[[AGENT_RUNTIME_RECOVERY_CONTEXT]]';
const PROVIDER_ORDER:ProviderId[] = ['codex','claude','antigravity','gemini'];
const ToastContext = createContext<(kind:Toast['kind'], text:string)=>void>(()=>{});
function haptic(){ navigator.vibrate?.(10); }
function isMobileInput(){ return matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent); }
function profileLabel(profile:any){
  const identity=profile?.email || profile?.login?.email || profile?.displayName || profile?.login?.displayName;
  if(identity) return identity;
  return String(profile?.metadataStatus || profile?.metadata_status || 'pending')==='failed' ? '账户信息读取失败，可重试' : '正在读取账户信息';
}
function geminiProfileLabel(profile:any){ return profile?.login?.email || profile?.name || 'Gemini Account'; }
function activeAccountCount(profiles:any[]){
  return (profiles||[]).filter((p:any)=>p.login?.ok || (p.state||p.status)==='authenticated').length;
}
function deleteAccountDetail(only:boolean){
  return `将删除该账户在本机保存的登录凭据。历史会话和消息不会删除；之后继续会话时，将使用当前可用的账户。${only?' 删除后该 Agent 将处于未登录状态，重新登录后仍可继续已有会话。':''}`;
}
function cancelLoginDetail(){ return '将停止本次登录并删除临时授权信息。'; }
function providerChoiceStatus(status?:ProviderStatus|null){
  if(status?.availability==='unavailable' || status?.availability==='error') return '不可用';
  if(status?.auth==='authenticated') return '已登录';
  if(status?.auth==='unauthenticated') return '未登录';
  if(status?.auth==='authenticating') return '正在登录';
  return '状态未知';
}
function providerChoiceDetail(status?:ProviderStatus|null){
  const account = status?.accountSummary?.email || status?.accountSummary?.displayName || status?.account?.email || status?.account?.displayName || '';
  if(status?.reasonCode==='gemini_client_unsupported') return account ? `已登录 · ${account}` : '已登录 · 个人版客户端已停止支持';
  if(status?.availability==='unavailable' || status?.availability==='error') return `不可用 · ${shortProviderReason(status)}`;
  if(status?.auth==='authenticated') return `已登录${account ? ` · ${account}` : ''}`;
  if(status?.auth==='unauthenticated') return '未登录';
  if(status?.auth==='authenticating') return '正在登录';
  return '状态未知';
}
function providerChoiceNote(status?:ProviderStatus|null){
  if(status?.reasonCode==='gemini_client_unsupported') return '个人版客户端已停止支持';
  return '';
}
function providerSubtitle(status?:ProviderStatus|null){
  if(!status) return '正在检查';
  const label = providerAuthLabel(status);
  const account = status.accountSummary?.email || status.accountSummary?.displayName || status.account?.email || status.account?.displayName;
  if(status.availability==='unavailable') return [status.version, label].filter(Boolean).join(' · ') || label;
  return [status.version, label, account].filter(Boolean).join(' · ');
}
function providerNotice(status?:ProviderStatus|null){
  const label = providerAuthLabel(status);
  if(status?.message && status.auth !== 'authenticated') return status.message;
  return `${providerLabel(status?.id)} ${label}。`;
}
function homeServerLabel(error:string, loading:boolean, refreshing:boolean, providerStatus?:ProviderStatus|null, runtime?:any){
  if(error) return '异常';
  if(loading || refreshing) return '检查中';
  if(!navigator.onLine) return '异常';
  if(runtime?.error) return '异常';
  if(providerStatus?.availability==='unavailable' || providerStatus?.availability==='error') return '异常';
  return '在线';
}
function homeAgentLabel(provider:ProviderId, status?:ProviderStatus|null){
  const name = providerLabel(provider);
  if(status?.availability==='unavailable' || status?.availability==='error') return `${name} · 不可用`;
  if(status?.auth==='unauthenticated') return `${name} · 需要登录`;
  return name;
}
function accountSubtitle(provider:string, codexProfile:any, geminiProfile:any, antigravityProfile:any, providerStatus:any){
  if(providerStatus?.accountSummary?.email || providerStatus?.accountSummary?.displayName) return providerStatus.accountSummary.email || providerStatus.accountSummary.displayName;
  if(providerStatus?.account?.email || providerStatus?.account?.displayName) return providerStatus.account.email || providerStatus.account.displayName;
  if(providerStatus?.availability==='unavailable') return `${providerLabel(provider)} 服务不可用`;
  return providerAuthLabel(providerStatus);
}
function currentAccountSummary(provider:ProviderId, profile:any, status?:ProviderStatus|null){
  const state = String(profile?.state || profile?.status || '');
  const metadataStatus=String(profile?.metadataStatus || profile?.metadata_status || '');
  if(provider==='codex'&&metadataStatus==='failed') return {primary:'账户信息读取失败，可重试', secondary:'已登录'};
  if(provider==='codex'&&(metadataStatus==='pending'||state==='unresolved_identity'||status?.reasonCode==='codex_profile_identity_unresolved')) return {primary:'正在读取账户信息', secondary:'已登录'};
  const account = status?.accountSummary || status?.account || null;
  const identity = profile?.login?.email || profile?.email || account?.email || profile?.login?.displayName || profile?.displayName || account?.displayName || '';
  const authenticated = !!profile?.login?.ok || state==='authenticated' || (!!account && status?.auth==='authenticated');
  if(authenticated) return {primary:identity || `${providerLabel(provider)} 账户`, secondary:'已登录'};
  return {primary:'尚未登录', secondary:''};
}
function pendingLoginTitle(provider:ProviderId, profile:any){
  const state = String(profile?.state || profile?.status || '');
  if(state==='failed' || state==='needs_login') return `${providerLabel(provider)} 登录未完成`;
  return `等待完成 ${providerLabel(provider)} 授权`;
}
function authTypeLabel(type:string){ const v=String(type||''); if(v==='official_cli') return 'Claude CLI'; if(v==='api_key') return 'API Key'; if(v==='setup_token') return 'setup-token'; if(v==='existing_cli') return 'Existing CLI'; if(v==='oauth'||v==='oauth-personal') return 'Google'; if(v==='vertex') return 'Vertex'; return v; }

function ToastProvider({children}:{children:React.ReactNode}){
  const [toasts,setToasts]=useState<Toast[]>([]);
  const push=(kind:Toast['kind'], text:string)=>{
    const key = `${kind}:${text}`;
    setToasts(v=>v.some(t=>`${t.kind}:${t.text}`===key) ? v : [...v.slice(-2), {id:crypto.randomUUID(), kind, text}]);
    window.setTimeout(()=>setToasts(v=>v.filter(t=>`${t.kind}:${t.text}`!==key)), 2600);
  };
  return <ToastContext.Provider value={push}>{children}<div className="toasts" aria-live="polite">{toasts.map(t=><div className={`toast ${t.kind}`} key={t.id}>{t.text}</div>)}</div></ToastContext.Provider>;
}
function useToast(){ return useContext(ToastContext); }

function App(){
  const [authed,setAuthed]=useState(false);
  const [checked,setChecked]=useState(false);
  const [view,setView]=useState(location.hash || '#/');
  useEffect(()=>{const f=()=>setView(location.hash||'#/'); addEventListener('hashchange',f); return()=>removeEventListener('hashchange',f)},[]);
  useEffect(()=>{api('/api/auth/status').then(s=>setAuthed(!!(s.authenticated ?? s.authed))).catch(()=>setAuthed(false)).finally(()=>setChecked(true))},[]);
  if(!checked) return <main className="boot">{APP_NAME}</main>;
  if(!authed) return <Login onLogin={()=>setAuthed(true)}/>;
  const m=view.match(/^#\/s\/([^/]+)/);
  if(view==='#/diagnostics') return <DiagnosticsView/>;
  return m ? <SessionView id={m[1]}/> : <Home/>;
}

function Login({onLogin}:{onLogin:()=>void}){
  const toast=useToast(); const [password,setPassword]=useState(''); const [busy,setBusy]=useState(false);
  async function submit(e:any){ e.preventDefault(); setBusy(true); try{ await api('/api/login',{method:'POST',body:JSON.stringify({username:'admin',password})}); haptic(); onLogin(); } catch { toast('error','登录失败'); } finally { setBusy(false); } }
  return <main className="login"><form onSubmit={submit} className="loginPanel"><div className="mark">AD</div><h1>{APP_NAME}</h1><input autoFocus type="password" placeholder="管理员密码" value={password} onChange={e=>setPassword(e.target.value)}/><button className="btn primary" disabled={busy}>{busy?'登录中':'登录'}</button></form></main>;
}

function DiagnosticsView(){
  const toast=useToast();
  const [data,setData]=useState<any>(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState('');
  useEffect(()=>{ refresh(); },[]);
  async function refresh(){ setLoading(true); setError(''); try{ setData(await api('/api/diagnostics')); } catch(e:any){ const msg=shortError(e); setError(msg); toast('error','诊断读取失败：'+msg); } finally { setLoading(false); } }
  const provider=data?.provider||{};
  const session=data?.session||{};
  const runtime=data?.runtime||{};
  const web=data?.web||{};
  return <main className="appShell diagnosticPage">
    <header className="homeTop"><div><strong>诊断</strong><span>运行状态、Provider 和事件序列</span></div><div className="iconRow"><button className="iconBtn" aria-label="返回" onClick={()=>{location.hash='#/'}}>‹</button><button className="iconBtn" aria-label="刷新" disabled={loading} onClick={refresh}>↻</button></div></header>
    {error&&<ErrorState title="诊断读取失败" detail={error} action="重试" onAction={refresh}/>}
    {loading&&!data&&<LoadingRows count={5}/>}
    {data&&<div className="diagnosticGrid">
      <DiagnosticSection title="版本" rows={[['Commit',data.commit],['Web',web.status||'ready'],['Runtime',runtime.error?'异常':'ready'],['PID',String(web.pid||'')]]}/>
      <DiagnosticSection title="Provider" rows={[['Agent',providerLabel(provider.activeProvider)],['Active Profile',provider.activeProfileId||'无'],['Email',provider.accountEmail||'无'],['Checked At',provider.checkedAt||'无'],['Create',String(!!provider.canCreateSession)],['Continue',String(!!provider.canContinueSession)],['Auth',provider.status?.auth||'unknown'],['Availability',provider.status?.availability||'unknown'],['Reason',provider.status?.reasonCode||'无']]}/>
      <DiagnosticSection title="Session" rows={[['Session',session.currentSessionId||'无'],['Turn',session.currentTurnId||'无'],['Status',session.status||'无'],['Creator',session.creatorProfileId||'无'],['Selected',session.selectedProfileId||'无'],['Executing',session.executingProfileId||'无'],['Binding',session.upstreamBindingProfileId||'无'],['Runtime Seq',String(session.runtimeLatestSequence||0)],['Generation',session.runtimeGeneration||'无']]}/>
      <DiagnosticSection title="App Server" rows={[['Unit',data.appServer?.unit||'无'],['Endpoint',data.appServer?.endpoint||'无'],['Health',data.appServer?.health||'无'],['PID',data.appServer?.providerProcessPid||'由 Runtime 检查']]}/>
      <DiagnosticSection title="Events" rows={[['Runtime subscribers',String(runtime.activeSseSubscriberTotal ?? runtime.activeSseSubscriberCount ?? 0)],['Web subscribers',String((web.runtimeSubscriptions||[]).reduce((sum:number,s:any)=>sum+Number(s.subscriberCount||0),0))],['Replay calls',String(web.counters?.replayCalls||0)],['Browser applied',localStorage.getItem(sequenceKey(session.currentSessionId||'')) || '0'],['Browser acknowledged','WebSocket join lastSequence']]}/>
      <DiagnosticSection title="Sequence Terms" rows={Object.entries(data.sequenceTerms||{}).map(([k,v])=>[k,String(v)])}/>
    </div>}
  </main>;
}
function DiagnosticSection({title,rows}:{title:string;rows:[string,string][]}){
  return <section className="diagnosticSection"><b>{title}</b>{rows.map(([k,v])=><div key={k}><span>{k}</span><strong>{v || '无'}</strong></div>)}</section>;
}

function Home(){
  const toast=useToast();
  const [status,setStatus]=useState<Status|null>(null); const [projects,setProjects]=useState<Project[]>([]); const [sessions,setSessions]=useState<Session[]>([]);
  const [archived,setArchived]=useState(false); const [query,setQuery]=useState(''); const [picker,setPicker]=useState(false); const [busy,setBusy]=useState(''); const [sessionsLoading,setSessionsLoading]=useState(true); const [appStateLoading,setAppStateLoading]=useState(true); const [statusRefreshing,setStatusRefreshing]=useState(false); const [projectsLoading,setProjectsLoading]=useState(false); const [error,setError]=useState('');
  const [quota,setQuota]=useState<any>(null); const [quotaOpen,setQuotaOpen]=useState(false); const [settingsOpen,setSettingsOpen]=useState(false); const [settings,setSettings]=useState<any>(null); const [settingsLoading,setSettingsLoading]=useState(false); const [settingsError,setSettingsError]=useState(''); const [online,setOnline]=useState(navigator.onLine);
  const appStateRequestRef=useRef(0);
  useEffect(()=>{ refresh(); },[archived]);
  useEffect(()=>{ const on=()=>setOnline(navigator.onLine); addEventListener('online',on); addEventListener('offline',on); return()=>{removeEventListener('online',on); removeEventListener('offline',on)} },[]);
  async function refresh(scanProjects=false){ setError(''); const sessionsPromise=refreshSessions(); refreshAppState(); if(scanProjects){ refreshStatus(); loadProjects(true); } await sessionsPromise; }
  async function refreshSessions(){ setSessionsLoading(true); try{ const ss=await api('/api/sessions'+(archived?'?archived=1':'')); setSessions(ss.sessions); } catch(e:any){ setError(shortError(e)); toast('error','会话读取失败'); } finally { setSessionsLoading(false); } }
  async function refreshAppState(){ const requestId=++appStateRequestRef.current; setAppStateLoading(true); try{ const next=(await api('/api/app-state')) as Status; if(requestId===appStateRequestRef.current) setStatus(next); } catch(e:any){ if(requestId===appStateRequestRef.current) setError(shortError(e)); } finally { if(requestId===appStateRequestRef.current) setAppStateLoading(false); } }
  async function refreshStatus(){ setStatusRefreshing(true); try{ setStatus((await api('/api/status')) as Status); } catch(e:any){ console.warn('status refresh failed', e); } finally { setStatusRefreshing(false); } }
  async function loadProjects(force=true){ setProjectsLoading(true); try{ const ps=await api('/api/projects'+(force?'?refresh=1':'')); setProjects(ps.projects); } catch(e:any){ toast('error','项目扫描失败：'+shortError(e)); } finally{ setProjectsLoading(false); } }
  async function openProjectPicker(){ setPicker(true); await loadProjects(true); }
  const defaultWorkspace = status?.defaultWorkspace || status?.roots?.[0] || FALLBACK_WORKSPACE;
  async function newSession(projectDir:string,title?:string){
    if(activeProviderStatus && !activeProviderStatus.canCreateSession){ toast('error', activeProviderStatus.message || `${providerLabel(activeProvider)} 当前不能创建会话`); return; }
    setBusy(projectDir);
    try{ const s=await api('/api/sessions',{method:'POST',body:JSON.stringify({projectDir,title:title||projectName(projectDir),mode:status?.defaultMode,providerId:status?.activeProvider||'codex'})}); haptic(); location.hash='#/s/'+s.id; }
    catch(e:any){ toast('error','创建失败：'+shortError(e)); }
    finally{ setBusy(''); }
  }
  async function showQuota(){ setQuotaOpen(true); try{ setQuota(await api('/api/quota?provider='+encodeURIComponent(activeProvider))); } catch(e:any){ setQuota({errors:{rateLimits:shortError(e)}}); } }
  async function loadSettings(){ setSettingsLoading(true); setSettingsError(''); try{ setSettings(await api('/api/settings?light=1')); } catch(e:any){ const msg=shortError(e); setSettingsError(msg); toast('error','设置读取失败：'+msg); } finally { setSettingsLoading(false); } }
  const [settingsInitialPage,setSettingsInitialPage]=useState<'main'|'agent'>('main');
  function showSettings(page:'main'|'agent'='main'){ setSettingsInitialPage(page); setSettingsOpen(true); loadSettings(); }
  const activeProvider=status?.activeProvider || 'codex';
  const activeProviderStatus = (status?.providers||[]).find(p=>p.id===activeProvider) || (activeProvider === 'gemini' ? status?.gemini : activeProvider === 'antigravity' ? status?.antigravity : status?.codex);
  const runtimeForHome = activeProvider === 'gemini' ? status?.gemini?.runtime : null;
  const filtered=sessions.filter(s=>sessionProvider(s)===activeProvider).filter(s=>(s.title+' '+s.project_dir+' '+s.status).toLowerCase().includes(query.toLowerCase()));
  return <main className="appShell">
    <header className="homeTop">
      <div><strong>{APP_NAME}</strong><span>{online?'网络在线':'网络离线'} · {providerLabel(activeProvider)} · {modeLabel(status?.defaultMode)}</span></div>
      <div className="iconRow"><button className="iconBtn" aria-label="诊断" onClick={()=>{location.hash='#/diagnostics'}}>i</button><button className="iconBtn" aria-label="设置" onClick={()=>showSettings()}>⚙</button><button className="iconBtn" aria-label="查看额度" onClick={showQuota}>%</button><button className="iconBtn" aria-label="刷新" disabled={statusRefreshing||appStateLoading} onClick={()=>refresh(true)}>↻</button></div>
    </header>
    {!online&&<InlineNotice tone="error" text="网络已断开，当前页面仍可浏览，恢复后会自动重新连接。"/>}
    <section className="statusStrip">
      <div><span>服务器</span><b>{homeServerLabel(error, appStateLoading, statusRefreshing, activeProviderStatus, runtimeForHome)}</b></div>
      <button className="statusRowButton" aria-label="打开提供方选择" onClick={()=>showSettings('agent')}><span aria-hidden="true">Agent</span><b aria-hidden="true">{homeAgentLabel(activeProvider, activeProviderStatus)}</b></button>
      <div><span>模式</span><b>{modeLabel(status?.defaultMode)}</b></div>
    </section>
    {error&&<ErrorState title="连接失败" detail={error} action="重试" onAction={()=>refresh(true)}/>}
    <section className="quickStart">
      <button className="taskButton" disabled={!!busy} onClick={()=>newSession(defaultWorkspace,'Default Workspace')}><span>新建任务</span><b>{busy===defaultWorkspace?'创建中':'默认工作区'}</b></button>
      <button className="taskButton secondary" onClick={openProjectPicker}><span>选择项目</span><b>{projectsLoading?'扫描中':projects.length ? `${projects.length} 个可用` : '点击扫描'}</b></button>
    </section>
    <section className="sessionTools">
      <div className="seg"><button className={!archived?'active':''} onClick={()=>setArchived(false)}>当前</button><button className={archived?'active':''} onClick={()=>setArchived(true)}>归档</button></div>
      <input className="search" value={query} onChange={e=>setQuery(e.target.value)} placeholder="搜索会话、项目或状态"/>
    </section>
    <section className="sessionList" aria-busy={sessionsLoading}>
      {sessionsLoading&&<LoadingRows count={6}/>}
      {!sessionsLoading&&!filtered.length&&<EmptyState title={archived?'没有归档会话':'还没有最近会话'} detail={query?'换个关键词试试':'选择项目或新建任务开始'} />}
      {filtered.map(s=><SessionRow key={s.id} session={s} onArchive={async()=>{ try{ await api(`/api/sessions/${s.id}/${s.archived?'unarchive':'archive'}`,{method:'POST'}); haptic(); toast('success',s.archived?'已恢复':'已归档'); refresh(); } catch(e:any){ toast('error','操作失败：'+shortError(e)); } }}/>)}
    </section>
    {picker&&<ProjectPicker projects={projects} busy={busy} loading={projectsLoading} onRefresh={()=>loadProjects(true)} onClose={()=>setPicker(false)} onPick={(p)=>newSession(p.path,p.name)}/>}
    {quotaOpen&&<QuotaSheet quota={quota} onRefresh={showQuota} onClose={()=>setQuotaOpen(false)}/>}
    {settingsOpen&&<SettingsErrorBoundary onClose={()=>setSettingsOpen(false)} resetKey={settingsOpen ? String(settings?.settings?.activeProvider || 'open') : 'closed'}><SettingsSheet data={settings} loading={settingsLoading} error={settingsError} initialPage={settingsInitialPage} onRetry={loadSettings} onChanged={async()=>{ refresh(); const next=await api('/api/settings?light=1'); setSettings(next); return next; }} onClose={()=>setSettingsOpen(false)}/></SettingsErrorBoundary>}
  </main>;
}

function SessionRow({session,onArchive}:{session:Session;onArchive:()=>void}){
  return <article className="sessionRow">
    <button className="sessionMain" onClick={()=>location.hash='#/s/'+session.id}>
      <b>{session.title}</b><span><i className="providerBadge">{providerLabel(sessionProvider(session))}</i>{projectName(session.project_dir)}{session.model?` · ${modelLabel(session.model)}`:''} · {statusLabel(session.status)} · {formatTime(session.updated_at)}</span><small>{session.project_dir}</small>
    </button>
    <button className="thinBtn" onClick={onArchive}>{session.archived?'恢复':'归档'}</button>
  </article>;
}
function ProjectPicker({projects,busy,loading,onRefresh,onClose,onPick}:{projects:Project[];busy:string;loading:boolean;onRefresh:()=>void;onClose:()=>void;onPick:(p:Project)=>void}){
  const [q,setQ]=useState(''); const filtered=projects.filter(p=>(p.name+' '+p.path+' '+(p.branch||'')).toLowerCase().includes(q.toLowerCase()));
  return <Sheet className="projectSheet" onClose={onClose} title="选择项目" subtitle={loading?'正在扫描项目':'点击后创建新会话'} actions={<button disabled={loading} onClick={onRefresh}>刷新</button>}><input className="search" value={q} onChange={e=>setQ(e.target.value)} placeholder="搜索项目"/><div className="projectList">{loading&&<LoadingRows count={5}/>} {!loading&&!filtered.length&&<EmptyState title="没有项目" detail="点刷新重新扫描可用工作区"/>}{!loading&&filtered.map(p=><button className="projectRow" key={p.path} disabled={busy===p.path} onClick={()=>onPick(p)}><b>{busy===p.path?'创建中':p.name}</b><span>{p.branch || 'no branch'} · {formatTime(p.updatedAt)}</span><small>{p.path}</small></button>)}</div></Sheet>;
}

function SessionView({id}:{id:string}){
  const toast=useToast();
  const [session,setSession]=useState<Session|null>(null); const [timeline,setTimeline]=useState<TimelineState>(()=>emptyTimelineState());
  const [loading,setLoading]=useState(true);
  const [text,setText]=useState(''); const [attachments,setAttachments]=useState<Attachment[]>([]); const [status,setStatus]=useState<Status|null>(null);
  const [busy,setBusy]=useState(''); const [online,setOnline]=useState(navigator.onLine); const [browserConnection,setBrowserConnection]=useState<'connected'|'reconnecting'|'offline'>(navigator.onLine?'reconnecting':'offline'); const [runtimeConnection,setRuntimeConnection]=useState<RuntimeConnection>('checking'); const [turnStatus,setTurnStatus]=useState<TurnUiStatus>('unknown'); const [diff,setDiff]=useState(''); const [menu,setMenu]=useState(false); const [modelOpen,setModelOpen]=useState(false); const [models,setModels]=useState<any>(null); const [modelsProvider,setModelsProvider]=useState<string>(''); const [confirmDelete,setConfirmDelete]=useState(false); const [quota,setQuota]=useState<any>(null); const [quotaOpen,setQuotaOpen]=useState(false); const [viewer,setViewer]=useState<Attachment|null>(null); const [showBottom,setShowBottom]=useState(false); const [drag,setDrag]=useState(false); const [approvals,setApprovals]=useState<ApprovalRequest[]>([]); const [sendMode,setSendMode]=useState<'direct'|'plan'>(()=>(localStorage.getItem('agentdeck:sendMode')==='plan'?'plan':'direct'));
  const [menuPage,setMenuPage]=useState<'main'|'mode'|'manage'>('main');
  const wsRef=useRef<WebSocket|null>(null); const reconnectRef=useRef<number|null>(null); const joinTimeoutRef=useRef<number|null>(null); const mountedRef=useRef(false); const sessionGenerationRef=useRef(0); const connectionGenerationRef=useRef(0); const feedRef=useRef<HTMLElement|null>(null); const textareaRef=useRef<HTMLTextAreaElement|null>(null); const fileRef=useRef<HTMLInputElement|null>(null); const nearBottomRef=useRef(true); const clientAppliedSequenceRef=useRef(0); const snapshotCoveredSequenceRef=useRef(0); const joinSentAtRef=useRef(0); const pendingMessagesRef=useRef<Map<string,{text:string;attachments:Attachment[]}>>(new Map());
  useEffect(()=>{ mountedRef.current=true; sessionGenerationRef.current++; const generation=sessionGenerationRef.current; const applied=Number(localStorage.getItem(sequenceKey(id)) || 0); clientAppliedSequenceRef.current=applied; snapshotCoveredSequenceRef.current=0; pendingMessagesRef.current=new Map(); setLoading(true); setTimeline(emptyTimelineState(applied)); setApprovals([]); setRuntimeConnection('checking'); setTurnStatus('unknown'); setText(localStorage.getItem(draftKey(id)) || ''); setAttachments(loadDraftAttachments(id)); load(false,generation); refreshStatus(); connect(generation); const on=()=>{ const isOnline=navigator.onLine; setOnline(isOnline); setBrowserConnection(isOnline?(wsRef.current?.readyState===WebSocket.OPEN?'connected':'reconnecting'):'offline'); }; addEventListener('online',on); addEventListener('offline',on); return()=>{ mountedRef.current=false; removeEventListener('online',on); removeEventListener('offline',on); if(reconnectRef.current) clearTimeout(reconnectRef.current); if(joinTimeoutRef.current) clearTimeout(joinTimeoutRef.current); wsRef.current?.close(); }; },[id]);
  useEffect(()=>{ if(!session) return; const provider=sessionProvider(session); setModels(null); setModelsProvider(provider); api('/api/models?provider='+encodeURIComponent(provider)).then(setModels).catch(()=>{}); },[id,session?.provider_id,session?.providerId]);
  useEffect(()=>{ if(nearBottomRef.current) requestAnimationFrame(()=>feedRef.current?.scrollTo({top:feedRef.current.scrollHeight})); },[timeline]);
  useEffect(()=>{ const el=textareaRef.current; if(!el)return; el.style.height='auto'; if(!text.trim()){ el.style.height='42px'; el.style.overflowY='hidden'; return; } const next=Math.min(Math.max(el.scrollHeight, 42), 180); el.style.height=next+'px'; el.style.overflowY=el.scrollHeight>180?'auto':'hidden'; },[text]);
  useEffect(()=>{ if(text.trim()) localStorage.setItem(draftKey(id), text); else localStorage.removeItem(draftKey(id)); },[id,text]);
  useEffect(()=>{ saveDraftAttachments(id, attachments); },[id,attachments]);
  useEffect(()=>{ localStorage.setItem('agentdeck:sendMode', sendMode); },[sendMode]);
  async function refreshStatus(){ try{ setStatus(await api('/api/status')); } catch{} }
  function syncAppliedSequence(seq:number){ if(seq>clientAppliedSequenceRef.current){ clientAppliedSequenceRef.current=seq; localStorage.setItem(sequenceKey(id), String(seq)); } }
  function applyTimelineUpdate(fn:(state:TimelineState)=>TimelineState){ setTimeline(current=>{ const next=fn(current); snapshotCoveredSequenceRef.current=Math.max(snapshotCoveredSequenceRef.current,next.coveredSequence); syncAppliedSequence(next.appliedSequence); return next; }); }
  async function load(resetLive=false,generation=sessionGenerationRef.current){ const startedAt=performance.now(); try{ const d=await api('/api/sessions/'+id); if(generation!==sessionGenerationRef.current){ console.info(`[perf] session-view-load ignored stale id=${id} ms=${Math.round(performance.now()-startedAt)}`); return clientAppliedSequenceRef.current; } setSession(d.session); const covered=Number(d.snapshot?.throughSequence || d.snapshot?.coveredSequence || d.snapshot?.latestSequence || d.session?.last_sequence || 0); applyTimelineUpdate(state=>applyTimelineSnapshot(resetLive?state:{...state,liveMessages:state.liveMessages}, threadEvents(d.thread), covered)); setTurnStatus(resolveTurnUiStatus(d.session, [], false)); if(d.snapshot?.error) setRuntimeConnection(current=>current==='connected'?current:'recovering'); console.info(`[perf] session-view-load id=${id} gen=${generation} runtime=${runtimeConnection} ms=${Math.round(performance.now()-startedAt)}`); return Math.max(clientAppliedSequenceRef.current, covered); } catch(e:any){ if(generation===sessionGenerationRef.current) toast('error','读取会话失败：'+shortError(e)); return clientAppliedSequenceRef.current; } finally { if(generation===sessionGenerationRef.current) setLoading(false); } }
  function connect(generation=sessionGenerationRef.current){ if(!mountedRef.current) return; const proto=location.protocol==='https:'?'wss':'ws'; const ws=new WebSocket(`${proto}://${location.host}/ws`); wsRef.current=ws; const connectionGeneration=++connectionGenerationRef.current; setBrowserConnection(navigator.onLine?'reconnecting':'offline'); ws.onopen=()=>{ if(generation!==sessionGenerationRef.current || connectionGeneration!==connectionGenerationRef.current) return; const openedAt=performance.now(); setBrowserConnection('connected'); setRuntimeConnection('checking'); (async()=>{ const after=await load(true,generation); if(generation!==sessionGenerationRef.current || connectionGeneration!==connectionGenerationRef.current || ws.readyState!==WebSocket.OPEN) return; joinSentAtRef.current=performance.now(); ws.send(JSON.stringify({type:'join',sessionId:id,lastSequence:after,clientAppliedSequence:after,snapshotCoveredSequence:snapshotCoveredSequenceRef.current})); if(joinTimeoutRef.current) clearTimeout(joinTimeoutRef.current); joinTimeoutRef.current=window.setTimeout(()=>{ if(generation===sessionGenerationRef.current && connectionGeneration===connectionGenerationRef.current) setRuntimeConnection(current=>current==='checking'?'unavailable':current); },10000); console.info(`[perf] ws-open-to-join id=${id} gen=${generation} conn=${connectionGeneration} ms=${Math.round(performance.now()-openedAt)}`); refreshStatus(); })(); }; ws.onmessage=e=>applySocketMessage(JSON.parse(e.data),generation,connectionGeneration); ws.onclose=()=>{ if(wsRef.current===ws) wsRef.current=null; if(joinTimeoutRef.current) clearTimeout(joinTimeoutRef.current); if(generation===sessionGenerationRef.current && connectionGeneration===connectionGenerationRef.current) setRuntimeConnection('disconnected'); setBrowserConnection(navigator.onLine?'reconnecting':'offline'); if(mountedRef.current && generation===sessionGenerationRef.current) reconnectRef.current=window.setTimeout(()=>connect(generation),1500); }; }
  function shouldApplyRuntimeSideEffects(msg:any){ const seq=runtimeMessageSequence(msg); return !seq || seq>snapshotCoveredSequenceRef.current; }
  function applySocketMessage(msg:any,generation=sessionGenerationRef.current,connectionGeneration=connectionGenerationRef.current){ if(generation!==sessionGenerationRef.current || connectionGeneration!==connectionGenerationRef.current) return; const fresh=shouldApplyRuntimeSideEffects(msg); if(msg.type==='joined'){ if(joinTimeoutRef.current) clearTimeout(joinTimeoutRef.current); if(joinSentAtRef.current) console.info(`[perf] ws-join-to-connected id=${id} gen=${generation} conn=${connectionGeneration} ms=${Math.round(performance.now()-joinSentAtRef.current)}`); setRuntimeConnection(msg.runtimeConnection?normalizeRuntimeConnection(msg.runtimeConnection):'connected'); return; } if(msg.type==='runtimeConnection'){ if(joinTimeoutRef.current) clearTimeout(joinTimeoutRef.current); if(fresh) setRuntimeConnection(normalizeRuntimeConnection(msg.status)); applyTimelineUpdate(state=>applyTimelineMessage(state,msg)); return; } if(msg.type==='messageStatus'){ const mid=String(msg.clientMessageId||''); if(msg.status==='failed'){ const pending=pendingMessagesRef.current.get(mid); if(pending){ setText(pending.text); setAttachments(pending.attachments); } toast('error','发送失败：'+shortError(msg.error||'runtime 未接受任务')); } if(msg.status==='accepted'||msg.status==='failed'||msg.status==='completed') pendingMessagesRef.current.delete(mid); applyTimelineUpdate(state=>applyTimelineMessage(state,msg)); return; } if(msg.type==='thread_snapshot'){ if(msg.thread){ const covered=Number(msg.snapshot?.throughSequence || msg.snapshot?.coveredSequence || msg.snapshot?.latestSequence || msg.runtimeSequence || 0); applyTimelineUpdate(state=>applyTimelineSnapshot(state, threadEvents(msg.thread), covered)); } if(msg.status || msg.activeTurn || msg.activeTurnId) { const activeTurn=msg.activeTurn || (msg.activeTurnId ? {turnId:msg.activeTurnId,status:msg.status || 'running'} : null); setTurnStatus(resolveTurnUiStatus({status:msg.status,activeTurn}, approvals, busy==='stop')); setSession(s=>s?{...s,status:msg.status || s.status,activeTurn}:s); } return; } if(!fresh){ applyTimelineUpdate(state=>applyTimelineMessage(state,msg)); return; } if(msg.type==='approval'){ setApprovals(v=>v.some(a=>a.requestId===String(msg.requestId))?v:[...v,{requestId:String(msg.requestId),method:String(msg.method),params:msg.params}]); setSession(s=>s?{...s,activeTurn:{turnId:s.activeTurn?.turnId || null,status:'waiting_approval',waitingKind:'approval'}}:s); setTurnStatus('waiting_approval'); haptic(); toast('info','Codex 请求授权'); applyTimelineUpdate(state=>applyTimelineMessage(state,msg)); return; } if(msg.type==='sessionTitle') setSession(s=>s?{...s,title:msg.title}:s); if(msg.type==='codex'&&msg.method==='turn/started'){ const turn=msg.params?.turn; setSession(s=>s?{...s,status:sendMode==='plan'?'planning':'running',activeTurn:{turnId:turn?.id || s.activeTurn?.turnId || null,status:sendMode==='plan'?'planning':'running',startedAt:Date.now()}}:s); setTurnStatus('running'); } if(msg.type==='codex'&&msg.method==='turn/completed'){ const interrupted=turnFailed(msg.params?.turn); setSession(s=>s?{...s,status:interrupted?'interrupted':'idle',activeTurn:null}:s); setTurnStatus(interrupted?'interrupted':'idle'); } if(msg.type==='codex'&&msg.method==='item/completed'&&isTerminalSignal(msg)){ setSession(s=>s?{...s,status:s.status==='planning'?'idle':s.status,activeTurn:s.status==='planning'?null:s.activeTurn}:s); setTurnStatus(s=>s==='running'?'idle':s); } if(msg.type==='codex'&&(msg.method==='turn/failed'||msg.method==='turn/interrupted')){ setSession(s=>s?{...s,status:'interrupted',activeTurn:null}:s); setTurnStatus(msg.method==='turn/failed'?'failed':'interrupted'); } if(msg.type==='error'){ const pending=[...pendingMessagesRef.current.entries()].at(-1); if(msg.code==='runtime_draining'&&pending){ setText(pending[1].text); setAttachments(pending[1].attachments); pendingMessagesRef.current.delete(pending[0]); } toast('error', msg.code==='runtime_draining'?'系统正在更新，新任务暂时不可发送。':'请求失败：'+msg.error); } applyTimelineUpdate(state=>applyTimelineMessage(state,msg)); }
  function onScroll(){ const el=feedRef.current; if(!el)return; nearBottomRef.current=el.scrollHeight-el.scrollTop-el.clientHeight<120; setShowBottom(!nearBottomRef.current); }
  async function send(){ const message=text.replace(/\r\n/g,'\n'); if(!message.trim()&&!attachments.length) return; if(status?.runtimeState && status.runtimeState.acceptingNewTurns===false){ toast('error','系统正在更新，新任务暂时不可发送。'); return; } if(attachments.some(a=>a.uploading||a.error)){ toast('error','附件仍在上传或上传失败'); return; } const ws=wsRef.current; if(!ws||ws.readyState!==WebSocket.OPEN){ toast('error','连接中，请稍后重试'); return; } setBusy('send'); try{ const clientMessageId=sendMessage(ws,id,{text:message,attachments,planMode:sendMode}); pendingMessagesRef.current.set(clientMessageId,{text:message,attachments}); haptic(); setText(''); localStorage.removeItem(draftKey(id)); localStorage.removeItem(draftAttachmentsKey(id)); setAttachments([]); } finally{ setBusy(''); } }
  async function stop(){ setBusy('stop'); setTurnStatus('cancelling'); try{ wsRef.current?.send(JSON.stringify({type:'stop',sessionId:id})); haptic(); toast('info','已请求停止生成'); applyTimelineUpdate(state=>applyTimelineMessage(state,{type:'system',text:'已请求停止生成'})); } finally{ setBusy(''); } }
  async function uploadFiles(files:FileList|File[]){ if(!status?.capabilities?.imageInput&&!status?.capabilities?.fileInput){ toast('error','当前服务端未启用附件输入'); return; } for(const original of Array.from(files)){ let file=original; let compressed=false; const isImage=original.type.startsWith('image/'); try{ if(isImage){ file=await prepareImageForUpload(original,Math.min(status.capabilities.maxAttachmentBytes,PUBLIC_UPLOAD_TARGET_BYTES)); compressed=file!==original; } }catch(e:any){ toast('error',`${original.name} ${shortError(e)}`); continue; } if(file.size>status.capabilities.maxAttachmentBytes){ toast('error',`${file.name} 超过 ${formatSize(status.capabilities.maxAttachmentBytes)}`); continue; } const previewUrl=isImage?URL.createObjectURL(file):undefined; const local:Attachment={id:crypto.randomUUID(),name:file.name,type:file.type||'application/octet-stream',size:file.size,url:'',previewUrl,uploading:true}; setAttachments(v=>[...v,local]); try{ const form=new FormData(); form.append('file',file,file.name); const saved=await api(`/api/sessions/${id}/attachments`,{method:'POST',body:form,headers:{}}); setAttachments(v=>v.map(a=>a.id===local.id?{...saved,previewUrl:saved.previewUrl||previewUrl}:a)); haptic(); if(compressed) toast('info','图片已压缩后上传'); } catch(e:any){ setAttachments(v=>v.map(a=>a.id===local.id?{...a,uploading:false,error:shortError(e)}:a)); toast('error','附件上传失败：'+shortError(e)); } } }
  async function rename(){ const title=prompt('会话名称',session?.title||''); if(!title) return; setBusy('rename'); try{ await api('/api/sessions/'+id,{method:'PATCH',body:JSON.stringify({title})}); setSession(s=>s?{...s,title}:s); haptic(); toast('success','已改名'); } catch(e:any){ toast('error','改名失败：'+shortError(e)); } finally{ setBusy(''); } }
  async function archive(){ setBusy('archive'); try{ await api('/api/sessions/'+id+'/'+(session?.archived?'unarchive':'archive'),{method:'POST'}); haptic(); toast('success',session?.archived?'已恢复':'已归档'); location.hash='#/'; } catch(e:any){ toast('error','归档失败：'+shortError(e)); } finally{ setBusy(''); } }
  async function fork(){ setBusy('fork'); try{ const s=await api('/api/sessions/'+id+'/fork',{method:'POST'}); haptic(); toast('success','Fork 成功，已进入新会话'); location.hash='#/s/'+s.id; } catch(e:any){ toast('error','Fork 失败：'+shortError(e)); } finally{ setBusy(''); } }
  async function del(){ setBusy('delete'); try{ await api('/api/sessions/'+id,{method:'DELETE'}); haptic(); toast('success','已删除'); location.hash='#/'; } catch(e:any){ toast('error','删除失败：'+shortError(e)); } finally{ setBusy(''); } }
  async function showDiff(){ setBusy('diff'); try{ setDiff((await api('/api/sessions/'+id+'/diff')).diff || 'No diff'); } catch(e:any){ toast('error','Diff 读取失败：'+shortError(e)); } finally{ setBusy(''); } }
  async function showQuota(){ setQuotaOpen(true); try{ setQuota(await api('/api/quota?provider='+encodeURIComponent(session ? sessionProvider(session) : 'codex'))); } catch(e:any){ setQuota({errors:{rateLimits:shortError(e)}}); } }
  function toggleMenu(){ setMenu(v=>{ const next=!v; if(next) setMenuPage('main'); return next; }); }
  function closeMenu(){ setMenu(false); setMenuPage('main'); }
  async function setSessionMode(mode:string){ setBusy('mode'); try{ await api('/api/sessions/'+id,{method:'PATCH',body:JSON.stringify({mode})}); setSession(s=>s?{...s,permission_mode:mode}:s); closeMenu(); haptic(); toast('success','已切换为 '+modeLabel(mode)); } catch(e:any){ toast('error','模式切换失败：'+shortError(e)); } finally{ setBusy(''); } }
  async function openModelPicker(){ const provider=session ? sessionProvider(session) : 'codex'; setMenu(false); setModelOpen(true); if(!models || modelsProvider!==provider) try{ setModels(null); setModelsProvider(provider); setModels(await api('/api/models?provider='+encodeURIComponent(provider))); } catch(e:any){ toast('error','模型列表读取失败：'+shortError(e)); } }
  async function setSessionModel(model:string){ setBusy('model'); try{ await api('/api/sessions/'+id,{method:'PATCH',body:JSON.stringify({model})}); setSession(s=>s?{...s,model}:s); setModelOpen(false); haptic(); toast('success','已切换模型'); } catch(e:any){ toast('error','模型切换失败：'+shortError(e)); } finally{ setBusy(''); } }
  async function answerApproval(req:ApprovalRequest, decision:'accept'|'decline'|'accept_session'){ setBusy('approval:'+req.requestId); try{ await api('/api/approvals/'+encodeURIComponent(req.requestId),{method:'POST',body:JSON.stringify({decision,method:req.method,options:req.params?.options||[]})}); setApprovals(v=>v.filter(a=>a.requestId!==req.requestId)); haptic(); toast(decision==='decline'?'info':'success', decision==='decline'?'已拒绝':decision==='accept_session'?'本会话已允许':'已允许'); } catch(e:any){ toast('error','授权回复失败：'+shortError(e)); } finally{ setBusy(''); } }
  const rendered=visibleEvents(reconcileTimelineEvents([...(timeline.snapshotEvents as DisplayEvent[]),...liveEvents(timeline.liveMessages)])); const currentStatus=resolveTurnUiStatus(session, approvals, busy==='stop'||turnStatus==='cancelling', turnStatus, timeline.liveMessages); const activeModel=session?.model || (modelsProvider===(session ? sessionProvider(session) : '') ? catalogCurrent(models) : '') || status?.defaultModel; const runtimeUpdating=status?.runtimeState && status.runtimeState.acceptingNewTurns===false;
  return <main className={`chatShell ${drag?'dragging':''}`} onDragOver={e=>{e.preventDefault();setDrag(true)}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);uploadFiles(e.dataTransfer.files)}}>
    <header className="chatTop"><button className="iconBtn" aria-label="返回" onClick={()=>location.hash='#/'}>‹</button><div className="chatTitle"><b>{session?.title||'Session'}</b><span><i className={`dot ${currentStatus}`}></i>{statusLabel(currentStatus)} · {projectName(session?.project_dir||'')} · {modelLabel(activeModel)} · {modeLabel(session?.permission_mode)} · 浏览器 {connectionLabel(browserConnection)} · Runtime {connectionLabel(runtimeConnection)}</span></div><button className="iconBtn" aria-label="额度" onClick={showQuota}>%</button><button className="iconBtn" aria-label="更多" onClick={toggleMenu}>⋯</button></header>
    <div className="noticeStack" aria-live="polite">
      {!online&&<InlineNotice tone="error" text="网络离线，发送会在连接恢复后可用。"/>}
      {online&&browserConnection!=='connected'&&<InlineNotice tone="info" text="浏览器正在重新连接会话。"/>}
      {runtimeConnection==='checking'&&currentStatus==='running'&&<InlineNotice tone="info" text="Runtime 正在检查连接。"/>}
      {runtimeConnection==='recovering'&&currentStatus==='running'&&<InlineNotice tone="info" text="Runtime 正在恢复，会话恢复后可继续发送。"/>}
      {runtimeConnection==='unavailable'&&<InlineNotice tone="error" text="Runtime 暂不可用，稍后会自动恢复。"/>}
      {runtimeUpdating&&<InlineNotice tone="info" text="系统正在更新，新任务暂时不可发送。当前会话读取和停止仍可用。"/>}
    </div>
    {menu&&<><button className="menuScrim" aria-label="关闭菜单" onClick={closeMenu}/><nav className="moreMenu">
      {menuPage==='main'&&<><button disabled={!!busy} onClick={()=>{ setSendMode(sendMode==='plan'?'direct':'plan'); haptic(); }}><b>发送模式</b><span>{sendMode==='plan'?'计划模式：只生成计划':'普通模式：正常执行'}</span></button><button disabled={!!busy} onClick={openModelPicker}><b>模型</b><span>{modelLabel(activeModel)}</span></button><button disabled={!!busy} onClick={()=>setMenuPage('mode')}><b>权限模式</b><span>{modeLabel(session?.permission_mode)}</span></button><button disabled={!!busy} onClick={()=>{ closeMenu(); showDiff(); }}><b>Diff</b><span>查看当前改动</span></button><button disabled={!!busy} onClick={()=>setMenuPage('manage')}><b>会话管理</b><span>改名、Fork、归档</span></button></>}
      {menuPage==='mode'&&<><button className="menuBack" onClick={()=>setMenuPage('main')}>‹ 权限模式</button><button disabled={!!busy} className={session?.permission_mode==='yolo'?'active':''} onClick={()=>setSessionMode('yolo')}><b>YOLO</b><span>自动允许写入和命令</span></button><button disabled={!!busy} className={session?.permission_mode==='workspace-write'?'active':''} onClick={()=>setSessionMode('workspace-write')}><b>Workspace</b><span>写工作区前确认</span></button><button disabled={!!busy} className={session?.permission_mode==='read-only'?'active':''} onClick={()=>setSessionMode('read-only')}><b>Read Only</b><span>只读模式</span></button></>}
      {menuPage==='manage'&&<><button className="menuBack" onClick={()=>setMenuPage('main')}>‹ 会话管理</button><button disabled={!!busy} onClick={()=>{ closeMenu(); rename(); }}><b>改名</b><span>修改当前标题</span></button><button disabled={!!busy} onClick={()=>{ closeMenu(); fork(); }}><b>Fork</b><span>复制成新会话</span></button><button disabled={!!busy} onClick={()=>{ closeMenu(); archive(); }}><b>{session?.archived?'恢复':'归档'}</b><span>{session?.archived?'移回会话列表':'从列表中收起'}</span></button><button disabled={!!busy} className="dangerText" onClick={()=>{ closeMenu(); setConfirmDelete(true); }}><b>删除</b><span>不可撤销</span></button></>}
    </nav></>}
    {diff&&<DiffPanel diff={diff} onClose={()=>setDiff('')}/>}
    <section className={`feed ${!loading&&!rendered.length&&!approvals.length?'emptyFeed':''}`} ref={feedRef as any} onScroll={onScroll}>{loading?<LoadingRows count={5}/>:<>{rendered.map((e,i)=><EventCard key={e.key||i} e={e} onImage={setViewer}/>)}{approvals.map(a=><ApprovalCard key={a.requestId} req={a} busy={busy==='approval:'+a.requestId} onAnswer={answerApproval}/>)}{!rendered.length&&!approvals.length&&<EmptyState title="没有可显示的对话" detail="发送新消息后会显示回复"/>}</>}</section>
    {showBottom&&<button className="jumpBottom" onClick={()=>{nearBottomRef.current=true;feedRef.current?.scrollTo({top:feedRef.current.scrollHeight,behavior:'smooth'});setShowBottom(false)}}>回到底部</button>}
    <footer className="composer">
      {!!attachments.length&&<AttachmentTray items={attachments} onRemove={id=>setAttachments(v=>v.filter(a=>a.id!==id))} onOpen={setViewer}/>}
      <div className="composeRow"><button className="iconBtn attach" aria-label="添加附件" disabled={!status?.capabilities?.imageInput&&!status?.capabilities?.fileInput} onClick={()=>fileRef.current?.click()}>＋</button><textarea ref={textareaRef} rows={1} value={text} onPaste={e=>{const files=Array.from(e.clipboardData.files); if(files.length){e.preventDefault();uploadFiles(files)}}} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!isMobileInput()){e.preventDefault();send()}}} placeholder={runtimeUpdating?'系统正在更新，输入会保留':sendMode==='plan'?'计划模式：描述任务，只生成计划':'输入任务'}/><button className="iconBtn" aria-label="停止生成" disabled={busy==='stop'} onClick={stop}>■</button><button className="sendBtn" disabled={runtimeUpdating||busy==='send'||(!text.trim()&&!attachments.length)} onClick={send}>{runtimeUpdating?'更新中':busy==='send'?'发送中':'发送'}</button></div>
      <input ref={fileRef} hidden type="file" accept="image/*,.txt,.md,.json,.yaml,.yml,.xml,.csv,.log,.patch,.diff,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.zip,.tar,.gz,.ts,.tsx,.js,.jsx,.mjs,.css,.html,.py,.go,.rs,.java,.kt,.swift,.sh,.sql" capture={undefined} multiple onChange={e=>{ if(e.target.files) uploadFiles(e.target.files); e.currentTarget.value=''; }}/>
    </footer>
    {confirmDelete&&<ConfirmDialog title="删除会话？" detail="会删除本地索引并尝试删除 Codex 会话文件。此操作不可撤销。" confirm="删除" onCancel={()=>setConfirmDelete(false)} onConfirm={del}/>}
    {quotaOpen&&<QuotaSheet quota={quota} onRefresh={showQuota} onClose={()=>setQuotaOpen(false)}/>}
    {modelOpen&&<ModelSheet models={models?.models||[]} value={activeModel} busy={busy==='model'} onPick={setSessionModel} onClose={()=>setModelOpen(false)}/>}
    {viewer&&<ImageViewer image={viewer} onClose={()=>setViewer(null)}/>}
  </main>;
}

function threadEvents(thread:any):DisplayEvent[]{ const out:DisplayEvent[]=[]; const turns=thread?.turns||[]; for(let ti=0; ti<turns.length; ti++){ const turn=turns[ti]; const syntheticImageTail=!turn?.startedAt&&!turn?.completedAt&&ti===turns.length-1&&(turn.items||[]).every((item:any)=>item?.type==='imageGeneration'&&String(item.id||'').startsWith('generated-')); if(syntheticImageTail) continue; for(const item of turn.items||[]){const ev=itemToEvent(item); if(ev) out.push(ev)} } return out; }
function userContent(content:any[]){ const text:string[]=[]; const attachments:Attachment[]=[]; for(const c of content||[]){ if(c.type==='text' && String(c.text||'').trim() && !hasInternalProviderText(c.text)) text.push(c.text); if((c.type==='localImage'||c.type==='image')&&(c.viewerUrl||c.url)) attachments.push({id:c.path||c.url,name:c.name||'image',type:'image',size:0,url:c.viewerUrl||c.url}); } return {text:text.join('\n'),attachments}; }
function stripInternalAttachmentPrompt(text:string){
  const value = String(text||'');
  if (hasInternalProviderText(value)) return '';
  const planText = stripInternalPlanPrompt(value);
  if (planText !== value) return planText;
  return value
    .replace(/\n{0,2}Attachments are available as local files:\n(?:- .+ \| .+ \| \d+ bytes \| \/[^\n]+\n?)+/g, '')
    .replace(/\n{0,2}Attachment:\s*[^\n]*\nMIME:\s*[^\n]*\nSize:\s*[^\n]*\nLocal path:\s*\/[^\n]+\nRead this file from the local path if needed\.?/g, '')
    .trim();
}
function stripInternalPlanPrompt(text:string){
  const value = String(text || '');
  if (!/^\s*\$plan\b/.test(value)) return value;
  const marker = value.match(/用户原始任务：\s*([\s\S]*)$/);
  return marker ? marker[1].trimStart() : '';
}
function hasInternalProviderText(text:any){ const value=String(text||''); return value.includes(MOBILE_CONTEXT_MARKER) || value.includes(RECOVERY_CONTEXT_MARKER); }
function itemToEvent(item:any):DisplayEvent|null{
  if(item.type==='userMessage'){ const c=userContent(item.content); const text=stripInternalAttachmentPrompt(c.text); const attachments=dedupeAttachments([...(item.attachments||[]),...c.attachments]); return (text.trim() || attachments.length) ? {key:String(item.clientMessageId||item.id),messageId:String(item.id||''),clientMessageId:item.clientMessageId?String(item.clientMessageId):undefined,role:'user',text,attachments,meta:messageStatusLabel(item.status)} : null; }
  if(item.type==='agentMessage') {
    const text = String(item.text || '').trim();
    if (!text) return null;
    const artifacts = Array.isArray(item.artifacts) ? item.artifacts : [];
    const artifactImages = artifacts.filter((a:any)=>String(a.type||'').startsWith('image/'));
    const artifactFiles = artifacts.filter((a:any)=>!String(a.type||'').startsWith('image/'));
    const parsedImages = artifacts.length ? [] : extractMarkdownImages(text);
    const parsedFiles = artifacts.length ? [] : extractFileLinks(text);
    return {key:item.id,role:'assistant',text,meta:item.phase==='final_answer'?'最终回答':'回复',images:[...parsedImages,...artifactImages],files:[...parsedFiles,...artifactFiles]};
  }
  if(item.type==='reasoning') return {key:item.id,role:'reasoning',title:'思考',text:[...(item.summary||[]),...(item.content||[])].join('\n')||'正在思考',open:false};
  if(item.type==='plan') return {key:item.id,role:'reasoning',title:'计划',text:item.text||'',open:true};
  if(item.type==='commandExecution') {
    const output = String(item.aggregatedOutput || '').trim();
    const failed = item.status && !['completed','success'].includes(item.status);
    if (!output && !failed) return null;
    return {key:item.id,role:'command',title:'命令',meta:item.status,text:`$ ${item.command || ''}\n\n${output}`.trim(),open:failed};
  }
  if(item.type==='fileChange') {
    const failed = item.status && !['completed','success'].includes(item.status);
    if (!failed) return null;
    const text = (item.changes||[]).map((c:any)=>c.path||c).filter(Boolean).join('\n');
    return {key:item.id,role:'file',title:'文件修改',meta:item.status,text:text||'文件修改失败',open:true};
  }
  if(item.type==='imageView'||item.type==='imageGeneration') {
    const images = item.viewerUrl ? [{id:item.id,name:'image',type:'image',size:0,url:item.viewerUrl}] : [];
    if (!images.length && !String(item.revisedPrompt || item.result || '').trim()) return null;
    return {key:item.id,role:'image',title:item.type==='imageGeneration'?'生成图片':'图片',text:item.revisedPrompt||item.result||'',images};
  }
  if(item.type==='artifact' && item.artifact) {
    const a = item.artifact;
    const target = String(a.type || '').startsWith('image/') ? 'images' : 'files';
    return {key:item.id,role:'image',title:'文件',text:'', [target]:[a]} as DisplayEvent;
  }
  if(item.type==='dynamicToolCall'&&item.contentItems?.length) {
    const images = item.contentItems.filter((x:any)=>x.type==='inputImage').map((x:any,i:number)=>({id:item.id+i,name:'image',type:'image',size:0,url:x.imageUrl}));
    return images.length ? {key:item.id,role:'image',title:item.tool||'工具结果',text:'',images} : null;
  }
  return null;
}
function liveEvents(items:any[]):DisplayEvent[]{
  const out:DisplayEvent[]=[];
  const completed=new Set<string>();
  const messageStatuses=new Map<string,{status:string;error?:string}>();
  let started=false;
  let completedTurn=false;
  for(const m of items) if(m.type==='messageStatus'&&m.clientMessageId) messageStatuses.set(String(m.clientMessageId), {status:String(m.status||''), error:m.error});
  for(const m of items){
    const item=m.params?.item;
    if(m.type==='error') out.push({key:'e'+out.length,role:'system',text:'请求失败：'+m.error});
    if(m.type==='messageStatus'&&m.status==='failed') out.push({key:'mf'+out.length,role:'system',text:'请求失败：'+(m.error||'runtime 未接受任务')});
    if(m.type==='system' && String(m.text||'').trim()) out.push({key:'s'+out.length,role:'system',text:m.text});
    if(m.type==='user' && (String(m.text||'').trim() || m.attachments?.length)) {
      const status=m.clientMessageId ? messageStatuses.get(String(m.clientMessageId))?.status || m.status : m.status;
      out.push({key:m.clientMessageId||m.messageId||'u'+out.length,clientMessageId:m.clientMessageId?String(m.clientMessageId):undefined,messageId:m.messageId?String(m.messageId):undefined,role:'user',text:stripInternalAttachmentPrompt(m.text||''),attachments:m.attachments||[],meta:[messageStatusLabel(status),m.planMode==='plan'?'计划模式':''].filter(Boolean).join(' · ')});
    }
    if(m.type==='artifact' && m.artifact) {
      const target = String(m.artifact.type || '').startsWith('image/') ? 'images' : 'files';
      out.push({key:'artifact'+out.length,role:'image',text:'', [target]:[m.artifact]} as DisplayEvent);
    }
    if(m.type==='codex'){
      if(m.method==='item/completed'){
        if(item?.type==='agentMessage') completed.add(item.id);
        const ev=itemToEvent(item);
        if(ev&&item?.type!=='userMessage') out.push(ev);
      } else if(m.method==='turn/started') started=true;
      else if(m.method==='turn/completed') completedTurn=true;
    }
  }
  const deltas=new Map<string,string>();
  for(const m of items) if(m.type==='codex'&&m.method==='item/agentMessage/delta'){
    const key=m.params?.itemId||'live-agent';
    const delta=String(m.params?.delta||'');
    if(delta.trim()&&!completed.has(key)) deltas.set(key,(deltas.get(key)||'')+delta);
  }
  for(const [key,text] of deltas) if(text.trim()) out.push({key,role:'assistant',text,meta:'正在回复',images:extractMarkdownImages(text),files:extractFileLinks(text)});
  if(started && !completedTurn && !deltas.size) out.push({key:'running',role:'system',text:'正在执行'});
  return out;
}
function messageStatusLabel(status?:string){
  return ({received:'已收到',persisted:'已保存',accepted:'已接受',running:'执行中',completed:'已完成',failed:'发送失败'} as any)[status||''] || '';
}
function isRunningSignal(m:any){
  if(m.method==='turn/started'||m.method==='item/agentMessage/delta') return true;
  const status=String(m.params?.item?.status||'');
  return m.method==='item/started'||status==='inProgress';
}
function isTerminalSignal(m:any){
  if(m.method==='turn/completed'||m.method==='turn/failed'||m.method==='turn/interrupted') return true;
  const item=m.params?.item;
  return m.method==='item/completed'&&item?.type==='agentMessage'&&item?.phase==='final_answer'&&String(item.text||'').trim();
}
function turnFailed(turn:any){ const status=String(turn?.status||''); return status==='failed'||status==='interrupted'; }
function visibleEvents(items:DisplayEvent[]){
  const seenSystem = new Set<string>();
  let lastUserText = '';
  return items.filter(e=>{
    if(e.role==='file'||e.role==='command') return false;
    if((e.role==='user'||e.role==='assistant'||e.role==='image') && !e.text.trim() && !(e.attachments?.length) && !(e.images?.length) && !(e.files?.length)) return false;
    if(e.role==='user'){
      const text = e.text.trim();
      const sameAttachments = !(e.attachments?.length);
      if(text && sameAttachments && text===lastUserText) return false;
      lastUserText = text;
    } else if(e.role!=='system') {
      lastUserText = '';
    }
    if(e.role==='system'){
      if(!e.text.trim()) return false;
      if(seenSystem.has(e.text)) return false;
      seenSystem.add(e.text);
      return ['已连接到会话','正在执行','任务完成','已请求停止生成'].includes(e.text) || e.text.startsWith('请求失败');
    }
    return true;
  });
}
function dedupeAttachments(items:Attachment[]){
  const seen=new Set<string>();
  const out:Attachment[]=[];
  for(const item of items){
    const key=String(item.id||item.url||item.name);
    if(!key||seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
function sendMessage(ws:WebSocket, sessionId:string, payload:{text:string;attachments:Attachment[];planMode?:'direct'|'plan'}){ const clientMessageId=crypto.randomUUID(); const slim={text:payload.text,planMode:payload.planMode||'direct',attachments:payload.attachments.map(a=>({id:a.id,name:a.name,type:a.type,size:a.size}))}; const text=JSON.stringify(slim); if(text.length<=CHUNK_SIZE){ ws.send(JSON.stringify({type:'send',sessionId,clientMessageId,...slim})); return clientMessageId; } const messageId=`${Date.now()}-${Math.random().toString(36).slice(2)}`; ws.send(JSON.stringify({type:'sendChunkStart',sessionId,messageId,clientMessageId})); for(let i=0;i<text.length;i+=CHUNK_SIZE) ws.send(JSON.stringify({type:'sendChunk',messageId,chunk:text.slice(i,i+CHUNK_SIZE)})); ws.send(JSON.stringify({type:'sendChunkEnd',messageId})); return clientMessageId; }
function readFileBase64(file:File){ return new Promise<string>((resolve,reject)=>{ const r=new FileReader(); r.onerror=()=>reject(new Error('read failed')); r.onload=()=>resolve(String(r.result).split(',')[1]||''); r.readAsDataURL(file); }); }
function normalizeImageType(type:string){ if(type==='image/jpg'||type==='image/pjpeg') return 'image/jpeg'; return type; }
async function prepareImageForUpload(file:File,maxBytes:number){
  const type=normalizeImageType(file.type);
  if(!['image/png','image/jpeg','image/webp'].includes(type)) throw new Error(type==='image/heic'||type==='image/heif'?'暂不支持 HEIC，请选择截图或 JPEG/PNG':'类型不支持');
  if(file.size<=maxBytes) return new File([file], file.name, {type, lastModified:file.lastModified});
  const bitmap=await createImageBitmap(file).catch(()=>null);
  if(!bitmap) throw new Error(`超过 ${formatSize(maxBytes)}，且浏览器无法压缩`);
  const scale=Math.min(1, 1400/Math.max(bitmap.width, bitmap.height));
  const canvas=document.createElement('canvas');
  canvas.width=Math.max(1,Math.round(bitmap.width*scale));
  canvas.height=Math.max(1,Math.round(bitmap.height*scale));
  const ctx=canvas.getContext('2d');
  if(!ctx) throw new Error('无法处理图片');
  ctx.drawImage(bitmap,0,0,canvas.width,canvas.height);
  let quality=.86;
  let blob=await canvasToBlob(canvas,'image/jpeg',quality);
  while(blob.size>maxBytes&&quality>.35){ quality-=.1; blob=await canvasToBlob(canvas,'image/jpeg',quality); }
  if(blob.size>maxBytes) throw new Error(`超过 ${formatSize(maxBytes)}，压缩后仍过大`);
  return new File([blob], file.name.replace(/\.[^.]+$/, '')+'.jpg', {type:'image/jpeg', lastModified:Date.now()});
}
function canvasToBlob(canvas:HTMLCanvasElement,type:string,quality:number){ return new Promise<Blob>((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('压缩失败')),type,quality)); }

function EventCard({e,onImage}:{e:DisplayEvent;onImage:(a:Attachment)=>void}){
  const toast=useToast();
  if(e.role==='system') return <div className={`sys ${e.text.includes('完成')?'complete':''}`}>{e.text.includes('任务完成')?'已完成':e.text}</div>;
  if(e.role==='user'||e.role==='assistant'||e.role==='image') {
    const userAttachments = e.attachments || [];
    const images = [...userAttachments.filter(a=>String(a.type||'').startsWith('image/')),...(e.images||[])];
    const files = [...userAttachments.filter(a=>!String(a.type||'').startsWith('image/')),...(e.files||[])];
    if (!e.text.trim() && !images.length && !files.length) return null;
    return <article className={`bubble ${e.role}`}><div className="bubbleHead"><span>{e.role==='user'?(e.meta?`你 · ${e.meta}`:'你'):e.meta||e.title||'回复'}</span>{e.text.trim()&&<CopyButton text={e.text} onDone={(ok)=>toast(ok?'success':'error',ok?'已复制':'复制失败')}/>}</div>{!!e.text.trim()&&<Markdown text={e.text}/>}<ImageGrid images={images} onOpen={onImage}/><FileGrid files={files}/></article>;
  }
  return <details className={`event ${e.role}`} open={e.open}><summary><b>{e.title||e.role}</b>{e.meta&&<span>{e.meta}</span>}</summary><CopyButton text={e.text} onDone={(ok)=>toast(ok?'success':'error',ok?'已复制':'复制失败')}/><pre>{e.text}</pre></details>;
}
function ApprovalCard({req,busy,onAnswer}:{req:ApprovalRequest;busy:boolean;onAnswer:(req:ApprovalRequest,decision:'accept'|'decline'|'accept_session')=>void}){
  const info = approvalInfo(req);
  return <article className="approvalCard" role="group" aria-label="Codex 授权请求">
    <div className="approvalHead"><b>{info.title}</b><span>{info.reason || '等待你确认后继续'}</span></div>
    {info.command&&<pre>{info.command}</pre>}
    {info.cwd&&<small>{info.cwd}</small>}
    {!!info.details.length&&<ul>{info.details.map((d,i)=><li key={i}>{d}</li>)}</ul>}
    <div className="approvalActions"><button disabled={busy} onClick={()=>onAnswer(req,'decline')}>拒绝</button>{req.method.includes('claude/')&&<button disabled={busy} onClick={()=>onAnswer(req,'accept_session')}>本会话允许</button>}<button className="primary" disabled={busy} onClick={()=>onAnswer(req,'accept')}>{busy?'处理中':'允许'}</button></div>
  </article>;
}
function approvalInfo(req:ApprovalRequest){
  const p=req.params||{};
  const title = req.method.includes('fileChange') ? '允许文件修改？' : req.method.includes('permissions') ? '允许提升权限？' : req.method.includes('gemini/') ? '允许 Gemini 工具调用？' : '允许执行命令？';
  const command = typeof p.command === 'string' ? p.command : Array.isArray(p.command) ? p.command.join(' ') : '';
  const details:string[] = [];
  if (p.toolCall?.title) details.push(`工具：${p.toolCall.title}`);
  if (p.toolCall?.kind) details.push(`类型：${p.toolCall.kind}`);
  if (p.grantRoot) details.push(`写入范围：${p.grantRoot}`);
  if (p.permissions) details.push(`权限：${compactJson(p.permissions)}`);
  if (p.commandActions?.length) details.push(...p.commandActions.slice(0,3).map((x:any)=>String(x.type || x.action || compactJson(x))));
  if (p.options?.length) details.push(`选项：${p.options.map((x:any)=>x.name || x.kind || x.optionId).filter(Boolean).join(' / ')}`);
  return { title, command, cwd:p.cwd || '', reason:p.reason || '', details };
}
function compactJson(value:any){ try { return JSON.stringify(value).slice(0, 180); } catch { return String(value).slice(0, 180); } }
function CopyButton({text,onDone}:{text:string;onDone:(ok:boolean)=>void}){ const [ok,setOk]=useState(false); return <button className={`copyBtn ${ok?'ok':''}`} aria-label="复制" onClick={async()=>{ try{ await navigator.clipboard.writeText(text); setOk(true); onDone(true); setTimeout(()=>setOk(false),1200); } catch{ onDone(false); } }}>{ok?'已复制':'复制'}</button>; }
function Markdown({text}:{text:string}){ const blocks=parseMarkdown(text); return <div className="md">{blocks.map((b,i)=>{ if(b.type==='code') return <CodeBlock key={i} code={b.text} lang={b.lang}/>; if(b.type==='quote') return <blockquote key={i}>{renderInlineMarkdown(b.text)}</blockquote>; if(b.type==='table') return <TableBlock key={i} rows={b.rows}/>; if(b.type==='list') return <ul key={i}>{b.items.map((x:string,j:number)=><li key={j}>{renderInlineMarkdown(x)}</li>)}</ul>; if(b.type==='heading') return <h3 key={i}>{renderInlineMarkdown(b.text)}</h3>; return <p key={i}>{renderInlineMarkdown(b.text)}</p>; })}</div>; }
function parseMarkdown(text:string){ const lines=text.split('\n'); const blocks:any[]=[]; const listRe=/^\s*(?:[-*]|\d+[.)])\s+/; for(let i=0;i<lines.length;i++){ const line=lines[i]; if(line.startsWith('```')){ const lang=line.slice(3).trim(); const code:string[]=[]; i++; while(i<lines.length&&!lines[i].startsWith('```')) code.push(lines[i++]); blocks.push({type:'code',lang,text:code.join('\n')}); } else if(listRe.test(line)){ const items=[line.replace(listRe,'')]; while(i+1<lines.length&&listRe.test(lines[i+1])) items.push(lines[++i].replace(listRe,'')); blocks.push({type:'list',items}); } else if(line.includes('|')&&i+1<lines.length&&/^\s*\|?[-:| ]+\|?\s*$/.test(lines[i+1])){ const rows=[line,lines[++i]]; while(i+1<lines.length&&lines[i+1].includes('|')) rows.push(lines[++i]); blocks.push({type:'table',rows}); } else if(line.startsWith('>')) blocks.push({type:'quote',text:line.replace(/^>\s?/, '')}); else if(/^#{1,4}\s+/.test(line)) blocks.push({type:'heading',text:line.replace(/^#{1,4}\s+/, '')}); else if(line.trim()) blocks.push({type:'p',text:line}); } return blocks; }
function CodeBlock({code,lang}:{code:string;lang:string}){ const toast=useToast(); return <div className="codeBlock"><div><span>{lang||'code'}</span><CopyButton text={code} onDone={(ok)=>toast(ok?'success':'error',ok?'已复制代码':'复制失败')}/></div><pre><code>{code}</code></pre></div>; }
function TableBlock({rows}:{rows:string[]}){ const parsed=rows.filter((_,i)=>i!==1).map(r=>r.split('|').map(c=>c.trim()).filter(Boolean)); return <div className="tableWrap"><table><tbody>{parsed.map((r,i)=><tr key={i}>{r.map((c,j)=>i?<td key={j}>{c}</td>:<th key={j}>{c}</th>)}</tr>)}</tbody></table></div>; }
type SafeUrlKind = 'link' | 'image';
function safeUrl(url:string, kind:SafeUrlKind):string{
  const raw = String(url || '').trim();
  if(!raw || /^(?:javascript|data|file|blob):/i.test(raw)) return '';
  if(raw.startsWith('/api/')) return raw;
  try {
    const parsed = new URL(raw, location.origin);
    if(parsed.protocol === 'http:' || parsed.protocol === 'https:'){
      if(parsed.origin === location.origin) return parsed.pathname + parsed.search + parsed.hash;
      return parsed.href;
    }
    if(parsed.origin === location.origin && !/^[a-z][a-z0-9+.-]*:/i.test(raw)) return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    if(!/^[a-z][a-z0-9+.-]*:/i.test(raw) && !/[\s<>"']/.test(raw)) return raw;
  }
  void kind;
  return '';
}
function renderInlineMarkdown(line:string){ const parts=line.split(/(`[^`]+`|\*\*[^*]+\*\*|!\[[^\]]*\]\([^)]+\)|(?<!!)\[[^\]]+\]\([^)]+\))/g); return parts.map((p,i)=>{ const img=p.match(/^!\[([^\]]*)\]\(([^)]+)\)$/); if(img){ const src=safeUrl(img[2], 'image'); return src ? <img className="inlineImage" key={i} alt={img[1]} src={src}/> : <React.Fragment key={i}>{img[1] || 'image'}</React.Fragment>; } const link=p.match(/^\[([^\]]+)\]\(([^)]+)\)$/); if(link){ const href=safeUrl(link[2], 'link'); return href ? <a key={i} href={href} target="_blank" rel="noopener noreferrer" download={isDownloadUrl(href)?fileNameFromUrl(href):undefined}>{link[1]}</a> : <React.Fragment key={i}>{link[1]}</React.Fragment>; } if(/^`[^`]+`$/.test(p)) return <code key={i}>{p.slice(1,-1)}</code>; if(/^\*\*[^*]+\*\*$/.test(p)) return <strong key={i}>{p.slice(2,-2)}</strong>; return <React.Fragment key={i}>{p}</React.Fragment>; }); }
function extractMarkdownImages(text:string):Attachment[]{ return [...text.matchAll(/!\[([^\]]*)\]\(([^)]+)\)/g)].map((m,i)=>{ const url=safeUrl(m[2], 'image'); return url ? {id:url+i,name:m[1]||'image',type:'image',size:0,url} : null; }).filter((x):x is Attachment=>!!x); }
function extractFileLinks(text:string):Attachment[]{
  const links = new Map<string,string>();
  for (const m of text.matchAll(/(?<!!)\[([^\]]+)\]\(([^)]+)\)/g)) { const url=safeUrl(m[2], 'link'); if(url&&isDownloadUrl(url)) links.set(url, m[1]); }
  for (const m of text.matchAll(/(^|\s)((?:https?:\/\/[^\s)]+|\/[^\s)]+)\.(?:conf|zip|txt|log|patch|diff|json|csv|tar\.gz))(?:\s|$)/g)) { const url=safeUrl(m[2], 'link'); if(url&&isDownloadUrl(url)) links.set(url, fileNameFromUrl(url)); }
  return [...links].map(([url,label],i)=>({id:url+i,name:fileNameFromUrl(url) || label || 'download',type:fileTypeFromUrl(url),size:0,url}));
}
function ImageGrid({images,onOpen}:{images:Attachment[];onOpen:(a:Attachment)=>void}){ if(!images.length)return null; return <div className="imageGrid">{images.map(img=><button className="thumb" key={img.id} onClick={()=>onOpen(img)}><img src={img.previewUrl||img.url} alt={img.name}/></button>)}</div>; }
function FileGrid({files}:{files:Attachment[]}){
  if(!files.length)return null;
  const hasArtifactOps=files.some(f=>f.operation==='created'||f.operation==='modified');
  if(!hasArtifactOps) return <div className="fileGrid">{files.map(f=><FileCard key={f.id} file={f}/>)}</div>;
  const created=files.filter(f=>String(f.operation||'created')==='created');
  const modified=files.filter(f=>String(f.operation||'')==='modified');
  return <div className="artifactGroups">
    {!!created.length&&<ArtifactGroup title="已生成文件" files={created}/>}
    {!!modified.length&&<ArtifactGroup title="已修改文件" files={modified}/>}
  </div>;
}
function ArtifactGroup({title,files}:{title:string;files:Attachment[]}){ return <div className="artifactGroup"><b>{title}</b><div className="fileGrid">{files.map(f=><FileCard key={f.id} file={f}/>)}</div></div>; }
function FileCard({file:f}:{file:Attachment}){ return <a className="fileCard" href={f.url} download={f.name} target="_blank" rel="noreferrer"><span className="fileIcon">↓</span><span><b>{f.relativePath || f.name}</b><small>{f.operation==='modified'?'已修改':(f.type || 'download')}</small></span></a>; }
function isDownloadUrl(url:string){ try { const u=new URL(url, location.origin); if(u.origin!==location.origin) return false; return /^\/api\/(?:wireguard\/config|files|sessions\/[^/]+\/(?:attachments|files))\//.test(u.pathname) || /\.(conf|zip|txt|log|patch|diff|json|csv|tar\.gz)$/i.test(u.pathname); } catch { return false; } }
function fileNameFromUrl(url:string){ try { const u=new URL(url, location.origin); return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || 'download'); } catch { return 'download'; } }
function fileTypeFromUrl(url:string){ const name=fileNameFromUrl(url); const ext=name.includes('.')?name.split('.').slice(1).join('.').toLowerCase():'file'; return ext==='conf'?'WireGuard 配置':ext.toUpperCase(); }
function AttachmentTray({items,onRemove,onOpen}:{items:Attachment[];onRemove:(id:string)=>void;onOpen:(a:Attachment)=>void}){
  const [failedPreviews,setFailedPreviews]=useState<Record<string,boolean>>({});
  return <div className="attachTray">{items.map(a=>{
    const image=isImageAttachment(a) && !failedPreviews[a.id];
    const label=attachmentIconLabel(a);
    const src=a.previewUrl||a.url;
    return <div className={`attachItem ${a.error?'bad':''}`} key={a.id}>
      <button className="attachPreview" type="button" aria-label={image?'预览图片':`${label} 文件`} onClick={()=>image?onOpen(a):undefined}>
        {image&&src?<img src={src} alt={a.name} onError={()=>setFailedPreviews(v=>({...v,[a.id]:true}))}/>:<span className="fileIcon">{label}</span>}
      </button>
      <span className="attachName" title={a.name}>{a.uploading?'上传中':a.error||`${a.name} · ${formatSize(a.size)}`}</span>
      <button className="attachRemove" type="button" aria-label="移除附件" onClick={()=>onRemove(a.id)}>×</button>
    </div>;
  })}</div>;
}
function ImageViewer({image,onClose}:{image:Attachment;onClose:()=>void}){ const toast=useToast(); const src=image.previewUrl||image.url; return <div className="viewer" onClick={onClose}><header><button onClick={onClose}>关闭</button><button onClick={async(e)=>{e.stopPropagation(); try{await navigator.clipboard.writeText(src); toast('success','已复制链接');}catch{toast('error','复制失败')}}}>复制链接</button><a href={src} download target="_blank" rel="noreferrer">保存</a></header><img src={src} alt={image.name}/></div>; }
function DiffPanel({diff,onClose}:{diff:string;onClose:()=>void}){ return <section className="diff"><header><b>Diff</b><button onClick={onClose}>关闭</button></header><pre>{diff}</pre></section>; }
function QuotaSheet({quota,onRefresh,onClose}:{quota:any;onRefresh:()=>void;onClose:()=>void}){
  const providerStatus = quota?.providerStatus as ProviderStatus|undefined;
  const account=providerStatus?.accountSummary || providerStatus?.account || quota?.account?.account || quota?.account;
  const limit=quota?.rateLimits?.rateLimitsByLimitId?.codex || quota?.rateLimits?.rateLimits;
  const email = findDeepEmail(account);
  const unsupported = quota?.supported === false;
  const isAntigravity = quota?.providerId === 'antigravity';
  return <Sheet onClose={onClose} title="额度" subtitle={quota?.checkedAt?new Date(quota.checkedAt).toLocaleString():'读取中'} actions={<button onClick={onRefresh}>刷新</button>}>
    <div className="quotaGrid">
      <div className="quotaAccount"><b>账号</b><span>{email || account?.name || account?.type || '未返回账号'}{account?.planType?` · ${account.planType}`:''}</span></div>
      {quota?.rateLimits?.usageText&&<div className="quotaAccount usageText"><b>Antigravity Usage</b><pre>{quota.rateLimits.usageText}</pre></div>}
      {unsupported ? <div className="quotaAccount"><b>额度</b><span>{quota?.message || '当前 CLI 暂未提供稳定的实时额度接口'}</span></div> : limit ? <>
        <QuotaBar title={quotaWindowTitle(limit.primary)} limitWindow={limit.primary}/>
        {limit.secondary&&<QuotaBar title={quotaWindowTitle(limit.secondary)} limitWindow={limit.secondary}/>}
        <div className="quotaAccount"><b>Credits</b><span>{limit.credits?.unlimited?'不限':limit.credits?.balance?`余额 ${limit.credits.balance}`:limit.credits?.hasCredits?'可用':'0'}</span></div>
      </> : !isAntigravity && <div><b>额度</b><span>没有返回额度数据</span></div>}
      {isAntigravity&&!quota?.rateLimits?.usageText&&<div className="quotaAccount"><b>Antigravity Usage</b><span>{quota?.errors?.rateLimits || 'Google CLI 暂未暴露可读取额度'}</span></div>}
    </div>
    {!unsupported&&(quota?.errors?.account||quota?.errors?.rateLimits)&&<pre className="errorText">{[quota?.errors?.account,quota?.errors?.rateLimits].filter(Boolean).join('\n')}</pre>}
  </Sheet>;
}
function findDeepEmail(value:any):string|null{
  if(!value) return null;
  if(typeof value==='string') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
  if(Array.isArray(value)){ for(const x of value){ const found=findDeepEmail(x); if(found) return found; } return null; }
  if(typeof value==='object'){ for(const key of ['email','email_address','account_email','login']){ const found=findDeepEmail(value[key]); if(found) return found; } for(const x of Object.values(value)){ const found=findDeepEmail(x); if(found) return found; } }
  return null;
}
type SettingsBoundaryProps = { children:React.ReactNode; onClose:()=>void; resetKey:string };
type SettingsBoundaryState = { error:Error|null };
class SettingsErrorBoundary extends React.Component<SettingsBoundaryProps, SettingsBoundaryState> {
  state:SettingsBoundaryState = { error:null };
  static getDerivedStateFromError(error:Error){ return { error }; }
  componentDidCatch(error:Error, info:React.ErrorInfo){ console.error('SettingsSheet crashed', error, info.componentStack); }
  componentDidUpdate(prev:SettingsBoundaryProps){ if(prev.resetKey!==this.props.resetKey && this.state.error) this.setState({error:null}); }
  render(){
    if(!this.state.error) return this.props.children;
    return <Sheet onClose={this.props.onClose} title="设置出错" subtitle="设置面板遇到错误，应用其余部分仍可继续使用">
      <ErrorState title="设置暂时不可用" detail={shortError(this.state.error)} action="关闭" onAction={this.props.onClose}/>
    </Sheet>;
  }
}
function SettingsSheet({data,loading,error,initialPage,onRetry,onChanged,onClose}:{data:any;loading:boolean;error:string;initialPage?:'main'|'agent';onRetry:()=>void;onChanged:()=>any|Promise<any>;onClose:()=>void}){
  const toast=useToast();
  const [localData,setLocalData]=useState<any>(data);
  const [models,setModels]=useState<any>(null);
  const [loginJob,setLoginJob]=useState<any>(null);
  const [agLoginJob,setAgLoginJob]=useState<any>(null);
  const [geminiLoginJob,setGeminiLoginJob]=useState<any>(null);
  const [claudeLoginJob,setClaudeLoginJob]=useState<any>(null);
  const [geminiAuthProfile,setGeminiAuthProfile]=useState<any>(null);
  const [geminiAuthMethods,setGeminiAuthMethods]=useState<any[]>([]);
  const [geminiApiKey,setGeminiApiKey]=useState('');
  const [claudeProfileType,setClaudeProfileType]=useState<'existing_cli'|'setup_token'|'api_key'>('existing_cli');
  const [claudeSecret,setClaudeSecret]=useState('');
  const [claudeLoginInput,setClaudeLoginInput]=useState('');
  const [claudeName,setClaudeName]=useState('Claude Code Account');
  const [showClaudeAdvanced,setShowClaudeAdvanced]=useState(false);
  const [geminiAuthCode,setGeminiAuthCode]=useState('');
  const [profileDeleteBusy,setProfileDeleteBusy]=useState(false);
  const [profileDeleteError,setProfileDeleteError]=useState('');
  const [geminiDeleteBusy,setGeminiDeleteBusy]=useState(false);
  const [geminiDeleteError,setGeminiDeleteError]=useState('');
  const [claudeDeleteBusy,setClaudeDeleteBusy]=useState(false);
  const [claudeDeleteError,setClaudeDeleteError]=useState('');
  const [antigravityDeleteBusy,setAntigravityDeleteBusy]=useState(false);
  const [antigravityDeleteError,setAntigravityDeleteError]=useState('');
  const [agCode,setAgCode]=useState('');
  const [deleteProfile,setDeleteProfile]=useState<any>(null);
  const [deleteClaudeProfile,setDeleteClaudeProfile]=useState<any>(null);
  const [deleteGeminiProfile,setDeleteGeminiProfile]=useState<any>(null);
  const [deleteAntigravityProfile,setDeleteAntigravityProfile]=useState<any>(null);
  const [page,setPage]=useState<'main'|'agent'|'mode'|'model'|'account'|'geminiMethods'|'geminiGoogle'|'geminiApiKey'|'geminiVertex'>(initialPage || 'main');
  const activeProvider = localData?.settings?.activeProvider || 'codex';
  useEffect(()=>setLocalData((current:any)=>mergeSettingsData(current, data)),[data]);
  useEffect(()=>{ if(page!=='model') return; setModels(null); api('/api/models?provider='+encodeURIComponent(activeProvider)).then(setModels).catch((e:any)=>setModels({models:[], error:shortError(e)})); },[page,activeProvider]);
  async function syncSettings(){ const next=await onChanged(); if(next) setLocalData((current:any)=>mergeSettingsData(current, next)); }
  function markActiveProfile(id:string){
    setLocalData((d:any)=>{
      const profiles = activeFirst((d?.profiles||[]).map((p:any)=>({...p, active:p.id===id?1:0})));
      return {...d, activeProfile:{...(d?.activeProfile||{}), id, active:1}, profiles};
    });
  }
  useEffect(()=>{ if(!loginJob?.id || loginJob.status!=='running') return; const timer=window.setInterval(async()=>{ try{ const r=await api('/api/profile-login/'+loginJob.id); if(r.job.status!=='running'){ window.clearInterval(timer); if(r.job.status==='done') setLoginJob(null); else setLoginJob(r.job); await syncSettings(); const metadataFailed=r.job.status==='done'&&r.job.metadataStatus==='failed'; toast(r.job.status==='done'?(metadataFailed?'info':'success'):'error', r.job.status==='done'?(metadataFailed?'登录完成，账户信息读取失败，可重试':'登录完成'):'登录未完成'); return; } setLoginJob(r.job); }catch{} },1500); return()=>window.clearInterval(timer); },[loginJob?.id,loginJob?.status]);
  useEffect(()=>{ if(!agLoginJob?.id || agLoginJob.status!=='running') return; const timer=window.setInterval(async()=>{ try{ const r=await api('/api/antigravity-login/'+agLoginJob.id); setAgLoginJob(r.job); if(r.job.status!=='running'){ window.clearInterval(timer); await syncSettings(); toast(r.job.status==='done'?'success':'error', r.job.status==='done'?'登录完成':'登录失败'); } }catch{} },1500); return()=>window.clearInterval(timer); },[agLoginJob?.id,agLoginJob?.status]);
  useEffect(()=>{ if(!claudeLoginJob?.id || !['running','waiting_user','verifying'].includes(claudeLoginJob.status)) return; const timer=window.setInterval(async()=>{ try{ const r=await api('/api/claude-login/'+claudeLoginJob.id); setClaudeLoginJob(r.job); if(!['running','waiting_user','verifying'].includes(r.job.status)){ window.clearInterval(timer); await syncSettings(); toast(r.job.status==='done'?'success':r.job.status==='cancelled'?'info':'error', r.job.status==='done'?'登录完成':r.job.status==='cancelled'?'已取消登录':'登录失败'); if(r.job.status==='done') setClaudeLoginJob(null); } }catch{} },1500); return()=>window.clearInterval(timer); },[claudeLoginJob?.id,claudeLoginJob?.status]);
  useEffect(()=>{ if(!geminiLoginJob?.id || !['preparing','waiting_user','verifying'].includes(geminiLoginJob.status)) return; const timer=window.setInterval(async()=>{ try{ const r=await api('/api/gemini-login/'+geminiLoginJob.id); if(r.completed || !['preparing','waiting_user','verifying','failed'].includes(r.job?.status)){ setGeminiLoginJob(null); setGeminiAuthCode(''); window.clearInterval(timer); await syncSettings(); setPage('account'); if(r.job?.status==='done') toast('success','登录完成'); return; } setGeminiLoginJob(r.job); }catch{} },1500); return()=>window.clearInterval(timer); },[geminiLoginJob?.id,geminiLoginJob?.status]);
  useEffect(()=>{
    const running = (localData?.providerInstallJobs||[]).some((j:ProviderInstallJob)=>['queued','downloading','installing','verifying'].includes(j.status));
    if(!running) return;
    const timer=window.setInterval(()=>syncSettings().catch(()=>{}),1500);
    return()=>window.clearInterval(timer);
  },[localData?.providerInstallJobs]);
  useEffect(()=>{ const active = (localData?.geminiProfiles||[]).find((p:any)=>p.active) || localData?.activeGeminiProfile; if(active?.status==='authenticated' && geminiLoginJob){ setGeminiLoginJob(null); setGeminiAuthCode(''); if(['geminiGoogle','geminiApiKey','geminiVertex'].includes(page)) setPage('account'); } },[localData?.activeGeminiProfile?.id,localData?.activeGeminiProfile?.status,localData?.geminiProfiles,geminiLoginJob?.id,page]);
  async function setActiveProvider(provider:string){ setLocalData((d:any)=>({...d,settings:{...(d?.settings||{}),activeProvider:provider}})); try{ await api('/api/settings',{method:'PATCH',body:JSON.stringify({activeProvider:provider})}); haptic(); toast('success','Agent 已切换'); syncSettings().catch(()=>{}); } catch(e:any){ toast('error','切换失败：'+shortError(e)); await syncSettings().catch(()=>{}); } }
  async function startProviderInstall(provider:ProviderId){ try{ const r=await api(`/api/providers/${provider}/install`,{method:'POST',body:JSON.stringify({action:'install'})}); setLocalData((d:any)=>({...d,providerInstallJobs:[r.job,...(d?.providerInstallJobs||[]).filter((j:any)=>j.id!==r.job.id)]})); toast('info','安装任务已启动'); } catch(e:any){ toast('error','安装启动失败：'+shortError(e)); } }
  async function cancelProviderInstall(job:ProviderInstallJob){ try{ const r=await api('/api/provider-install/'+job.id,{method:'DELETE'}); setLocalData((d:any)=>({...d,providerInstallJobs:(d?.providerInstallJobs||[]).map((j:any)=>j.id===job.id?r.job:j)})); toast('info','安装已取消'); await syncSettings(); } catch(e:any){ toast('error','取消失败：'+shortError(e)); } }
  async function setDefaultMode(mode:string){ try{ await api('/api/settings',{method:'PATCH',body:JSON.stringify({defaultMode:mode})}); haptic(); toast('success','已更新'); await syncSettings(); } catch(e:any){ toast('error','更新失败：'+shortError(e)); } }
  async function setDefaultModel(model:string){ try{ await api('/api/settings',{method:'PATCH',body:JSON.stringify({defaultModel:model,provider:activeProvider})}); setLocalData((d:any)=>({...d,settings:{...(d?.settings||{}),defaultModel:model,defaultModels:{...(d?.settings?.defaultModels||{}),[activeProvider]:model}}})); haptic(); toast('success','模型已更新'); await syncSettings(); } catch(e:any){ toast('error','更新失败：'+shortError(e)); } }
  const currentSessionId = String(location.hash || '').match(/^#\/s\/([^/?#]+)/)?.[1] || '';
  async function applyCurrentSessionModel(model:string){ if(!currentSessionId){ toast('info','当前没有打开的会话'); return; } try{ await api('/api/sessions/'+encodeURIComponent(currentSessionId),{method:'PATCH',body:JSON.stringify({model})}); haptic(); toast('success','已应用到当前会话'); } catch(e:any){ toast('error','应用失败：'+shortError(e)); } }
  async function saveDefaultAndApply(model:string){ await setDefaultModel(model); if(currentSessionId) await applyCurrentSessionModel(model); }
  async function switchProfile(id:string){ try{ await api(`/api/profiles/${id}/switch`,{method:'POST'}); markActiveProfile(id); haptic(); toast('success','切换成功'); } catch(e:any){ toast('error','切换失败：'+shortError(e)); } finally { await syncSettings(); } }
  async function createClaudeProfile(){ try{ const body:any={name:claudeName,type:claudeProfileType}; if(claudeProfileType==='setup_token') body.token=claudeSecret; if(claudeProfileType==='api_key') body.apiKey=claudeSecret; await api('/api/claude/profiles',{method:'POST',body:JSON.stringify(body)}); setClaudeSecret(''); haptic(); toast('success','Claude profile 已添加'); await syncSettings(); } catch(e:any){ toast('error','添加失败：'+shortError(e)); } }
  async function loginClaudeCli(profile?:any){ try{ const r=await api('/api/claude/profiles/login',{method:'POST',body:JSON.stringify({profileId:profile?.id,name:profile?.name||'Claude Code Account'})}); setClaudeLoginJob(r.job); setClaudeLoginInput(''); toast('info','Claude CLI 登录已启动'); await syncSettings(); } catch(e:any){ toast('error','登录启动失败：'+shortError(e)); } }
  async function submitClaudeLoginInput(){ if(!claudeLoginJob?.id || !claudeLoginInput.trim()) return; try{ await api('/api/claude-login/'+claudeLoginJob.id+'/input',{method:'POST',body:JSON.stringify({text:claudeLoginInput.trim()})}); setClaudeLoginInput(''); toast('info','已提交，正在等待 Claude CLI'); } catch(e:any){ toast('error','提交失败：'+shortError(e)); } }
  async function cancelClaudeLogin(){ if(!claudeLoginJob?.id) return; try{ await api('/api/claude-login/'+claudeLoginJob.id,{method:'DELETE'}); setClaudeLoginJob(null); setClaudeLoginInput(''); toast('info','已取消登录'); await syncSettings(); } catch(e:any){ toast('error','取消失败：'+shortError(e)); } }
  async function switchClaudeProfile(id:string){ try{ await api(`/api/claude/profiles/${id}/switch`,{method:'POST'}); haptic(); toast('success','切换成功'); await syncSettings(); } catch(e:any){ toast('error','切换失败：'+shortError(e)); } }
  async function logoutClaudeProfile(profile:any){ try{ await api(`/api/claude/profiles/${profile.id}/logout`,{method:'POST'}); haptic(); toast('success','已退出登录'); await syncSettings(); } catch(e:any){ toast('error','退出失败：'+shortError(e)); } }
  async function removeClaudeProfile(profile:any){ setClaudeDeleteBusy(true); setClaudeDeleteError(''); try{ await api(`/api/claude/profiles/${profile.id}`,{method:'DELETE'}); haptic(); toast('success','账户已删除'); setDeleteClaudeProfile(null); await syncSettings(); } catch(e:any){ const msg=shortError(e); setClaudeDeleteError(msg); toast('error','删除失败：'+msg); } finally { setClaudeDeleteBusy(false); } }
  async function refreshCodexMetadata(id:string){ try{ const result=await api(`/api/profiles/${id}/metadata/refresh`,{method:'POST'}); await syncSettings(); toast(result.ok?'success':'error',result.ok?'账户信息已更新':'账户信息读取失败，可重试'); } catch(e:any){ toast('error','账户信息读取失败：'+shortError(e)); await syncSettings().catch(()=>{}); } }
  async function deviceLogin(id:string, isNew=false){ try{ const r=await api(`/api/profiles/${id}/login/device`,{method:'POST',body:JSON.stringify({newProfile:isNew})}); setLoginJob(r.job); toast('info','登录流程已启动'); } catch(e:any){ toast('error','登录启动失败：'+shortError(e)); } }
  async function loginNewProfile(){ try{ const r=await api('/api/profiles',{method:'POST',body:JSON.stringify({name:'Codex Account'})}); await deviceLogin(r.profile.id, true); } catch(e:any){ toast('error','登录启动失败：'+shortError(e)); } }
  async function loginAntigravity(){ try{ const r=await api('/api/antigravity/profiles/login',{method:'POST'}); setAgLoginJob(r.job); setAgCode(''); toast('info','Antigravity 登录已启动'); } catch(e:any){ toast('error','登录启动失败：'+shortError(e)); } }
  async function submitAntigravityCode(){ if(!agLoginJob?.id || !agCode.trim()) return; try{ const r=await api('/api/antigravity-login/'+agLoginJob.id+'/input',{method:'POST',body:JSON.stringify({code:agCode.trim()})}); setAgLoginJob((job:any)=>({...job,...(r.job||{}), codeSubmitted:true})); setAgCode(''); toast('info','授权码已提交，正在确认登录'); } catch(e:any){ toast('error','提交失败：'+shortError(e)); } }
  async function cancelAntigravityLogin(){ if(!agLoginJob?.id) return; try{ await api('/api/antigravity-login/'+agLoginJob.id+'/cancel',{method:'POST'}); setAgLoginJob(null); setAgCode(''); toast('info','已取消登录'); await syncSettings(); } catch(e:any){ toast('error','取消失败：'+shortError(e)); } }
  async function loginNewGeminiProfile(){ try{ const r=await api('/api/gemini/profiles',{method:'POST',body:JSON.stringify({name:'Gemini Account'})}); await openGeminiLogin(r.profile); } catch(e:any){ toast('error','创建 Gemini 账户失败：'+shortError(e)); } }
  async function openGeminiLogin(profile:any){
    if((profile?.state||profile?.status)==='authenticated'){ setGeminiLoginJob(null); setGeminiAuthCode(''); setPage('account'); return; }
    setGeminiAuthProfile(profile);
    setGeminiAuthMethods(loginMethodViews([]));
    setGeminiApiKey('');
    setGeminiAuthCode('');
    setPage('geminiMethods');
    if(profile?.loginJobId){ try{ const r=await api('/api/gemini-login/'+profile.loginJobId); if(r.completed || r.job?.status==='done'){ setGeminiLoginJob(null); setGeminiAuthCode(''); setPage('account'); await syncSettings(); return; } setGeminiLoginJob(r.job); setPage('geminiGoogle'); }catch{} }
    try{
      const r=await api(`/api/gemini/profiles/${profile.id}/refresh`,{method:'POST'});
      setGeminiAuthProfile(r.profile || profile);
      setGeminiAuthMethods(loginMethodViews(r.runtime?.authMethods || []));
    } catch(e:any){
      toast('error','读取登录方式失败：'+shortError(e));
    }
  }
  async function startGeminiLogin(methodId:string){ if(!geminiAuthProfile?.id) return; try{ const body:any={methodId}; if(methodId==='api_key' || methodId.toLowerCase().includes('api')) body.apiKey=geminiApiKey; const r=await api(`/api/gemini/profiles/${geminiAuthProfile.id}/login`,{method:'POST',body:JSON.stringify(body)}); setGeminiLoginJob(r.job); setGeminiApiKey(''); setGeminiAuthCode(''); toast('info','Gemini 登录已启动'); } catch(e:any){ toast('error','登录启动失败：'+shortError(e)); } }
  async function submitGeminiAuthCode(){ if(!geminiLoginJob?.id || !geminiAuthCode.trim()) return; try{ const r=await api('/api/gemini-login/'+geminiLoginJob.id+'/input',{method:'POST',body:JSON.stringify({code:geminiAuthCode.trim()})}); setGeminiLoginJob((job:any)=>({...job,...(r.job||{}),codeSubmitted:true})); setGeminiAuthCode(''); toast('info','授权码已提交，正在确认登录'); } catch(e:any){ toast('error','提交失败：'+shortError(e)); } }
  async function cancelGeminiLogin(){ if(!geminiLoginJob?.id) return; try{ const r=await api('/api/gemini-login/'+geminiLoginJob.id+'/cancel',{method:'POST'}); setGeminiLoginJob(r.job); toast('info','已取消登录'); } catch(e:any){ toast('error','取消失败：'+shortError(e)); } }
  async function switchGeminiProfile(id:string){ try{ await api(`/api/gemini/profiles/${id}/switch`,{method:'POST'}); haptic(); toast('success','切换成功'); await syncSettings(); } catch(e:any){ toast('error','切换失败：'+shortError(e)); } }
  async function logoutGeminiProfile(profile:any){ try{ await api(`/api/gemini/profiles/${profile.id}/logout`,{method:'POST'}); haptic(); toast('success','已退出登录'); await syncSettings(); } catch(e:any){ toast('error','退出失败：'+shortError(e)); } }
  async function removeGeminiProfile(profile:any){ setGeminiDeleteBusy(true); setGeminiDeleteError(''); try{ await api(`/api/gemini/profiles/${profile.id}`,{method:'DELETE'}); haptic(); toast('success','账户已删除'); setDeleteGeminiProfile(null); await syncSettings(); } catch(e:any){ const msg=shortError(e); setGeminiDeleteError(msg); toast('error','删除失败：'+msg); } finally { setGeminiDeleteBusy(false); } }
  async function switchAntigravityProfile(id:string){ try{ await api(`/api/antigravity/profiles/${id}/switch`,{method:'POST'}); haptic(); toast('success','切换成功'); await syncSettings(); } catch(e:any){ toast('error','切换失败：'+shortError(e)); } }
  async function removeAntigravityProfile(profile:any){ setAntigravityDeleteBusy(true); setAntigravityDeleteError(''); try{ await api(`/api/antigravity/profiles/${profile.id}`,{method:'DELETE'}); haptic(); toast('success','账户已删除'); setDeleteAntigravityProfile(null); await syncSettings(); } catch(e:any){ const msg=shortError(e); setAntigravityDeleteError(msg); toast('error','删除失败：'+msg); } finally { setAntigravityDeleteBusy(false); } }
  async function removeProfile(profile:any){ setProfileDeleteBusy(true); setProfileDeleteError(''); try{ await api(`/api/profiles/${profile.id}`,{method:'DELETE'}); haptic(); toast('success','账户已删除'); setDeleteProfile(null); await syncSettings(); } catch(e:any){ const msg=shortError(e); setProfileDeleteError(msg); toast('error','删除失败：'+msg); } finally { setProfileDeleteBusy(false); } }
  const currentModel = localData?.settings?.defaultModels ? (localData.settings.defaultModels[activeProvider] || catalogCurrent(models)) : (localData?.settings?.defaultModel || catalogCurrent(models));
  const activeProfile = (localData?.profiles||[]).find((p:any)=>p.active) || localData?.activeProfile;
  const activeClaudeProfile = (localData?.claudeProfiles||[]).find((p:any)=>p.active) || localData?.activeClaudeProfile;
  const activeGeminiProfile = (localData?.geminiProfiles||[]).find((p:any)=>p.active) || localData?.activeGeminiProfile;
  const activeAntigravityProfile = (localData?.antigravityProfiles||[]).find((p:any)=>p.active) || localData?.activeAntigravityProfile;
  const codexProfiles = (localData?.profiles?.length ? localData.profiles : (localData?.activeProfile ? [localData.activeProfile] : []));
  const claudeProfiles = (localData?.claudeProfiles?.length ? localData.claudeProfiles : (localData?.activeClaudeProfile ? [localData.activeClaudeProfile] : []));
  const codexPendingProfiles = (localData?.pendingProfiles||[]).filter((p:any)=>['draft','authenticating','verifying','failed'].includes(String(p.state||p.status||'')));
  const geminiProfiles = (localData?.geminiProfiles?.length ? localData.geminiProfiles : (localData?.activeGeminiProfile ? [localData.activeGeminiProfile] : [])).filter((p:any)=>(p.state||p.status)==='authenticated');
  const geminiPendingProfiles = (localData?.geminiPendingProfiles||[]).filter((p:any)=>['draft','authenticating','verifying','failed','needs_login'].includes(String(p.state||p.status||'')));
  const codexProviderStatus = (localData?.providers||[]).find((p:any)=>p.id==='codex');
  const claudeProviderStatus = (localData?.providers||[]).find((p:any)=>p.id==='claude') || localData?.claude;
  const geminiProviderStatus = (localData?.providers||[]).find((p:any)=>p.id==='gemini') || localData?.gemini;
  const antigravityProviderStatus = (localData?.providers||[]).find((p:any)=>p.id==='antigravity') || localData?.antigravity;
  const activeProviderStatus = (localData?.providers||[]).find((p:any)=>p.id===activeProvider) || (activeProvider==='claude' ? claudeProviderStatus : activeProvider==='gemini' ? geminiProviderStatus : activeProvider==='antigravity' ? antigravityProviderStatus : codexProviderStatus);
  const activeInstaller:ProviderInstaller|undefined = localData?.providerInstallers?.[activeProvider];
  const activeInstallJob:ProviderInstallJob|undefined = (localData?.providerInstallJobs||[]).find((j:ProviderInstallJob)=>j.provider===activeProvider && !['succeeded','failed','cancelled'].includes(j.status)) || activeInstaller?.latestJob || (localData?.providerInstallJobs||[]).find((j:ProviderInstallJob)=>j.provider===activeProvider);
  const title = page==='main' ? '设置' : page==='agent' ? 'Agent' : page==='mode' ? '沙盒' : page==='model' ? '模型' : page==='geminiMethods' ? '选择登录方式' : page==='geminiGoogle' ? 'Google 登录' : page==='geminiApiKey' ? 'Gemini API Key' : page==='geminiVertex' ? 'Vertex AI' : `${providerLabel(activeProvider)} 账户`;
  const subtitle = page==='main' ? '会话行为和账户' : page==='agent' ? undefined : page==='mode' ? modeLabel(localData?.settings?.defaultMode) : page==='model' ? (activeProviderStatus?.canListModels?`${providerLabel(activeProvider)} 模型`:providerAuthLabel(activeProviderStatus)) : accountSubtitle(activeProvider, activeProfile, activeGeminiProfile, activeAntigravityProfile, activeProviderStatus);
  const providerStatusById:any = { codex:codexProviderStatus, claude:claudeProviderStatus, antigravity:antigravityProviderStatus, gemini:geminiProviderStatus };
  const goBack = () => setPage(page==='geminiMethods'?'account':(['geminiGoogle','geminiApiKey','geminiVertex'].includes(page)?'geminiMethods':'main') as any);
  return <Sheet onClose={onClose} title={title} subtitle={subtitle} actions={page!=='main'?<button className="settingsBack" onClick={goBack}>返回</button>:undefined}>
    {error&&<ErrorState title="设置读取失败" detail={error} action="重试" onAction={onRetry}/>}
    {loading&&!localData&&<LoadingRows count={4}/>}
    {localData&&<div className="settingsGrid">
      {page==='main'&&<div className="settingsNav">
        <button onClick={()=>setPage('agent')}><span><b>Agent</b><small>{providerSubtitle(activeProviderStatus)}</small></span><i>›</i></button>
        <button onClick={()=>setPage('mode')}><span><b>沙盒</b><small>{modeLabel(localData?.settings?.defaultMode)}</small></span><i>›</i></button>
        <button onClick={()=>setPage('model')}><span><b>模型</b><small>{activeProviderStatus?.canListModels ? modelLabel(currentModel) : providerAuthLabel(activeProviderStatus)}</small></span><i>›</i></button>
        <button onClick={()=>setPage('account')}><span><b>当前账户</b><small>{accountSubtitle(activeProvider, activeProfile, activeGeminiProfile, activeAntigravityProfile, activeProviderStatus)}</small></span><i>›</i></button>
      </div>}
      {page==='agent'&&<section className="agentProviderPage"><div className="providerChoices">
        {PROVIDER_ORDER.map(provider=><button key={provider} className={activeProvider===provider?'active':''} aria-pressed={activeProvider===provider} onClick={()=>setActiveProvider(provider)}><span><b>{providerLabel(provider)}</b><small>{providerChoiceDetail(providerStatusById[provider])}</small>{providerChoiceNote(providerStatusById[provider])&&<em>{providerChoiceNote(providerStatusById[provider])}</em>}</span><i/></button>)}
      </div></section>}
      {page==='mode'&&<section><b>沙盒</b><ModeButtons value={localData?.settings?.defaultMode || 'yolo'} onPick={setDefaultMode}/></section>}
      {page==='model'&&<section><b>模型</b>{activeProvider==='gemini'&&<GeminiModelSummary defaultModel={currentModel} currentSessionId={currentSessionId} currentModel={models?.current || currentModel}/>} {models?.error&&<InlineNotice tone="info" text={models.error}/>} {activeProviderStatus?.reasonCode==='gemini_client_unsupported'&&<InlineNotice tone="info" text={activeProviderStatus.message || '个人版 Gemini CLI 客户端已停止支持'}/>}<ModelPicker models={models?.models||[]} value={currentModel} emptyText={models?.error || (models ? '没有可用模型' : `正在读取 ${providerLabel(activeProvider)} 模型列表`)} onPick={setDefaultModel}/>{activeProvider==='gemini'&&<div className="modelActions"><button disabled={!currentSessionId || activeProviderStatus?.reasonCode==='gemini_client_unsupported'} onClick={()=>applyCurrentSessionModel(currentModel)}>仅应用到当前会话</button><button disabled={activeProviderStatus?.reasonCode==='gemini_client_unsupported'} onClick={()=>saveDefaultAndApply(currentModel)}>保存为默认并应用到当前会话</button></div>}</section>}
      {page==='account'&&<ProviderInstallPanel provider={activeProvider} status={activeProviderStatus} installer={activeInstaller} job={activeInstallJob} onInstall={()=>startProviderInstall(activeProvider)} onCancel={cancelProviderInstall}/>}
      {page==='account'&&activeProvider==='codex'&&<><CurrentAccountSummary provider="codex" profile={activeProfile} status={activeProviderStatus}/><section><b>已保存账户</b><div className="profileList">{codexProfiles.map((p:any)=><ProfileRow key={p.id} profile={p} label={profileLabel(p)} onSwitch={switchProfile} onLogin={deviceLogin} onRefreshMetadata={refreshCodexMetadata} onDelete={setDeleteProfile}/>)}{!codexProfiles.length&&<div className="empty"><b>尚未添加 Codex 账户</b><span>登录后才能创建 Codex 会话。</span></div>}</div></section>{!!codexPendingProfiles.length&&<section><b>登录中的任务</b><div className="profileList">{codexPendingProfiles.map((p:any)=><PendingProfileRow key={p.id} profile={p} label={pendingLoginTitle('codex', p)} onContinue={()=>deviceLogin(p.id)} onDelete={(p:any)=>{setProfileDeleteError('');setDeleteProfile(p)}}/>)}</div></section>}<section><b>添加账户</b><button disabled={!activeProviderStatus?.installed} onClick={loginNewProfile}>登录新账户</button></section>{loginJob&&loginJob.status!=='done'&&<LoginJobPanel job={loginJob}/>}</>}
      {page==='account'&&activeProvider==='claude'&&<><CurrentAccountSummary provider="claude" profile={activeClaudeProfile} status={activeProviderStatus}/><section><b>Claude CLI 登录</b><button disabled={activeProviderStatus?.availability==='unavailable' || ['running','waiting_user','verifying'].includes(String(claudeLoginJob?.status||''))} onClick={()=>loginClaudeCli(activeClaudeProfile)}>使用 Claude CLI 登录</button>{activeProviderStatus?.availability==='unavailable'&&<div className="empty"><b>Claude Code CLI 不可用</b><span>{activeProviderStatus?.message || '安装 Claude Code CLI 后才能登录。'}</span></div>}{claudeLoginJob&&<ClaudeLoginJobPanel job={claudeLoginJob} input={claudeLoginInput} onInput={setClaudeLoginInput} onSubmitInput={submitClaudeLoginInput} onCancel={cancelClaudeLogin}/>}</section><section><b>已保存账户</b><div className="profileList">{claudeProfiles.map((p:any)=><ClaudeProfileRow key={p.id} profile={p} onSwitch={switchClaudeProfile} onLogin={loginClaudeCli} onLogout={logoutClaudeProfile} onDelete={(p:any)=>{setClaudeDeleteError('');setDeleteClaudeProfile(p)}}/>)}{!claudeProfiles.length&&<div className="empty"><b>尚未添加 Claude Code profile</b><span>使用 Claude CLI 登录后才能创建 Claude 会话。</span></div>}</div></section><details className="advancedLogin" open={showClaudeAdvanced} onToggle={e=>setShowClaudeAdvanced(e.currentTarget.open)}><summary>其他登录方式</summary><ClaudeProfileForm type={claudeProfileType} name={claudeName} secret={claudeSecret} onType={setClaudeProfileType} onName={setClaudeName} onSecret={setClaudeSecret} onSubmit={createClaudeProfile}/></details></>}
      {page==='account'&&activeProvider==='gemini'&&<><CurrentAccountSummary provider="gemini" profile={activeGeminiProfile} status={activeProviderStatus}/><section><b>已保存账户</b><div className="profileList">{geminiProfiles.map((p:any)=><ProfileRow key={p.id} profile={p} label={geminiProfileLabel(p)} onSwitch={switchGeminiProfile} onLogin={()=>openGeminiLogin(p)} onLogout={logoutGeminiProfile} onDelete={(p:any)=>{setGeminiDeleteError('');setDeleteGeminiProfile(p)}}/>)}{!geminiProfiles.length&&<div className="empty"><b>尚未添加 Gemini 账户</b><span>添加账户后才能创建 Gemini 会话。</span></div>}</div></section>{!!geminiPendingProfiles.length&&<section><b>登录中的任务</b><div className="profileList">{geminiPendingProfiles.map((p:any)=><PendingProfileRow key={p.id} profile={p} label={pendingLoginTitle('gemini', p)} onContinue={()=>openGeminiLogin(p)} onDelete={(p:any)=>{setGeminiDeleteError('');setDeleteGeminiProfile(p)}}/>)}</div></section>}<section><b>添加账户</b><button disabled={activeProviderStatus?.availability==='unavailable'} onClick={loginNewGeminiProfile}>登录新账户</button>{activeProviderStatus?.availability==='unavailable'&&<div className="empty"><b>Gemini 服务不可用</b><span>{activeProviderStatus?.message || '安装 Gemini CLI 后才能登录。'}</span></div>}</section>{geminiLoginJob&&['preparing','waiting_user','verifying','failed'].includes(geminiLoginJob.status)&&<GeminiLoginJobPanel job={geminiLoginJob} onCancel={cancelGeminiLogin}/>}</>}
      {page==='geminiMethods'&&<GeminiMethodList methods={geminiAuthMethods} onPick={(m:any)=>{ setGeminiAuthMethods((list:any[])=>list.map(x=>({...x,selected:x.id===m.id}))); setPage(m.kind==='oauth'?'geminiGoogle':m.kind==='api-key'?'geminiApiKey':m.kind==='vertex'?'geminiVertex':'geminiMethods'); }}/>}
      {page==='geminiGoogle'&&<GeminiGoogleLogin profile={geminiAuthProfile} job={geminiLoginJob} code={geminiAuthCode} onCode={setGeminiAuthCode} onStart={()=>startGeminiLogin((geminiAuthMethods.find((m:any)=>m.selected&&m.kind==='oauth')||geminiAuthMethods.find((m:any)=>m.kind==='oauth'))?.methodId || 'oauth')} onSubmitCode={submitGeminiAuthCode} onCancel={cancelGeminiLogin} onRefresh={syncSettings}/>}
      {page==='geminiApiKey'&&<GeminiApiKeyLogin apiKey={geminiApiKey} onApiKey={setGeminiApiKey} job={geminiLoginJob} onSubmit={()=>startGeminiLogin((geminiAuthMethods.find((m:any)=>m.selected&&m.kind==='api-key')||geminiAuthMethods.find((m:any)=>m.kind==='api-key'))?.methodId || 'api_key')}/>}
      {page==='geminiVertex'&&<GeminiVertexLogin/>}
      {page==='account'&&activeProvider==='antigravity'&&<><CurrentAccountSummary provider="antigravity" profile={activeAntigravityProfile} status={activeProviderStatus}/><section><b>已保存账户</b><div className="profileList">{(localData?.antigravityProfiles||[]).map((p:any)=><AntigravityProfileRow key={p.id} profile={p} onSwitch={switchAntigravityProfile} onDelete={(p:any)=>{setAntigravityDeleteError('');setDeleteAntigravityProfile(p)}}/>)}{!(localData?.antigravityProfiles||[]).length&&<div className="empty"><b>尚未添加 Antigravity 账户</b><span>登录后才能创建 Antigravity 会话。</span></div>}</div><button disabled={activeProviderStatus?.availability==='unavailable' || agLoginJob?.status==='running'} onClick={loginAntigravity}>登录新 Google 账户</button>{activeProviderStatus?.availability==='unavailable'&&<div className="empty"><b>Antigravity 服务不可用</b><span>{activeProviderStatus?.message || '安装后才能登录 Google 账户。'}</span></div>}{agLoginJob&&<AntigravityLoginPanel job={agLoginJob} code={agCode} onCode={setAgCode} onSubmit={submitAntigravityCode} onCancel={cancelAntigravityLogin}/>}</section></>}
    </div>}
    {deleteProfile&&<ConfirmDialog title={deleteProfile.isLoginAttempt?'取消登录？':'删除 Codex 账户？'} detail={deleteProfile.isLoginAttempt?cancelLoginDetail():deleteAccountDetail(activeAccountCount(codexProfiles)<=1)} cancel={deleteProfile.isLoginAttempt?'继续登录':'取消'} confirm={deleteProfile.isLoginAttempt?'取消登录':'删除账户'} busy={profileDeleteBusy} error={profileDeleteError} onCancel={()=>!profileDeleteBusy&&setDeleteProfile(null)} onConfirm={()=>removeProfile(deleteProfile)}/>}
    {deleteClaudeProfile&&<ConfirmDialog title="删除 Claude Code profile？" detail={deleteAccountDetail(activeAccountCount(claudeProfiles)<=1)} confirm="删除账户" busy={claudeDeleteBusy} error={claudeDeleteError} onCancel={()=>!claudeDeleteBusy&&setDeleteClaudeProfile(null)} onConfirm={()=>removeClaudeProfile(deleteClaudeProfile)}/>}
    {deleteGeminiProfile&&<ConfirmDialog title={deleteGeminiProfile.isLoginAttempt?'取消登录？':'删除 Gemini 账户？'} detail={deleteGeminiProfile.isLoginAttempt?cancelLoginDetail():deleteAccountDetail(activeAccountCount(geminiProfiles)<=1)} cancel={deleteGeminiProfile.isLoginAttempt?'继续登录':'取消'} confirm={deleteGeminiProfile.isLoginAttempt?'取消登录':'删除账户'} busy={geminiDeleteBusy} error={geminiDeleteError} onCancel={()=>!geminiDeleteBusy&&setDeleteGeminiProfile(null)} onConfirm={()=>removeGeminiProfile(deleteGeminiProfile)}/>}
    {deleteAntigravityProfile&&<ConfirmDialog title="删除 Antigravity 账户？" detail={deleteAccountDetail(activeAccountCount(localData?.antigravityProfiles||[])<=1)} confirm="删除账户" busy={antigravityDeleteBusy} error={antigravityDeleteError} onCancel={()=>!antigravityDeleteBusy&&setDeleteAntigravityProfile(null)} onConfirm={()=>removeAntigravityProfile(deleteAntigravityProfile)}/>}
  </Sheet>;
}
function mergeSettingsData(current:any, next:any){
  if(!current) return next;
  const merged:any = {...next};
  for(const key of ['profiles','geminiProfiles','geminiPendingProfiles','antigravityProfiles']){
    if(!current?.[key]?.length || !next?.[key]?.length) continue;
    const byId = new Map(next[key].map((p:any)=>[p.id,p]));
    const ordered = current[key].map((p:any)=>byId.get(p.id)).filter(Boolean);
    for(const p of next[key]) if(!current[key].some((x:any)=>x.id===p.id)) ordered.push(p);
    merged[key]=activeFirst(ordered);
  }
  return merged;
}
function activeFirst(profiles:any[]){ return [...profiles].sort((a:any,b:any)=>Number(b.active || 0)-Number(a.active || 0)); }
function CurrentAccountSummary({provider,profile,status}:{provider:ProviderId;profile:any;status?:ProviderStatus|null}){
  const summary = currentAccountSummary(provider, profile, status);
  return <section><b>{providerLabel(provider)} 账户</b><div className="currentAccountCard"><strong>{summary.primary}</strong>{summary.secondary&&<span>{summary.secondary}</span>}</div></section>;
}
function ProviderInstallPanel({provider,status,installer,job,onInstall,onCancel}:{provider:ProviderId;status?:ProviderStatus|null;installer?:ProviderInstaller;job?:ProviderInstallJob;onInstall:()=>void;onCancel:(job:ProviderInstallJob)=>void}){
  if(!installer) return null;
  const running=!!job&&['queued','downloading','installing','verifying'].includes(job.status);
  const failed=!!job&&job.status==='failed';
  if(status?.installed && !running && !failed) return null;
  return <section>
    <b>{providerLabel(provider)} CLI</b>
    {!status?.installed&&!running&&<div className="empty"><b>未安装</b><span>{status?.message || `${providerLabel(provider)} CLI 不可用`}</span></div>}
    {running&&<div className="empty"><b>正在安装 {providerLabel(provider)}……</b><span>{job?.status || 'installing'}</span></div>}
    {failed&&<InlineNotice tone="error" text={job?.error || '安装失败'}/>}
    <div className="modeButtons">
      {installer.automatic&&<button disabled={running} onClick={onInstall}>{failed?'重新安装':'安装'}</button>}
      {running&&job&&<button onClick={()=>onCancel(job)}>取消</button>}
    </div>
    <details className="loginLog"><summary>手动安装方法</summary><pre>{installer.manual}</pre></details>
    {job&&<details className="loginLog" open={running||failed}><summary>查看日志</summary><pre>{(job.output||[]).join('\n') || job.status}</pre></details>}
  </section>;
}
function ProfileRow({profile,label,onSwitch,onLogin,onLogout,onRefreshMetadata,onDelete}:{profile:any;label:string;onSwitch:(id:string)=>void;onLogin:(id:string)=>void;onLogout?:(p:any)=>void;onRefreshMetadata?:(id:string)=>void;onDelete:(p:any)=>void}){
  const loggedIn = !!profile.login?.ok;
  const active = !!profile.active;
  return <div className="profileRow">
    <div><strong>{label}</strong><span className="profileBadges">{active&&<i>当前</i>}<i>{loggedIn?'已登录':'未登录'}</i>{profile.authType&&<i>{authTypeLabel(profile.authType)}</i>}{profile.login?.email&&<em>{profile.login.email}</em>}</span></div>
    {!active&&loggedIn&&<button onClick={()=>onSwitch(profile.id)}>切换</button>}
    {!loggedIn&&<button onClick={()=>onLogin(profile.id)}>登录</button>}
    {loggedIn&&String(profile.metadataStatus||profile.metadata_status||'')==='failed'&&onRefreshMetadata&&<button onClick={()=>onRefreshMetadata(profile.id)}>重试读取</button>}
    {loggedIn&&onLogout&&<button onClick={()=>onLogout(profile)}>退出登录</button>}
    <button className="dangerText" onClick={()=>onDelete(profile)}>删除</button>
  </div>;
}
function PendingProfileRow({profile,label,onContinue,onDelete}:{profile:any;label:string;onContinue:(p:any)=>void;onDelete:(p:any)=>void}){
  const state=String(profile.state||profile.status||'draft');
  const stateText=state==='verifying'?'正在保存凭据':state==='failed'?'登录失败':state==='needs_login'?'需要重新登录':state==='authenticating'?'等待授权':'尚未完成';
  return <div className="profileRow">
    <div><strong>{label}</strong><span className="profileBadges"><i>{stateText}</i>{profile.authType&&<i>{authTypeLabel(profile.authType)}</i>}{profile.error&&<em>{profile.error}</em>}</span></div>
    <button onClick={()=>onContinue(profile)}>{state==='failed'?'重试':'继续登录'}</button>
    <button className="dangerText" onClick={()=>onDelete(profile)}>取消登录</button>
  </div>;
}
function AntigravityProfileRow({profile,onSwitch,onDelete}:{profile:any;onSwitch:(id:string)=>void;onDelete:(p:any)=>void}){
  const loggedIn = !!profile.login?.ok;
  const active = !!profile.active;
  return <div className="profileRow">
    <div><strong>{antigravityProfileLabel(profile)}</strong><span className="profileBadges">{active&&<i>当前</i>}<i>{loggedIn?'已登录':'未登录'}</i>{profile.login?.email&&<em>{profile.login.email}</em>}</span></div>
    {!active&&loggedIn&&<button onClick={()=>onSwitch(profile.id)}>切换</button>}
    <button className="dangerText" onClick={()=>onDelete(profile)}>删除</button>
  </div>;
}
function ClaudeProfileRow({profile,onSwitch,onLogin,onLogout,onDelete}:{profile:any;onSwitch:(id:string)=>void;onLogin:(p:any)=>void;onLogout:(p:any)=>void;onDelete:(p:any)=>void}){
  const active = !!profile.active;
  const ok = !['not_installed','not_configured','invalid_credentials','runtime_unavailable'].includes(String(profile.status||''));
  return <div className="profileRow">
    <div><strong>{profile.name || 'Claude Code Account'}</strong><span className="profileBadges">{active&&<i>当前</i>}<i>{ok?'已配置':'未配置'}</i><i>{authTypeLabel(profile.type||profile.authType)}</i>{profile.credentialSummary&&<em>{profile.credentialSummary}</em>}</span></div>
    {!active&&ok&&<button onClick={()=>onSwitch(profile.id)}>切换</button>}
    {!ok&&<button onClick={()=>onLogin(profile)}>登录</button>}
    {ok&&<button onClick={()=>onLogout(profile)}>退出登录</button>}
    <button className="dangerText" onClick={()=>onDelete(profile)}>删除</button>
  </div>;
}
function ClaudeProfileForm({type,name,secret,onType,onName,onSecret,onSubmit}:{type:'existing_cli'|'setup_token'|'api_key';name:string;secret:string;onType:(v:any)=>void;onName:(v:string)=>void;onSecret:(v:string)=>void;onSubmit:()=>void}){
  const needsSecret = type==='setup_token'||type==='api_key';
  return <section className="loginForm"><b>其他登录方式</b>
    <input value={name} onChange={e=>onName(e.target.value)} placeholder="Profile name"/>
    <div className="modeButtons"><button className={type==='existing_cli'?'active':''} onClick={()=>onType('existing_cli')}>Existing CLI</button><button className={type==='setup_token'?'active':''} onClick={()=>onType('setup_token')}>setup-token</button><button className={type==='api_key'?'active':''} onClick={()=>onType('api_key')}>API Key</button></div>
    {needsSecret&&<input type="password" value={secret} onChange={e=>onSecret(e.target.value)} placeholder={type==='api_key'?'ANTHROPIC_API_KEY':'CLAUDE_CODE_OAUTH_TOKEN'} autoComplete="off"/>}
    <span className="formHelp">{type==='existing_cli'?'使用服务器上受信任的 CLAUDE_CONFIG_DIR。':'凭据只写入私有 profile 文件，不会回显。'}</span>
    <button disabled={needsSecret&&!secret.trim()} onClick={onSubmit}>添加 profile</button>
  </section>;
}
function antigravityProfileLabel(profile:any){
  return profile?.login?.email || (profile?.name && profile.name !== 'Google Account' ? profile.name : 'Antigravity Account');
}
function LoginJobPanel({job}:{job:any}){
  const toast=useToast();
  const text=stripAnsi(job.output?.join('\n') || '');
  const url=job.loginUrl || text.match(/https?:\/\/\S+/)?.[0]?.replace(/[),.]+$/,'') || '';
  const code=job.deviceCode || extractDeviceCode(text);
  return <section><b>ChatGPT 登录</b>
    {url?<a className="loginLink" href={url} target="_blank" rel="noreferrer">打开登录网页</a>:<div className="loginLink pending">正在读取登录网页</div>}
    <div className={`loginCodeCard ${code?'ready':''}`}>
      <span>认证码</span>
      <div className="loginCodeLine"><strong>{code || '等待生成'}</strong>{code&&<button onClick={async()=>{try{await navigator.clipboard.writeText(code);toast('success','验证码已复制')}catch{toast('error','复制失败')}}}>复制</button>}</div>
      <small>{code?'打开登录网页后输入这个验证码':'正在读取 Codex 输出里的验证码'}</small>
    </div>
    <span>{job.status==='running'?'在网页完成认证后会自动完成':job.status==='done'?'登录完成':'登录失败，未完成的新账户会自动清理'}</span>
  </section>;
}
function AntigravityLoginPanel({job,code,onCode,onSubmit,onCancel}:{job:any;code:string;onCode:(v:string)=>void;onSubmit:()=>void;onCancel:()=>void}){
  const toast=useToast();
  const text=stripAnsi(job.output?.join('\n') || '');
  const url=job.loginUrl || stripAnsi(job.output?.join('\n') || '').replace(/\s+/g,'').match(/https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?.*?state=[A-Za-z0-9_-]+/)?.[0]?.replace(/[),.]+$/,'') || '';
  const submitted = !!job.codeSubmitted && job.status === 'running';
  return <section><b>Antigravity 登录</b>
    {url?<a className="loginLink" href={url} target="_blank" rel="noreferrer">打开 Google 登录</a>:<div className="loginLink pending">正在读取登录链接</div>}
    {url&&<button onClick={async()=>{try{await navigator.clipboard.writeText(url);toast('success','链接已复制')}catch{toast('error','复制失败')}}}>复制链接</button>}
    <div className="loginCodeCard ready">
      <span>授权码</span>
      <input value={code} onChange={e=>onCode(e.target.value)} placeholder="粘贴 Google 返回的 authorization code"/>
      <button disabled={!code.trim() || job.status!=='running'} onClick={onSubmit}>{submitted?'正在确认':job.status==='running'?'提交授权码':'已结束'}</button>
      <button className="dangerText" disabled={job.status!=='running'} onClick={onCancel}>取消并删除</button>
      <small>{job.status==='running'?(submitted?'已提交授权码，正在等待 Antigravity 确认登录':'完成 Google 登录后，把页面上的授权码粘贴到这里。'):job.status==='done'?'登录完成':'登录失败，未完成账户会自动清理'}</small>
    </div>
  </section>;
}
function GeminiMethodList({methods,onPick}:{methods:LoginMethodView[];onPick:(m:LoginMethodView)=>void}){
  const list = methods?.length ? methods : loginMethodViews([]);
  return <section className="loginMethodList">
    {list.map(m=><button key={m.id} className="loginMethodCard" disabled={m.kind==='unsupported'||m.kind==='gateway'} onClick={()=>onPick(m)}>
      <span><b>{m.title}</b><small>{m.kind==='unsupported'?'当前 Gemini CLI 返回的方法暂不能在网页中配置':m.description}</small></span>
      <em>{m.kind==='oauth'?'继续':m.kind==='api-key'||m.kind==='vertex'?'配置':'暂不支持'}</em>
    </button>)}
  </section>;
}
function GeminiGoogleLogin({profile,job,code,onCode,onStart,onSubmitCode,onCancel,onRefresh}:{profile:any;job:any;code:string;onCode:(v:string)=>void;onStart:()=>void;onSubmitCode:()=>void;onCancel:()=>void;onRefresh:()=>any|Promise<any>}){
  const running=job&&['preparing','waiting_user','verifying'].includes(job.status);
  return <section className="loginForm"><b>Google 登录</b><span className="formHelp">{geminiProfileLabel(profile)} · 使用 Google 账号和订阅额度</span><button disabled={running} onClick={onStart}>{running?(job.loginUrl?'等待授权码':'正在准备授权链接'):'继续'}</button>{job&&<GeminiLoginJobPanel job={job} code={code} onCode={onCode} onSubmitCode={onSubmitCode} onCancel={onCancel} onRefresh={onRefresh}/>}</section>;
}
function GeminiApiKeyLogin({apiKey,onApiKey,job,onSubmit}:{apiKey:string;onApiKey:(v:string)=>void;job:any;onSubmit:()=>void}){
  const running=job&&['preparing','waiting_user','verifying'].includes(job.status);
  return <section className="loginForm"><b>Gemini API Key</b><input type="password" value={apiKey} onChange={e=>onApiKey(e.target.value)} placeholder="Gemini API Key" autoComplete="off"/><span className="formHelp">API Key 只写入当前 Gemini Profile 的私有配置，不会回显。</span><button disabled={!apiKey.trim()||running} onClick={onSubmit}>{running?'正在验证':'使用 API Key 登录'}</button>{job&&<GeminiLoginJobPanel job={job}/>}</section>;
}
function GeminiVertexLogin(){
  return <section className="loginForm"><b>Vertex AI</b><InlineNotice tone="info" text="Vertex AI 需要项目、区域和凭据路径校验。本版本不会保存不完整配置。"/></section>;
}
function ClaudeLoginJobPanel({job,input,onInput,onSubmitInput,onCancel}:{job:any;input:string;onInput:(v:string)=>void;onSubmitInput:()=>void;onCancel:()=>void}){
  const toast=useToast();
  const running=['running','waiting_user','verifying'].includes(job.status);
  const statusText=job.status==='verifying'?'正在验证 Claude auth status':job.status==='waiting_user'?'等待浏览器授权':job.status==='done'?'登录成功':job.status==='cancelled'?'已取消':job.status==='error'?'登录失败':'正在启动 Claude CLI';
  const text=stripAnsi(job.output?.join('\n') || '');
  const url=job.loginUrl || text.match(/https:\/\/\S+/)?.[0]?.replace(/[),.]+$/,'') || '';
  return <section><b>Claude CLI 登录</b>
    <span>{statusText}</span>
    {url&&<a className="loginLink" href={url} target="_blank" rel="noreferrer">打开登录地址</a>}
    {url&&<button onClick={async()=>{try{await navigator.clipboard.writeText(url);toast('success','链接已复制')}catch{toast('error','复制失败')}}}>复制链接</button>}
    {job.requiresInput&&<div className="loginCodeCard ready"><span>输入给 Claude CLI</span><input value={input} onChange={e=>onInput(e.target.value)} placeholder="粘贴授权码，或输入 CLI 要求的内容" autoComplete="off"/><button disabled={!input.trim()||!running} onClick={onSubmitInput}>提交</button></div>}
    {job.error&&<InlineNotice tone={job.status==='waiting_user'?'info':'error'} text={job.error}/>}
    {!!text&&<details className="loginLog"><summary>查看日志</summary><pre>{text}</pre></details>}
    {running&&<button onClick={onCancel}>取消</button>}
  </section>;
}
function GeminiLoginJobPanel({job,code='',onCode,onSubmitCode,onCancel,onRefresh}:{job:any;code?:string;onCode?:(v:string)=>void;onSubmitCode?:()=>void;onCancel?:()=>void;onRefresh?:()=>any|Promise<any>}){
  const toast=useToast();
  const running=['preparing','waiting_user','verifying'].includes(job.status);
  const statusText=job.status==='preparing'?'正在准备授权链接':job.status==='verifying'?'正在验证':job.status==='waiting_user'?'等待打开 Google 并输入授权码':job.status==='done'?'登录成功':job.status==='cancelled'?'已取消':job.status==='fallback'?'登录失败，可使用 SSH 兜底':'登录失败';
  return <section><b>Gemini 登录</b>
    <span>{statusText}</span>
    {job.loginUrl&&<a className="loginLink" href={job.loginUrl} target="_blank" rel="noreferrer">打开 Google 登录</a>}
    {job.loginUrl&&<button onClick={async()=>{try{await navigator.clipboard.writeText(job.loginUrl);toast('success','链接已复制')}catch{toast('error','复制失败')}}}>复制链接</button>}
    {job.requiresCodeInput&&<div className="loginCodeCard ready">
      <span>Authorization code</span>
      <input value={code} onChange={e=>onCode?.(e.target.value)} placeholder="粘贴 Google 返回的 authorization code" autoComplete="off"/>
      <button disabled={!code.trim()||!running||job.codeSubmitted} onClick={onSubmitCode}>{job.codeSubmitted?'正在验证':'完成登录'}</button>
      <small>{job.codeSubmitted?'已提交授权码，正在验证登录':'Google 授权完成后，把页面显示的 code 粘贴到这里。若账号选择页没有出现，请用无痕窗口打开链接。'}</small>
    </div>}
    {job.deviceCode&&<div className="loginCodeCard ready"><span>认证码</span><div className="loginCodeLine"><strong>{job.deviceCode}</strong></div></div>}
    {job.fallbackCommand&&job.status==='fallback'&&<div className="loginCodeCard ready"><span>SSH 命令</span><code className="loginCommand">{job.fallbackCommand}</code><button onClick={async()=>{try{await navigator.clipboard.writeText(job.fallbackCommand);toast('success','命令已复制')}catch{toast('error','复制失败')}}}>复制命令</button>{onRefresh&&<button onClick={()=>onRefresh()}>重新检测登录</button>}</div>}
    {job.error&&<InlineNotice tone={job.status==='waiting_user'||job.status==='fallback'?'info':'error'} text={job.error}/>}
    {onCancel&&running&&<button onClick={onCancel}>取消登录</button>}
  </section>;
}
function stripAnsi(text:string){ return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g,''); }
function extractDeviceCode(text:string){
  const cleaned=text.replace(/[^A-Za-z0-9-]+/g,' ');
  const match=cleaned.match(/\b([A-Z0-9]{4})\s*-\s*([A-Z0-9]{4,5})\b/i);
  return match ? `${match[1]}-${match[2]}`.toUpperCase() : '';
}
function modelLabel(model?:string){ return model === '' ? '自动' : model ? model.replace(/^gpt-/, 'GPT-').replace(/^o(\d)/, 'o$1') : '读取中'; }
function catalogCurrent(catalog:any){ return catalog?.current || catalog?.models?.find((m:ModelOption)=>m.isDefault)?.model || catalog?.models?.[0]?.model || ''; }
function modelOptionLabel(model:ModelOption){
  const name = model.displayName || model.model;
  return name === model.model ? name : `${name} (${model.model})`;
}
function ModelPicker({models,value,onPick,emptyText='正在读取模型列表'}:{models:ModelOption[];value:string;onPick:(model:string)=>void;emptyText?:string}){
  const [manual,setManual]=useState('');
  return <div className="modelChoices">
    {!models.length&&<div className="modelLoading">{emptyText}</div>}
    {models.map(m=><button key={m.id||m.model} className={`modelChoice ${value===m.model?'active':''}`} onClick={()=>onPick(m.model)}><span><b>{modelOptionLabel(m)}</b>{m.description&&<small>{m.description}</small>}</span><i/></button>)}
    <div className="manualModel"><input value={manual} onChange={e=>setManual(e.target.value)} placeholder="手动模型 ID"/><button disabled={!manual.trim()} onClick={()=>onPick(manual.trim())}>应用</button></div>
  </div>;
}
function GeminiModelSummary({defaultModel,currentSessionId,currentModel}:{defaultModel:string;currentSessionId:string;currentModel:string}){
  return <div className="modelSummary"><span><b>默认模型</b><small>{modelLabel(defaultModel)}</small></span><span><b>当前会话</b><small>{currentSessionId ? modelLabel(currentModel) : '尚无会话'}</small></span></div>;
}
function ModelSheet({models,value,busy,onPick,onClose}:{models:ModelOption[];value:string;busy:boolean;onPick:(model:string)=>void;onClose:()=>void}){
  return <Sheet className="modelSheet" onClose={onClose} title="切换模型" subtitle="从下一条消息开始生效"><ModelPicker models={models} value={value} onPick={m=>!busy&&onPick(m)}/></Sheet>;
}
function ModeButtons({value,onPick}:{value:string;onPick:(mode:string)=>void}){ return <div className="modeButtons"><button className={value==='yolo'?'active':''} onClick={()=>onPick('yolo')}>YOLO</button><button className={value==='workspace-write'?'active':''} onClick={()=>onPick('workspace-write')}>Workspace</button><button className={value==='read-only'?'active':''} onClick={()=>onPick('read-only')}>Read Only</button></div>; }
function QuotaBar({title,limitWindow}:{title:string;limitWindow:any}){
  if(!limitWindow) return null;
  const used=Math.max(0,Math.min(100,Math.round(limitWindow?.usedPercent || 0)));
  const remaining=100-used;
  const tone=remaining>50?'good':remaining>20?'warn':'danger';
  return <div className={`quotaCard ${tone}`}><div className="quotaLine"><b>{title}</b><strong>剩余 {remaining}%</strong></div><div className="quotaTrack" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining} aria-label={`${title}剩余额度`}><i style={{width:`${remaining}%`}}/></div><span>已用 {used}% · {limitWindow?.windowDurationMins?quotaDuration(limitWindow.windowDurationMins):'滚动窗口'}{limitWindow?.resetsAt?` · 重置 ${new Date(limitWindow.resetsAt*1000).toLocaleString()}`:''}</span></div>;
}
function quotaWindowTitle(limitWindow:any){
  const mins=Number(limitWindow?.windowDurationMins || 0);
  if(mins===300) return '5 小时额度';
  if(mins===10080) return '周额度';
  if(mins===43200) return '30 天额度';
  if(mins>0) return quotaDuration(mins).replace('窗口','额度');
  return '滚动额度';
}
function usageSummary(summary:any){
  const parts = [
    summary.lifetimeTokens ? `总 token ${formatNumber(summary.lifetimeTokens)}` : '',
    summary.peakDailyTokens ? `单日峰值 ${formatNumber(summary.peakDailyTokens)}` : '',
    summary.currentStreakDays ? `连续 ${summary.currentStreakDays} 天` : '',
  ].filter(Boolean);
  return parts.join(' · ') || '官方 usage 未返回可显示字段';
}
function sessionUsageSummary(usage:any){
  if (!usage.supported) return `${usage.note || usage.error || '当前 Codex 协议未返回会话级额度'} · ${usage.turns ?? 0} turns`;
  const t = usage.totals || {};
  const parts = [
    `总 ${formatNumber(t.totalTokens || 0)}`,
    `输入 ${formatNumber(t.inputTokens || 0)}`,
    `输出 ${formatNumber(t.outputTokens || 0)}`,
    t.reasoningOutputTokens ? `推理 ${formatNumber(t.reasoningOutputTokens)}` : '',
    usage.modelContextWindow ? `窗口 ${formatNumber(usage.modelContextWindow)}` : '',
    `${usage.turns ?? 0} turns`,
  ].filter(Boolean);
  return parts.join(' · ');
}
function formatNumber(value:any){ const n=Number(value || 0); return Number.isFinite(n) ? new Intl.NumberFormat('zh-CN').format(n) : String(value); }
function quotaDuration(mins:number){ if(mins===300)return '5 小时窗口'; if(mins===10080)return '7 天窗口'; if(mins===43200)return '30 天窗口'; if(mins%60===0)return `${mins/60} 小时窗口`; return `${mins} 分钟窗口`; }
function Sheet({children,title,subtitle,actions,onClose,className=''}:{children:React.ReactNode;title:string;subtitle?:string;actions?:React.ReactNode;onClose:()=>void;className?:string}){ return <div className="sheetBackdrop" onClick={onClose}><section className={`sheet ${className}`} onClick={e=>e.stopPropagation()}><header><div><b>{title}</b>{subtitle&&<span>{subtitle}</span>}</div><div className="sheetActions">{actions}<button onClick={onClose}>关闭</button></div></header>{children}</section></div>; }
function ConfirmDialog({title,detail,confirm,cancel='取消',busy=false,error='',onCancel,onConfirm}:{title:string;detail:string;confirm:string;cancel?:string;busy?:boolean;error?:string;onCancel:()=>void;onConfirm:()=>void}){
  useEffect(()=>{ const previous=document.body.style.overflow; document.body.style.overflow='hidden'; return()=>{ document.body.style.overflow=previous; }; },[]);
  return <div className="dialogBackdrop"><section className="dialog"><h2>{title}</h2><p>{detail}</p>{error&&<pre className="errorText">{error}</pre>}<div><button disabled={busy} onClick={onCancel}>{cancel}</button><button className="danger" disabled={busy} onClick={onConfirm}>{confirm}</button></div></section></div>;
}
function EmptyState({title,detail}:{title:string;detail:string}){ return <div className="empty"><b>{title}</b><span>{detail}</span></div>; }
function LoadingRows({count=4}:{count?:number}){ return <div className="loadingRows" aria-label="正在加载">{Array.from({length:count}).map((_,i)=><div className="skeletonRow" key={i}><i/><span/><small/></div>)}</div>; }
function ErrorState({title,detail,action,onAction}:{title:string;detail:string;action:string;onAction:()=>void}){ return <div className="errorState"><b>{title}</b><span>{detail}</span><button onClick={onAction}>{action}</button></div>; }
function InlineNotice({tone,text}:{tone:'error'|'info';text:string}){ return <div className={`notice ${tone}`}>{text}</div>; }

createRoot(document.getElementById('root')!).render(<ToastProvider><App/></ToastProvider>);
if('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').then(reg=>{
    reg.update().catch(()=>{});
    let refreshing=false;
    navigator.serviceWorker.addEventListener('controllerchange',()=>{
      if(refreshing) return;
      refreshing=true;
      location.reload();
    });
  }).catch(()=>{});
}

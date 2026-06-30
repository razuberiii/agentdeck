import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type ProviderStatus = { id:'codex'|'antigravity'; displayName:string; ok:boolean; installed:boolean; version?:string|null; error?:string|null; installHint?:string };
type Status = { authed:boolean; roots:string[]; mode:string; defaultMode:string; defaultModel?:string; defaultModels?:Record<string,string>; activeProvider?:'codex'|'antigravity'; codex:any; antigravity?:ProviderStatus; providers?:ProviderStatus[]; capabilities:Capabilities; activeProfile?:any };
type Capabilities = { imageInput:boolean; imageOutput:boolean; attachmentTypes:string[]; maxAttachmentBytes:number };
type Session = { id:string; codex_thread_id:string; provider_id?:'codex'|'antigravity'; providerId?:'codex'|'antigravity'; project_dir:string; title:string; status:string; permission_mode?:string; approval_policy?:string; sandbox_mode?:string; model?:string; archived?:number; created_at?:number; updated_at?:number; last_sequence?:number };
type Project = { name:string; path:string; branch:string|null; updatedAt:number };
type ModelOption = { id:string; model:string; actualModel?:string; displayName:string; description?:string; hidden?:boolean; isDefault?:boolean; inputModalities?:string[]; upgrade?:string|null };
type Attachment = { id:string; name:string; type:string; size:number; url:string; previewUrl?:string; uploading?:boolean; error?:string };
type DisplayEvent = { key:string; role:'user'|'assistant'|'system'|'command'|'file'|'reasoning'|'image'; title?:string; text:string; meta?:string; open?:boolean; attachments?:Attachment[]; images?:Attachment[]; files?:Attachment[] };
type Toast = { id:string; kind:'success'|'error'|'info'; text:string };
type ApprovalRequest = { requestId:string; method:string; params:any };

const FALLBACK_WORKSPACE = '/opt/stacks/agentdeck';
const APP_NAME = 'Agent Deck';
const CHUNK_SIZE = 24 * 1024;
const PUBLIC_UPLOAD_TARGET_BYTES = 650 * 1024;
const MOBILE_CONTEXT_MARKER = '[[CODEX_MOBILE_CLIENT_CONTEXT]]';
const ToastContext = createContext<(kind:Toast['kind'], text:string)=>void>(()=>{});

function getCookie(n:string){ return document.cookie.split('; ').find(x=>x.startsWith(n+'='))?.split('=')[1] || ''; }
async function api(url:string, opts:any = {}) {
  const csrf = getCookie('agentdeck_csrf');
  const headers:any = {'x-csrf-token': csrf, ...(opts.headers || {})};
  if (opts.body !== undefined && !headers['content-type']) headers['content-type'] = 'application/json';
  const r = await fetch(url, {...opts, headers, credentials:'same-origin'});
  if (!r.ok) throw new Error(await r.text());
  return r.json();
}
function haptic(){ navigator.vibrate?.(10); }
function statusLabel(s?:string){ return ({idle:'空闲',running:'执行中',completed:'已完成',active:'空闲',interrupted:'已中断',unknown:'未知',notLoaded:'可继续'} as any)[s||''] || s || '空闲'; }
function connectionLabel(s?:string){ return ({connected:'已连接',reconnecting:'重连中',offline:'离线',recovering:'恢复中',unavailable:'不可用'} as any)[s||''] || s || '未知'; }
function formatTime(ms?:number){ if(!ms) return '未知时间'; return new Intl.DateTimeFormat('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}).format(new Date(ms)); }
function formatSize(bytes:number){ if(bytes<1024) return `${bytes} B`; if(bytes<1024*1024) return `${(bytes/1024).toFixed(1)} KB`; return `${(bytes/1024/1024).toFixed(2)} MB`; }
function projectName(path:string){ return path.split('/').filter(Boolean).pop() || path; }
function shortError(e:any){ try { const parsed = JSON.parse(String(e.message)); return parsed.error || String(e.message); } catch { return String(e.message || e); } }
function isMobileInput(){ return matchMedia('(pointer: coarse)').matches || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent); }
function modeLabel(mode?:string){ if(mode==='read-only')return 'Read Only'; if(mode==='workspace-write')return 'Workspace Write'; return 'YOLO'; }
function profileLabel(profile:any){ return profile?.login?.email || profile?.name || 'Codex Account'; }
function providerLabel(id?:string){ return id==='antigravity' ? 'Antigravity' : 'Codex'; }
function sessionProvider(session:Session){ return session.provider_id || session.providerId || 'codex'; }

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
  useEffect(()=>{api('/api/status').then(s=>setAuthed(s.authed)).catch(()=>setAuthed(false)).finally(()=>setChecked(true))},[]);
  if(!checked) return <main className="boot">{APP_NAME}</main>;
  if(!authed) return <Login onLogin={()=>setAuthed(true)}/>;
  const m=view.match(/^#\/s\/([^/]+)/);
  return m ? <SessionView id={m[1]}/> : <Home/>;
}

function Login({onLogin}:{onLogin:()=>void}){
  const toast=useToast(); const [password,setPassword]=useState(''); const [busy,setBusy]=useState(false);
  async function submit(e:any){ e.preventDefault(); setBusy(true); try{ await api('/api/login',{method:'POST',body:JSON.stringify({username:'admin',password})}); haptic(); onLogin(); } catch { toast('error','登录失败'); } finally { setBusy(false); } }
  return <main className="login"><form onSubmit={submit} className="loginPanel"><div className="mark">AD</div><h1>{APP_NAME}</h1><input autoFocus type="password" placeholder="管理员密码" value={password} onChange={e=>setPassword(e.target.value)}/><button className="btn primary" disabled={busy}>{busy?'登录中':'登录'}</button></form></main>;
}

function Home(){
  const toast=useToast();
  const [status,setStatus]=useState<Status|null>(null); const [projects,setProjects]=useState<Project[]>([]); const [sessions,setSessions]=useState<Session[]>([]);
  const [archived,setArchived]=useState(false); const [query,setQuery]=useState(''); const [picker,setPicker]=useState(false); const [busy,setBusy]=useState(''); const [loading,setLoading]=useState(true); const [projectsLoading,setProjectsLoading]=useState(false); const [error,setError]=useState('');
  const [quota,setQuota]=useState<any>(null); const [quotaOpen,setQuotaOpen]=useState(false); const [settingsOpen,setSettingsOpen]=useState(false); const [settings,setSettings]=useState<any>(null); const [online,setOnline]=useState(navigator.onLine);
  useEffect(()=>{ refresh(); },[archived]);
  useEffect(()=>{ const on=()=>setOnline(navigator.onLine); addEventListener('online',on); addEventListener('offline',on); return()=>{removeEventListener('online',on); removeEventListener('offline',on)} },[]);
  async function refresh(scanProjects=false){ setLoading(true); setError(''); try{ const [st,ss,ps]=await Promise.all([api('/api/status'),api('/api/sessions'+(archived?'?archived=1':'')),scanProjects?api('/api/projects?refresh=1'):Promise.resolve(null)]); setStatus(st); setSessions(ss.sessions); if(ps) setProjects(ps.projects); } catch(e:any){ setError(shortError(e)); toast('error','刷新失败'); } finally { setLoading(false); } }
  async function loadProjects(force=true){ setProjectsLoading(true); try{ const ps=await api('/api/projects'+(force?'?refresh=1':'')); setProjects(ps.projects); } catch(e:any){ toast('error','项目扫描失败：'+shortError(e)); } finally{ setProjectsLoading(false); } }
  async function openProjectPicker(){ setPicker(true); await loadProjects(true); }
  const defaultWorkspace = status?.defaultWorkspace || status?.roots?.[0] || FALLBACK_WORKSPACE;
  async function newSession(projectDir:string,title?:string){ setBusy(projectDir); try{ const s=await api('/api/sessions',{method:'POST',body:JSON.stringify({projectDir,title:title||projectName(projectDir),mode:status?.defaultMode,providerId:status?.activeProvider||'codex'})}); haptic(); location.hash='#/s/'+s.id; } catch(e:any){ toast('error','创建失败：'+shortError(e)); } finally{ setBusy(''); } }
  async function showQuota(){ setQuotaOpen(true); try{ setQuota(await api('/api/quota?provider='+encodeURIComponent(activeProvider))); } catch(e:any){ setQuota({errors:{rateLimits:shortError(e)}}); } }
  async function showSettings(){ try{ setSettings(await api('/api/settings')); setSettingsOpen(true); } catch(e:any){ toast('error','设置读取失败：'+shortError(e)); } }
  const activeProvider=status?.activeProvider || 'codex';
  const activeProviderStatus = activeProvider === 'antigravity' ? status?.antigravity : status?.codex;
  const filtered=sessions.filter(s=>sessionProvider(s)===activeProvider).filter(s=>(s.title+' '+s.project_dir+' '+s.status).toLowerCase().includes(query.toLowerCase()));
  return <main className="appShell">
    <header className="homeTop">
      <div><strong>{APP_NAME}</strong><span>{online?'网络在线':'网络离线'} · {providerLabel(status?.activeProvider)} · {status?.mode || 'Full Access'} · {profileLabel(status?.activeProfile)}</span></div>
      <div className="iconRow"><button className="iconBtn" aria-label="设置" onClick={showSettings}>⚙</button><button className="iconBtn" aria-label="查看额度" onClick={showQuota}>%</button><button className="iconBtn" aria-label="刷新" onClick={()=>refresh(true)}>↻</button></div>
    </header>
    {!online&&<InlineNotice tone="error" text="网络已断开，当前页面仍可浏览，恢复后会自动重新连接。"/>}
    <section className="statusStrip">
      <div><span>服务器</span><b>{error?'异常':'在线'}</b></div>
      <div><span>{providerLabel(activeProvider)}</span><b>{activeProviderStatus?.ok ? activeProviderStatus.version : (activeProviderStatus?.error || '不可用')}</b></div>
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
    <section className="sessionList" aria-busy={loading}>
      {loading&&<LoadingRows count={6}/>}
      {!loading&&!filtered.length&&<EmptyState title={archived?'没有归档会话':'还没有最近会话'} detail={query?'换个关键词试试':'选择项目或新建任务开始'} />}
      {filtered.map(s=><SessionRow key={s.id} session={s} onArchive={async()=>{ try{ await api(`/api/sessions/${s.id}/${s.archived?'unarchive':'archive'}`,{method:'POST'}); haptic(); toast('success',s.archived?'已恢复':'已归档'); refresh(); } catch(e:any){ toast('error','操作失败：'+shortError(e)); } }}/>)}
    </section>
    {picker&&<ProjectPicker projects={projects} busy={busy} loading={projectsLoading} onRefresh={()=>loadProjects(true)} onClose={()=>setPicker(false)} onPick={(p)=>newSession(p.path,p.name)}/>}
    {quotaOpen&&<QuotaSheet quota={quota} onRefresh={showQuota} onClose={()=>setQuotaOpen(false)}/>}
    {settingsOpen&&<SettingsSheet data={settings} onChanged={async()=>{ await refresh(); const next=await api('/api/settings'); setSettings(next); return next; }} onClose={()=>setSettingsOpen(false)}/>}
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
  const [session,setSession]=useState<Session|null>(null); const [events,setEvents]=useState<DisplayEvent[]>([]); const [live,setLive]=useState<any[]>([]);
  const [loading,setLoading]=useState(true);
  const [text,setText]=useState(''); const [attachments,setAttachments]=useState<Attachment[]>([]); const [status,setStatus]=useState<Status|null>(null);
  const [busy,setBusy]=useState(''); const [online,setOnline]=useState(navigator.onLine); const [browserConnection,setBrowserConnection]=useState<'connected'|'reconnecting'|'offline'>(navigator.onLine?'reconnecting':'offline'); const [runtimeConnection,setRuntimeConnection]=useState<'connected'|'recovering'|'unavailable'>('connected'); const [turnStatus,setTurnStatus]=useState<'idle'|'running'|'completed'|'interrupted'|'unknown'>('unknown'); const [diff,setDiff]=useState(''); const [menu,setMenu]=useState(false); const [modelOpen,setModelOpen]=useState(false); const [models,setModels]=useState<any>(null); const [modelsProvider,setModelsProvider]=useState<string>(''); const [confirmDelete,setConfirmDelete]=useState(false); const [quota,setQuota]=useState<any>(null); const [quotaOpen,setQuotaOpen]=useState(false); const [viewer,setViewer]=useState<Attachment|null>(null); const [showBottom,setShowBottom]=useState(false); const [drag,setDrag]=useState(false); const [approvals,setApprovals]=useState<ApprovalRequest[]>([]);
  const [menuPage,setMenuPage]=useState<'main'|'mode'|'manage'>('main');
  const wsRef=useRef<WebSocket|null>(null); const reconnectRef=useRef<number|null>(null); const mountedRef=useRef(false); const feedRef=useRef<HTMLElement|null>(null); const textareaRef=useRef<HTMLTextAreaElement|null>(null); const fileRef=useRef<HTMLInputElement|null>(null); const nearBottomRef=useRef(true); const clientAppliedSequenceRef=useRef(0); const snapshotCoveredSequenceRef=useRef(0); const seenRuntimeEventsRef=useRef<Set<string>>(new Set());
  useEffect(()=>{ mountedRef.current=true; clientAppliedSequenceRef.current=Number(localStorage.getItem(sequenceKey(id)) || 0); snapshotCoveredSequenceRef.current=0; seenRuntimeEventsRef.current=new Set(); setLoading(true); setEvents([]); setLive([]); setApprovals([]); setRuntimeConnection('connected'); setTurnStatus('unknown'); setText(localStorage.getItem(draftKey(id)) || ''); setAttachments(loadDraftAttachments(id)); load(); connect(); const on=()=>{ const isOnline=navigator.onLine; setOnline(isOnline); setBrowserConnection(isOnline?(wsRef.current?.readyState===WebSocket.OPEN?'connected':'reconnecting'):'offline'); }; addEventListener('online',on); addEventListener('offline',on); return()=>{ mountedRef.current=false; removeEventListener('online',on); removeEventListener('offline',on); if(reconnectRef.current) clearTimeout(reconnectRef.current); wsRef.current?.close(); }; },[id]);
  useEffect(()=>{ if(!session) return; const provider=sessionProvider(session); setModels(null); setModelsProvider(provider); api('/api/models?provider='+encodeURIComponent(provider)).then(setModels).catch(()=>{}); },[id,session?.provider_id,session?.providerId]);
  useEffect(()=>{ if(nearBottomRef.current) requestAnimationFrame(()=>feedRef.current?.scrollTo({top:feedRef.current.scrollHeight})); },[events,live]);
  useEffect(()=>{ const el=textareaRef.current; if(!el)return; el.style.height='auto'; if(!text.trim()){ el.style.height='42px'; el.style.overflowY='hidden'; return; } const next=Math.min(Math.max(el.scrollHeight, 42), 180); el.style.height=next+'px'; el.style.overflowY=el.scrollHeight>180?'auto':'hidden'; },[text]);
  useEffect(()=>{ if(text.trim()) localStorage.setItem(draftKey(id), text); else localStorage.removeItem(draftKey(id)); },[id,text]);
  useEffect(()=>{ saveDraftAttachments(id, attachments); },[id,attachments]);
  async function load(resetLive=false){ try{ const [d,st]=await Promise.all([api('/api/sessions/'+id), api('/api/status')]); setSession(d.session); setEvents(threadEvents(d.thread)); setStatus(st); const covered=Number(d.snapshot?.coveredSequence || 0); snapshotCoveredSequenceRef.current=covered; if(covered>clientAppliedSequenceRef.current){ clientAppliedSequenceRef.current=covered; localStorage.setItem(sequenceKey(id), String(covered)); } setTurnStatus(normalizeTurnStatus(d.session?.status)); setRuntimeConnection(d.snapshot?.error?'recovering':'connected'); if(resetLive) setLive(v=>v.filter(m=>Number(m.runtimeSequence||0)>covered)); return clientAppliedSequenceRef.current; } catch(e:any){ toast('error','读取会话失败：'+shortError(e)); return clientAppliedSequenceRef.current; } finally { setLoading(false); } }
  function connect(){ if(!mountedRef.current) return; const proto=location.protocol==='https:'?'wss':'ws'; const ws=new WebSocket(`${proto}://${location.host}/ws`); wsRef.current=ws; setBrowserConnection(navigator.onLine?'reconnecting':'offline'); ws.onopen=async()=>{ setBrowserConnection('connected'); const after=await load(true); if(ws.readyState===WebSocket.OPEN) ws.send(JSON.stringify({type:'join',sessionId:id,lastSequence:after,clientAppliedSequence:after,snapshotCoveredSequence:snapshotCoveredSequenceRef.current})); }; ws.onmessage=e=>applySocketMessage(JSON.parse(e.data)); ws.onclose=()=>{ if(wsRef.current===ws) wsRef.current=null; setBrowserConnection(navigator.onLine?'reconnecting':'offline'); if(mountedRef.current) reconnectRef.current=window.setTimeout(connect,1500); }; }
  function applySocketMessage(msg:any){ if(!acceptRuntimeEvent(msg)) return; if(msg.type==='joined'){ if(msg.runtimeConnection) setRuntimeConnection(msg.runtimeConnection==='connected'?'connected':'recovering'); return; } if(msg.type==='runtimeConnection'){ setRuntimeConnection(msg.status==='connected'?'connected':msg.status==='unavailable'?'unavailable':'recovering'); markRuntimeApplied(msg); return; } if(msg.type==='thread_snapshot'){ if(msg.thread){ setEvents(threadEvents(msg.thread)); const covered=Number(msg.snapshot?.coveredSequence || msg.runtimeSequence || 0); snapshotCoveredSequenceRef.current=Math.max(snapshotCoveredSequenceRef.current, covered); setLive(v=>v.filter(x=>Number(x.runtimeSequence||0)>covered)); if(covered>clientAppliedSequenceRef.current){ clientAppliedSequenceRef.current=covered; localStorage.setItem(sequenceKey(id), String(covered)); } } if(msg.status) setTurnStatus(normalizeTurnStatus(msg.status)); markRuntimeApplied(msg); return; } if(msg.type==='approval'){ setApprovals(v=>v.some(a=>a.requestId===String(msg.requestId))?v:[...v,{requestId:String(msg.requestId),method:String(msg.method),params:msg.params}]); haptic(); toast('info','Codex 请求授权'); return; } if(msg.type==='sessionTitle') setSession(s=>s?{...s,title:msg.title}:s); if(msg.type==='codex'&&msg.method==='turn/started'){ setSession(s=>s?{...s,status:'running'}:s); setTurnStatus('running'); } if(msg.type==='codex'&&msg.method==='turn/completed'){ const interrupted=turnFailed(msg.params?.turn); setSession(s=>s?{...s,status:interrupted?'interrupted':'idle'}:s); setTurnStatus(interrupted?'interrupted':'completed'); } if(msg.type==='codex'&&(msg.method==='turn/failed'||msg.method==='turn/interrupted')){ setSession(s=>s?{...s,status:'interrupted'}:s); setTurnStatus('interrupted'); } if(msg.type==='error') toast('error','请求失败：'+msg.error); setLive(v=>[...v,msg]); markRuntimeApplied(msg); }
  function acceptRuntimeEvent(msg:any){ const seq=Number(msg.runtimeSequence||0); if(!seq) return true; if(seq<=snapshotCoveredSequenceRef.current && msg.type!=='thread_snapshot') return false; const generation=String(msg.runtimeGeneration||'legacy'); const key=`${generation}:${seq}:${msg.type||''}:${msg.method||msg.status||''}`; if(seenRuntimeEventsRef.current.has(key)) return false; seenRuntimeEventsRef.current.add(key); return true; }
  function markRuntimeApplied(msg:any){ const seq=Number(msg.runtimeSequence||0); if(seq>clientAppliedSequenceRef.current){ clientAppliedSequenceRef.current=seq; localStorage.setItem(sequenceKey(id), String(seq)); } }
  function onScroll(){ const el=feedRef.current; if(!el)return; nearBottomRef.current=el.scrollHeight-el.scrollTop-el.clientHeight<120; setShowBottom(!nearBottomRef.current); }
  async function send(){ const message=text.replace(/\r\n/g,'\n'); if(!message.trim()&&!attachments.length) return; if(attachments.some(a=>a.uploading||a.error)){ toast('error','图片仍在处理或上传失败'); return; } const ws=wsRef.current; if(!ws||ws.readyState!==WebSocket.OPEN){ toast('error','连接中，请稍后重试'); return; } setBusy('send'); try{ sendMessage(ws,id,{text:message,attachments}); haptic(); setText(''); localStorage.removeItem(draftKey(id)); localStorage.removeItem(draftAttachmentsKey(id)); setAttachments([]); toast('info','已发送'); } finally{ setBusy(''); } }
  async function stop(){ setBusy('stop'); try{ wsRef.current?.send(JSON.stringify({type:'stop',sessionId:id})); haptic(); toast('info','已请求停止生成'); setLive(v=>[...v,{type:'system',text:'已请求停止生成'}]); } finally{ setBusy(''); } }
  async function uploadFiles(files:FileList|File[]){ if(!status?.capabilities?.imageInput){ toast('error','当前服务端未启用图片输入'); return; } for(const original of Array.from(files)){ let file=original; try{ file=await prepareImageForUpload(original,Math.min(status.capabilities.maxAttachmentBytes,PUBLIC_UPLOAD_TARGET_BYTES)); }catch(e:any){ toast('error',`${original.name} ${shortError(e)}`); continue; } if(!status.capabilities.attachmentTypes.includes(normalizeImageType(file.type))){ toast('error',`${file.name} 类型不支持`); continue; } const previewUrl=URL.createObjectURL(file); const local:Attachment={id:crypto.randomUUID(),name:file.name,type:normalizeImageType(file.type),size:file.size,url:'',previewUrl,uploading:true}; setAttachments(v=>[...v,local]); try{ const data=await readFileBase64(file); const saved=await api(`/api/sessions/${id}/attachments`,{method:'POST',body:JSON.stringify({name:file.name,type:normalizeImageType(file.type),data})}); setAttachments(v=>v.map(a=>a.id===local.id?{...saved,previewUrl}:a)); haptic(); if(file!==original) toast('info','图片已压缩后上传'); } catch(e:any){ setAttachments(v=>v.map(a=>a.id===local.id?{...a,uploading:false,error:shortError(e)}:a)); toast('error','图片上传失败：'+shortError(e)); } } }
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
  async function answerApproval(req:ApprovalRequest, decision:'accept'|'decline'){ setBusy('approval:'+req.requestId); try{ await api('/api/approvals/'+encodeURIComponent(req.requestId),{method:'POST',body:JSON.stringify({decision,method:req.method})}); setApprovals(v=>v.filter(a=>a.requestId!==req.requestId)); haptic(); toast(decision==='accept'?'success':'info', decision==='accept'?'已允许':'已拒绝'); } catch(e:any){ toast('error','授权回复失败：'+shortError(e)); } finally{ setBusy(''); } }
  const rendered=visibleEvents([...events,...liveEvents(live)]); const currentStatus=turnStatus==='unknown'?liveStatus(live,session?.status):turnStatus; const activeModel=session?.model || (modelsProvider===(session ? sessionProvider(session) : '') ? catalogCurrent(models) : '') || status?.defaultModel;
  return <main className={`chatShell ${drag?'dragging':''}`} onDragOver={e=>{e.preventDefault();setDrag(true)}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);uploadFiles(e.dataTransfer.files)}}>
    <header className="chatTop"><button className="iconBtn" aria-label="返回" onClick={()=>location.hash='#/'}>‹</button><div className="chatTitle"><b>{session?.title||'Session'}</b><span><i className={`dot ${currentStatus}`}></i>{statusLabel(currentStatus)} · {projectName(session?.project_dir||'')} · {modelLabel(activeModel)} · {modeLabel(session?.permission_mode)} · 浏览器 {connectionLabel(browserConnection)} · Runtime {connectionLabel(runtimeConnection)}</span></div><button className="iconBtn" aria-label="额度" onClick={showQuota}>%</button><button className="iconBtn" aria-label="更多" onClick={toggleMenu}>⋯</button></header>
    {!online&&<InlineNotice tone="error" text="网络离线，发送会在连接恢复后可用。"/>}
    {online&&browserConnection!=='connected'&&<InlineNotice tone="info" text="浏览器正在重新连接会话。"/>}
    {runtimeConnection==='recovering'&&currentStatus==='running'&&<InlineNotice tone="info" text="Runtime 正在恢复，会话恢复后可继续发送。"/>}
    {runtimeConnection==='unavailable'&&<InlineNotice tone="error" text="Runtime 暂不可用，稍后会自动恢复。"/>}
    {menu&&<><button className="menuScrim" aria-label="关闭菜单" onClick={closeMenu}/><nav className="moreMenu">
      {menuPage==='main'&&<><button disabled={!!busy} onClick={openModelPicker}><b>模型</b><span>{modelLabel(activeModel)}</span></button><button disabled={!!busy} onClick={()=>setMenuPage('mode')}><b>权限模式</b><span>{modeLabel(session?.permission_mode)}</span></button><button disabled={!!busy} onClick={()=>{ closeMenu(); showDiff(); }}><b>Diff</b><span>查看当前改动</span></button><button disabled={!!busy} onClick={()=>setMenuPage('manage')}><b>会话管理</b><span>改名、Fork、归档</span></button></>}
      {menuPage==='mode'&&<><button className="menuBack" onClick={()=>setMenuPage('main')}>‹ 权限模式</button><button disabled={!!busy} className={session?.permission_mode==='yolo'?'active':''} onClick={()=>setSessionMode('yolo')}><b>YOLO</b><span>自动允许写入和命令</span></button><button disabled={!!busy} className={session?.permission_mode==='workspace-write'?'active':''} onClick={()=>setSessionMode('workspace-write')}><b>Workspace</b><span>写工作区前确认</span></button><button disabled={!!busy} className={session?.permission_mode==='read-only'?'active':''} onClick={()=>setSessionMode('read-only')}><b>Read Only</b><span>只读模式</span></button></>}
      {menuPage==='manage'&&<><button className="menuBack" onClick={()=>setMenuPage('main')}>‹ 会话管理</button><button disabled={!!busy} onClick={()=>{ closeMenu(); rename(); }}><b>改名</b><span>修改当前标题</span></button><button disabled={!!busy} onClick={()=>{ closeMenu(); fork(); }}><b>Fork</b><span>复制成新会话</span></button><button disabled={!!busy} onClick={()=>{ closeMenu(); archive(); }}><b>{session?.archived?'恢复':'归档'}</b><span>{session?.archived?'移回会话列表':'从列表中收起'}</span></button><button disabled={!!busy} className="dangerText" onClick={()=>{ closeMenu(); setConfirmDelete(true); }}><b>删除</b><span>不可撤销</span></button></>}
    </nav></>}
    {diff&&<DiffPanel diff={diff} onClose={()=>setDiff('')}/>}
    <section className={`feed ${!loading&&!rendered.length&&!approvals.length?'emptyFeed':''}`} ref={feedRef as any} onScroll={onScroll}>{loading?<LoadingRows count={5}/>:<>{rendered.map((e,i)=><EventCard key={e.key||i} e={e} onImage={setViewer}/>)}{approvals.map(a=><ApprovalCard key={a.requestId} req={a} busy={busy==='approval:'+a.requestId} onAnswer={answerApproval}/>)}{!rendered.length&&!approvals.length&&<EmptyState title="没有可显示的对话" detail="发送新消息后会显示回复"/>}</>}</section>
    {showBottom&&<button className="jumpBottom" onClick={()=>{nearBottomRef.current=true;feedRef.current?.scrollTo({top:feedRef.current.scrollHeight,behavior:'smooth'});setShowBottom(false)}}>回到底部</button>}
    <footer className="composer">
      {!!attachments.length&&<AttachmentTray items={attachments} onRemove={id=>setAttachments(v=>v.filter(a=>a.id!==id))} onOpen={setViewer}/>}
      <div className="composeRow"><button className="iconBtn attach" aria-label="添加图片" disabled={!status?.capabilities?.imageInput} onClick={()=>fileRef.current?.click()}>＋</button><textarea ref={textareaRef} rows={1} value={text} onPaste={e=>{const files=Array.from(e.clipboardData.files).filter(f=>f.type.startsWith('image/')); if(files.length){e.preventDefault();uploadFiles(files)}}} onChange={e=>setText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!isMobileInput()){e.preventDefault();send()}}} placeholder="输入任务"/><button className="iconBtn" aria-label="停止生成" disabled={busy==='stop'} onClick={stop}>■</button><button className="sendBtn" disabled={busy==='send'||(!text.trim()&&!attachments.length)} onClick={send}>{busy==='send'?'发送中':'发送'}</button></div>
      <input ref={fileRef} hidden type="file" accept="image/png,image/jpeg,image/webp" capture={undefined} multiple onChange={e=>{ if(e.target.files) uploadFiles(e.target.files); e.currentTarget.value=''; }}/>
    </footer>
    {confirmDelete&&<ConfirmDialog title="删除会话？" detail="会删除本地索引并尝试删除 Codex 会话文件。此操作不可撤销。" confirm="删除" onCancel={()=>setConfirmDelete(false)} onConfirm={del}/>}
    {quotaOpen&&<QuotaSheet quota={quota} onRefresh={showQuota} onClose={()=>setQuotaOpen(false)}/>}
    {modelOpen&&<ModelSheet models={models?.models||[]} value={activeModel} busy={busy==='model'} onPick={setSessionModel} onClose={()=>setModelOpen(false)}/>}
    {viewer&&<ImageViewer image={viewer} onClose={()=>setViewer(null)}/>}
  </main>;
}

function threadEvents(thread:any):DisplayEvent[]{ const out:DisplayEvent[]=[]; const turns=thread?.turns||[]; for(let ti=0; ti<turns.length; ti++){ const turn=turns[ti]; const syntheticImageTail=!turn?.startedAt&&!turn?.completedAt&&ti===turns.length-1&&(turn.items||[]).every((item:any)=>item?.type==='imageGeneration'&&String(item.id||'').startsWith('generated-')); if(syntheticImageTail) continue; for(const item of turn.items||[]){const ev=itemToEvent(item); if(ev) out.push(ev)} } return out; }
function userContent(content:any[]){ const text:string[]=[]; const attachments:Attachment[]=[]; for(const c of content||[]){ if(c.type==='text' && String(c.text||'').trim() && !String(c.text||'').includes(MOBILE_CONTEXT_MARKER)) text.push(c.text); if((c.type==='localImage'||c.type==='image')&&(c.viewerUrl||c.url)) attachments.push({id:c.path||c.url,name:'image',type:'image',size:0,url:c.viewerUrl||c.url}); } return {text:text.join('\n'),attachments}; }
function itemToEvent(item:any):DisplayEvent|null{
  if(item.type==='userMessage'){ const c=userContent(item.content); return (c.text.trim() || c.attachments.length) ? {key:item.id,role:'user',text:c.text,attachments:c.attachments} : null; }
  if(item.type==='agentMessage') {
    const text = String(item.text || '').trim();
    if (!text) return null;
    const artifacts = Array.isArray(item.artifacts) ? item.artifacts : [];
    const artifactImages = artifacts.filter((a:any)=>String(a.type||'').startsWith('image/'));
    const artifactFiles = artifacts.filter((a:any)=>!String(a.type||'').startsWith('image/'));
    return {key:item.id,role:'assistant',text,meta:item.phase==='final_answer'?'最终回答':'回复',images:[...extractMarkdownImages(text),...artifactImages],files:[...extractFileLinks(text),...artifactFiles]};
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
  let started=false;
  let completedTurn=false;
  for(const m of items){
    const item=m.params?.item;
    if(m.type==='error') out.push({key:'e'+out.length,role:'system',text:'请求失败：'+m.error});
    if(m.type==='system' && String(m.text||'').trim()) out.push({key:'s'+out.length,role:'system',text:m.text});
    if(m.type==='user' && (String(m.text||'').trim() || m.attachments?.length)) out.push({key:'u'+out.length,role:'user',text:m.text||'',attachments:m.attachments||[]});
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
function liveStatus(items:any[], fallback?:string){
  let s=fallback||'idle';
  for(const m of items){
    if(m.type==='codex'&&isRunningSignal(m)) s='running';
    if(m.type==='codex'&&isTerminalSignal(m)) s='idle';
    if(m.type==='system'&&m.text?.includes('停止')) s='interrupted';
  }
  return s;
}
function normalizeTurnStatus(value:any):'idle'|'running'|'completed'|'interrupted'|'unknown'{
  const s=String(value||'');
  if(s==='running'||s==='active') return 'running';
  if(s==='completed') return 'completed';
  if(s==='interrupted'||s==='failed') return 'interrupted';
  if(s==='idle'||s==='notLoaded') return 'idle';
  return 'unknown';
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
function sendMessage(ws:WebSocket, sessionId:string, payload:{text:string;attachments:Attachment[]}){ const slim={text:payload.text,attachments:payload.attachments.map(a=>({id:a.id,name:a.name,type:a.type,size:a.size}))}; const text=JSON.stringify(slim); if(text.length<=CHUNK_SIZE){ ws.send(JSON.stringify({type:'send',sessionId,...slim})); return; } const messageId=`${Date.now()}-${Math.random().toString(36).slice(2)}`; ws.send(JSON.stringify({type:'sendChunkStart',sessionId,messageId})); for(let i=0;i<text.length;i+=CHUNK_SIZE) ws.send(JSON.stringify({type:'sendChunk',messageId,chunk:text.slice(i,i+CHUNK_SIZE)})); ws.send(JSON.stringify({type:'sendChunkEnd',messageId})); }
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
    const images = [...(e.attachments||[]),...(e.images||[])];
    const files = e.files || [];
    if (!e.text.trim() && !images.length && !files.length) return null;
    return <article className={`bubble ${e.role}`}><div className="bubbleHead"><span>{e.role==='user'?'你':e.meta||e.title||'回复'}</span>{e.text.trim()&&<CopyButton text={e.text} onDone={(ok)=>toast(ok?'success':'error',ok?'已复制':'复制失败')}/>}</div>{!!e.text.trim()&&<Markdown text={e.text}/>}<ImageGrid images={images} onOpen={onImage}/><FileGrid files={files}/></article>;
  }
  return <details className={`event ${e.role}`} open={e.open}><summary><b>{e.title||e.role}</b>{e.meta&&<span>{e.meta}</span>}</summary><CopyButton text={e.text} onDone={(ok)=>toast(ok?'success':'error',ok?'已复制':'复制失败')}/><pre>{e.text}</pre></details>;
}
function ApprovalCard({req,busy,onAnswer}:{req:ApprovalRequest;busy:boolean;onAnswer:(req:ApprovalRequest,decision:'accept'|'decline')=>void}){
  const info = approvalInfo(req);
  return <article className="approvalCard" role="group" aria-label="Codex 授权请求">
    <div className="approvalHead"><b>{info.title}</b><span>{info.reason || '等待你确认后继续'}</span></div>
    {info.command&&<pre>{info.command}</pre>}
    {info.cwd&&<small>{info.cwd}</small>}
    {!!info.details.length&&<ul>{info.details.map((d,i)=><li key={i}>{d}</li>)}</ul>}
    <div className="approvalActions"><button disabled={busy} onClick={()=>onAnswer(req,'decline')}>拒绝</button><button className="primary" disabled={busy} onClick={()=>onAnswer(req,'accept')}>{busy?'处理中':'允许'}</button></div>
  </article>;
}
function approvalInfo(req:ApprovalRequest){
  const p=req.params||{};
  const title = req.method.includes('fileChange') ? '允许文件修改？' : req.method.includes('permissions') ? '允许提升权限？' : '允许执行命令？';
  const command = typeof p.command === 'string' ? p.command : Array.isArray(p.command) ? p.command.join(' ') : '';
  const details:string[] = [];
  if (p.grantRoot) details.push(`写入范围：${p.grantRoot}`);
  if (p.permissions) details.push(`权限：${compactJson(p.permissions)}`);
  if (p.commandActions?.length) details.push(...p.commandActions.slice(0,3).map((x:any)=>String(x.type || x.action || compactJson(x))));
  return { title, command, cwd:p.cwd || '', reason:p.reason || '', details };
}
function compactJson(value:any){ try { return JSON.stringify(value).slice(0, 180); } catch { return String(value).slice(0, 180); } }
function CopyButton({text,onDone}:{text:string;onDone:(ok:boolean)=>void}){ const [ok,setOk]=useState(false); return <button className={`copyBtn ${ok?'ok':''}`} aria-label="复制" onClick={async()=>{ try{ await navigator.clipboard.writeText(text); setOk(true); onDone(true); setTimeout(()=>setOk(false),1200); } catch{ onDone(false); } }}>{ok?'已复制':'复制'}</button>; }
function Markdown({text}:{text:string}){ const blocks=parseMarkdown(text); return <div className="md">{blocks.map((b,i)=>{ if(b.type==='code') return <CodeBlock key={i} code={b.text} lang={b.lang}/>; if(b.type==='quote') return <blockquote key={i}>{renderInlineMarkdown(b.text)}</blockquote>; if(b.type==='table') return <TableBlock key={i} rows={b.rows}/>; if(b.type==='list') return <ul key={i}>{b.items.map((x:string,j:number)=><li key={j}>{renderInlineMarkdown(x)}</li>)}</ul>; if(b.type==='heading') return <h3 key={i}>{renderInlineMarkdown(b.text)}</h3>; return <p key={i}>{renderInlineMarkdown(b.text)}</p>; })}</div>; }
function parseMarkdown(text:string){ const lines=text.split('\n'); const blocks:any[]=[]; const listRe=/^\s*(?:[-*]|\d+[.)])\s+/; for(let i=0;i<lines.length;i++){ const line=lines[i]; if(line.startsWith('```')){ const lang=line.slice(3).trim(); const code:string[]=[]; i++; while(i<lines.length&&!lines[i].startsWith('```')) code.push(lines[i++]); blocks.push({type:'code',lang,text:code.join('\n')}); } else if(listRe.test(line)){ const items=[line.replace(listRe,'')]; while(i+1<lines.length&&listRe.test(lines[i+1])) items.push(lines[++i].replace(listRe,'')); blocks.push({type:'list',items}); } else if(line.includes('|')&&i+1<lines.length&&/^\s*\|?[-:| ]+\|?\s*$/.test(lines[i+1])){ const rows=[line,lines[++i]]; while(i+1<lines.length&&lines[i+1].includes('|')) rows.push(lines[++i]); blocks.push({type:'table',rows}); } else if(line.startsWith('>')) blocks.push({type:'quote',text:line.replace(/^>\s?/, '')}); else if(/^#{1,4}\s+/.test(line)) blocks.push({type:'heading',text:line.replace(/^#{1,4}\s+/, '')}); else if(line.trim()) blocks.push({type:'p',text:line}); } return blocks; }
function CodeBlock({code,lang}:{code:string;lang:string}){ const toast=useToast(); return <div className="codeBlock"><div><span>{lang||'code'}</span><CopyButton text={code} onDone={(ok)=>toast(ok?'success':'error',ok?'已复制代码':'复制失败')}/></div><pre><code>{code}</code></pre></div>; }
function TableBlock({rows}:{rows:string[]}){ const parsed=rows.filter((_,i)=>i!==1).map(r=>r.split('|').map(c=>c.trim()).filter(Boolean)); return <div className="tableWrap"><table><tbody>{parsed.map((r,i)=><tr key={i}>{r.map((c,j)=>i?<td key={j}>{c}</td>:<th key={j}>{c}</th>)}</tr>)}</tbody></table></div>; }
function renderInlineMarkdown(line:string){ const parts=line.split(/(`[^`]+`|\*\*[^*]+\*\*|!\[[^\]]*\]\([^)]+\)|(?<!!)\[[^\]]+\]\([^)]+\))/g); return parts.map((p,i)=>{ const img=p.match(/^!\[([^\]]*)\]\(([^)]+)\)$/); if(img) return <img className="inlineImage" key={i} alt={img[1]} src={img[2]}/>; const link=p.match(/^\[([^\]]+)\]\(([^)]+)\)$/); if(link) return <a key={i} href={link[2]} target="_blank" rel="noreferrer" download={isDownloadUrl(link[2])?fileNameFromUrl(link[2]):undefined}>{link[1]}</a>; if(/^`[^`]+`$/.test(p)) return <code key={i}>{p.slice(1,-1)}</code>; if(/^\*\*[^*]+\*\*$/.test(p)) return <strong key={i}>{p.slice(2,-2)}</strong>; return <React.Fragment key={i}>{p}</React.Fragment>; }); }
function extractMarkdownImages(text:string):Attachment[]{ return [...text.matchAll(/!\[([^\]]*)\]\((https?:\/\/[^)]+|\/[^)]+)\)/g)].map((m,i)=>({id:m[2]+i,name:m[1]||'image',type:'image',size:0,url:m[2]})); }
function extractFileLinks(text:string):Attachment[]{
  const links = new Map<string,string>();
  for (const m of text.matchAll(/(?<!!)\[([^\]]+)\]\((https?:\/\/[^)]+|\/[^)]+)\)/g)) if(isDownloadUrl(m[2])) links.set(m[2], m[1]);
  for (const m of text.matchAll(/(^|\s)((?:https?:\/\/[^\s)]+|\/[^\s)]+)\.(?:conf|zip|txt|log|patch|diff|json|csv|tar\.gz))(?:\s|$)/g)) if(isDownloadUrl(m[2])) links.set(m[2], fileNameFromUrl(m[2]));
  return [...links].map(([url,label],i)=>({id:url+i,name:fileNameFromUrl(url) || label || 'download',type:fileTypeFromUrl(url),size:0,url}));
}
function ImageGrid({images,onOpen}:{images:Attachment[];onOpen:(a:Attachment)=>void}){ if(!images.length)return null; return <div className="imageGrid">{images.map(img=><button className="thumb" key={img.id} onClick={()=>onOpen(img)}><img src={img.previewUrl||img.url} alt={img.name}/></button>)}</div>; }
function FileGrid({files}:{files:Attachment[]}){ if(!files.length)return null; return <div className="fileGrid">{files.map(f=><a className="fileCard" key={f.id} href={f.url} download={f.name} target="_blank" rel="noreferrer"><span className="fileIcon">↓</span><span><b>{f.name}</b><small>{f.type || 'download'}</small></span></a>)}</div>; }
function isDownloadUrl(url:string){ try { const u=new URL(url, location.origin); if(u.origin!==location.origin) return false; return /^\/api\/(?:wireguard\/config|files|sessions\/[^/]+\/(?:attachments|files))\//.test(u.pathname) || /\.(conf|zip|txt|log|patch|diff|json|csv|tar\.gz)$/i.test(u.pathname); } catch { return false; } }
function fileNameFromUrl(url:string){ try { const u=new URL(url, location.origin); return decodeURIComponent(u.pathname.split('/').filter(Boolean).pop() || 'download'); } catch { return 'download'; } }
function fileTypeFromUrl(url:string){ const name=fileNameFromUrl(url); const ext=name.includes('.')?name.split('.').slice(1).join('.').toLowerCase():'file'; return ext==='conf'?'WireGuard 配置':ext.toUpperCase(); }
function AttachmentTray({items,onRemove,onOpen}:{items:Attachment[];onRemove:(id:string)=>void;onOpen:(a:Attachment)=>void}){ return <div className="attachTray">{items.map(a=><div className={`attachItem ${a.error?'bad':''}`} key={a.id}><button onClick={()=>onOpen(a)}><img src={a.previewUrl||a.url} alt={a.name}/></button><span>{a.uploading?'上传中':a.error||formatSize(a.size)}</span><button aria-label="移除图片" onClick={()=>onRemove(a.id)}>×</button></div>)}</div>; }
function ImageViewer({image,onClose}:{image:Attachment;onClose:()=>void}){ const toast=useToast(); const src=image.previewUrl||image.url; return <div className="viewer" onClick={onClose}><header><button onClick={onClose}>关闭</button><button onClick={async(e)=>{e.stopPropagation(); try{await navigator.clipboard.writeText(src); toast('success','已复制链接');}catch{toast('error','复制失败')}}}>复制链接</button><a href={src} download target="_blank" rel="noreferrer">保存</a></header><img src={src} alt={image.name}/></div>; }
function DiffPanel({diff,onClose}:{diff:string;onClose:()=>void}){ return <section className="diff"><header><b>Diff</b><button onClick={onClose}>关闭</button></header><pre>{diff}</pre></section>; }
function QuotaSheet({quota,onRefresh,onClose}:{quota:any;onRefresh:()=>void;onClose:()=>void}){
  const account=quota?.account?.account || quota?.account;
  const limit=quota?.rateLimits?.rateLimitsByLimitId?.codex || quota?.rateLimits?.rateLimits;
  const email = findDeepEmail(account);
  const isAntigravity = quota?.providerId === 'antigravity';
  return <Sheet onClose={onClose} title="额度" subtitle={quota?.checkedAt?new Date(quota.checkedAt).toLocaleString():'读取中'} actions={<button onClick={onRefresh}>刷新</button>}>
    <div className="quotaGrid">
      <div className="quotaAccount"><b>账号</b><span>{email || account?.type || '未返回账号'}{account?.planType?` · ${account.planType}`:''}</span></div>
      {quota?.rateLimits?.usageText&&<div className="quotaAccount usageText"><b>Antigravity Usage</b><pre>{quota.rateLimits.usageText}</pre></div>}
      {limit ? <>
        <QuotaBar title="5 小时额度" limitWindow={limit.primary}/>
        <QuotaBar title="周额度" limitWindow={limit.secondary}/>
        <div className="quotaAccount"><b>Credits</b><span>{limit.credits?.unlimited?'不限':limit.credits?.balance?`余额 ${limit.credits.balance}`:limit.credits?.hasCredits?'可用':'0'}</span></div>
      </> : !isAntigravity && <div><b>额度</b><span>没有返回额度数据</span></div>}
      {isAntigravity&&!quota?.rateLimits?.usageText&&<div className="quotaAccount"><b>Antigravity Usage</b><span>{quota?.errors?.rateLimits || 'Google CLI 暂未暴露可读取额度'}</span></div>}
    </div>
    {(quota?.errors?.account||quota?.errors?.rateLimits)&&<pre className="errorText">{[quota?.errors?.account,quota?.errors?.rateLimits].filter(Boolean).join('\n')}</pre>}
  </Sheet>;
}
function findDeepEmail(value:any):string|null{
  if(!value) return null;
  if(typeof value==='string') return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
  if(Array.isArray(value)){ for(const x of value){ const found=findDeepEmail(x); if(found) return found; } return null; }
  if(typeof value==='object'){ for(const key of ['email','email_address','account_email','login']){ const found=findDeepEmail(value[key]); if(found) return found; } for(const x of Object.values(value)){ const found=findDeepEmail(x); if(found) return found; } }
  return null;
}
function SettingsSheet({data,onChanged,onClose}:{data:any;onChanged:()=>any|Promise<any>;onClose:()=>void}){
  const toast=useToast();
  const [localData,setLocalData]=useState<any>(data);
  const [models,setModels]=useState<any>(null);
  const [loginJob,setLoginJob]=useState<any>(null);
  const [agLoginJob,setAgLoginJob]=useState<any>(null);
  const [agCode,setAgCode]=useState('');
  const [deleteProfile,setDeleteProfile]=useState<any>(null);
  const [page,setPage]=useState<'main'|'agent'|'mode'|'model'|'account'>('main');
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
  useEffect(()=>{ if(!loginJob?.id || loginJob.status!=='running') return; const timer=window.setInterval(async()=>{ try{ const r=await api('/api/profile-login/'+loginJob.id); setLoginJob(r.job); if(r.job.status!=='running'){ window.clearInterval(timer); await syncSettings(); toast(r.job.status==='done'?'success':'error', r.job.status==='done'?'登录完成':'登录未完成'); } }catch{} },1500); return()=>window.clearInterval(timer); },[loginJob?.id,loginJob?.status]);
  useEffect(()=>{ if(!agLoginJob?.id || agLoginJob.status!=='running') return; const timer=window.setInterval(async()=>{ try{ const r=await api('/api/antigravity-login/'+agLoginJob.id); setAgLoginJob(r.job); if(r.job.status!=='running'){ window.clearInterval(timer); await syncSettings(); toast(r.job.status==='done'?'success':'error', r.job.status==='done'?'登录完成':'登录失败'); } }catch{} },1500); return()=>window.clearInterval(timer); },[agLoginJob?.id,agLoginJob?.status]);
  async function setActiveProvider(provider:string){ setLocalData((d:any)=>({...d,settings:{...(d?.settings||{}),activeProvider:provider}})); try{ await api('/api/settings',{method:'PATCH',body:JSON.stringify({activeProvider:provider})}); haptic(); toast('success','Agent 已切换'); syncSettings().catch(()=>{}); } catch(e:any){ toast('error','切换失败：'+shortError(e)); await syncSettings().catch(()=>{}); } }
  async function setDefaultMode(mode:string){ try{ await api('/api/settings',{method:'PATCH',body:JSON.stringify({defaultMode:mode})}); haptic(); toast('success','已更新'); await syncSettings(); } catch(e:any){ toast('error','更新失败：'+shortError(e)); } }
  async function setDefaultModel(model:string){ try{ await api('/api/settings',{method:'PATCH',body:JSON.stringify({defaultModel:model,provider:activeProvider})}); setLocalData((d:any)=>({...d,settings:{...(d?.settings||{}),defaultModel:model,defaultModels:{...(d?.settings?.defaultModels||{}),[activeProvider]:model}}})); haptic(); toast('success','模型已更新'); await syncSettings(); } catch(e:any){ toast('error','更新失败：'+shortError(e)); } }
  async function switchProfile(id:string){ try{ await api(`/api/profiles/${id}/switch`,{method:'POST'}); markActiveProfile(id); haptic(); toast('success','切换成功'); } catch(e:any){ toast('error','切换失败：'+shortError(e)); } finally { await syncSettings(); } }
  async function deviceLogin(id:string, isNew=false){ try{ const r=await api(`/api/profiles/${id}/login/device`,{method:'POST',body:JSON.stringify({newProfile:isNew})}); setLoginJob(r.job); toast('info','登录流程已启动'); } catch(e:any){ toast('error','登录启动失败：'+shortError(e)); } }
  async function loginNewProfile(){ try{ const r=await api('/api/profiles',{method:'POST',body:JSON.stringify({name:'Codex Account'})}); await deviceLogin(r.profile.id, true); } catch(e:any){ toast('error','登录启动失败：'+shortError(e)); } }
  async function loginAntigravity(){ try{ const r=await api('/api/antigravity/profiles/login',{method:'POST'}); setAgLoginJob(r.job); setAgCode(''); toast('info','Antigravity 登录已启动'); } catch(e:any){ toast('error','登录启动失败：'+shortError(e)); } }
  async function submitAntigravityCode(){ if(!agLoginJob?.id || !agCode.trim()) return; try{ const r=await api('/api/antigravity-login/'+agLoginJob.id+'/input',{method:'POST',body:JSON.stringify({code:agCode.trim()})}); setAgLoginJob((job:any)=>({...job,...(r.job||{}), codeSubmitted:true})); setAgCode(''); toast('info','授权码已提交，正在确认登录'); } catch(e:any){ toast('error','提交失败：'+shortError(e)); } }
  async function switchAntigravityProfile(id:string){ try{ await api(`/api/antigravity/profiles/${id}/switch`,{method:'POST'}); haptic(); toast('success','切换成功'); await syncSettings(); } catch(e:any){ toast('error','切换失败：'+shortError(e)); } }
  async function removeAntigravityProfile(profile:any){ try{ await api(`/api/antigravity/profiles/${profile.id}`,{method:'DELETE'}); haptic(); toast('success','账户已删除'); await syncSettings(); } catch(e:any){ toast('error','删除失败：'+shortError(e)); } }
  async function removeProfile(profile:any){ try{ await api(`/api/profiles/${profile.id}`,{method:'DELETE'}); haptic(); toast('success','账户已删除'); setDeleteProfile(null); await syncSettings(); } catch(e:any){ toast('error','删除失败：'+shortError(e)); } }
  const currentModel = localData?.settings?.defaultModels ? (localData.settings.defaultModels[activeProvider] || catalogCurrent(models)) : (localData?.settings?.defaultModel || catalogCurrent(models));
  const activeProfile = (localData?.profiles||[]).find((p:any)=>p.active) || localData?.activeProfile;
  const activeAntigravityProfile = (localData?.antigravityProfiles||[]).find((p:any)=>p.active) || localData?.activeAntigravityProfile;
  const codexProfiles = (localData?.profiles?.length ? localData.profiles : (localData?.activeProfile ? [localData.activeProfile] : []));
  const codexProviderStatus = (localData?.providers||[]).find((p:any)=>p.id==='codex');
  const antigravityProviderStatus = (localData?.providers||[]).find((p:any)=>p.id==='antigravity') || localData?.antigravity;
  const activeProviderStatus = activeProvider==='antigravity' ? antigravityProviderStatus : codexProviderStatus;
  const title = page==='main' ? '设置' : page==='agent' ? 'Agent' : page==='mode' ? '沙盒' : page==='model' ? '模型' : `${providerLabel(activeProvider)} 账户`;
  const subtitle = page==='main' ? '会话行为和账户' : page==='agent' ? providerLabel(activeProvider) : page==='mode' ? modeLabel(localData?.settings?.defaultMode) : page==='model' ? (activeProvider==='codex'?modelLabel(currentModel):(activeProviderStatus?.ok?'Antigravity 模型':'Antigravity 未安装')) : (activeProvider==='codex'?profileLabel(activeProfile):(activeProviderStatus?.ok?antigravityProfileLabel(activeAntigravityProfile):'Antigravity 未安装'));
  return <Sheet onClose={onClose} title={title} subtitle={subtitle} actions={page!=='main'?<button onClick={()=>setPage('main')}>返回</button>:undefined}>
    <div className="settingsGrid">
      {page==='main'&&<div className="settingsNav">
        <button onClick={()=>setPage('agent')}><span><b>Agent</b><small>{providerLabel(activeProvider)}{activeProvider==='antigravity'&&!activeProviderStatus?.ok?' · 未安装':''}</small></span><i>›</i></button>
        <button onClick={()=>setPage('mode')}><span><b>沙盒</b><small>{modeLabel(localData?.settings?.defaultMode)}</small></span><i>›</i></button>
        <button onClick={()=>setPage('model')}><span><b>模型</b><small>{activeProviderStatus?.ok ? modelLabel(currentModel) : `${providerLabel(activeProvider)} 未安装`}</small></span><i>›</i></button>
        <button onClick={()=>setPage('account')}><span><b>当前账户</b><small>{activeProvider==='codex'?profileLabel(activeProfile):(activeProviderStatus?.ok?antigravityProfileLabel(activeAntigravityProfile):'Antigravity 未安装')}</small></span><i>›</i></button>
      </div>}
      {page==='agent'&&<section><b>Agent</b><div className="providerChoices">
        <button className={activeProvider==='codex'?'active':''} onClick={()=>setActiveProvider('codex')}><span><b>Codex</b><small>{codexProviderStatus?.ok ? codexProviderStatus.version : (codexProviderStatus?.error || 'Codex CLI 不可用')}</small></span><i/></button>
        <button className={activeProvider==='antigravity'?'active':''} onClick={()=>setActiveProvider('antigravity')}><span><b>Antigravity</b><small>{antigravityProviderStatus?.ok ? antigravityProviderStatus.version : (antigravityProviderStatus?.error || '未安装')}</small></span><i/></button>
      </div>{activeProvider==='antigravity'&&!activeProviderStatus?.ok&&<InlineNotice tone="info" text={activeProviderStatus?.installHint || '需要先安装官方 CLI 后才能登录和创建 Antigravity 会话。'}/>}</section>}
      {page==='mode'&&<section><b>沙盒</b><ModeButtons value={localData?.settings?.defaultMode || 'yolo'} onPick={setDefaultMode}/></section>}
      {page==='model'&&<section><b>模型</b>{models?.error&&<InlineNotice tone="info" text={models.error}/>}<ModelPicker models={models?.models||[]} value={currentModel} emptyText={models ? '没有可用模型' : `正在读取 ${providerLabel(activeProvider)} 模型列表`} onPick={setDefaultModel}/></section>}
      {page==='account'&&activeProvider==='codex'&&<><section><b>账户</b><div className="profileList">{codexProfiles.map((p:any)=><ProfileRow key={p.id} profile={p} onSwitch={switchProfile} onLogin={deviceLogin} onDelete={setDeleteProfile}/>)}</div></section><section><b>添加账户</b><button onClick={loginNewProfile}>登录新账户</button></section>{loginJob&&<LoginJobPanel job={loginJob}/>}</>}
      {page==='account'&&activeProvider==='antigravity'&&<section><b>账户</b><div className="profileList">{(localData?.antigravityProfiles||[]).map((p:any)=><AntigravityProfileRow key={p.id} profile={p} onSwitch={switchAntigravityProfile} onDelete={removeAntigravityProfile}/>)}</div><button disabled={!activeProviderStatus?.ok || agLoginJob?.status==='running'} onClick={loginAntigravity}>登录新 Google 账户</button>{!activeProviderStatus?.ok&&<div className="empty"><b>Antigravity 未安装</b><span>安装后才能登录 Google 账户。</span></div>}{agLoginJob&&<AntigravityLoginPanel job={agLoginJob} code={agCode} onCode={setAgCode} onSubmit={submitAntigravityCode}/>}</section>}
    </div>
    {deleteProfile&&<ConfirmDialog title="删除账户？" detail={`删除 ${profileLabel(deleteProfile)} 的本地登录配置。当前账户不能删除。`} confirm="删除" onCancel={()=>setDeleteProfile(null)} onConfirm={()=>removeProfile(deleteProfile)}/>}
  </Sheet>;
}
function mergeSettingsData(current:any, next:any){
  if(!current?.profiles?.length || !next?.profiles?.length) return next;
  const byId = new Map(next.profiles.map((p:any)=>[p.id,p]));
  const ordered = current.profiles.map((p:any)=>byId.get(p.id)).filter(Boolean);
  for(const p of next.profiles) if(!current.profiles.some((x:any)=>x.id===p.id)) ordered.push(p);
  return {...next, profiles:activeFirst(ordered)};
}
function activeFirst(profiles:any[]){ return [...profiles].sort((a:any,b:any)=>Number(b.active || 0)-Number(a.active || 0)); }
function ProfileRow({profile,onSwitch,onLogin,onDelete}:{profile:any;onSwitch:(id:string)=>void;onLogin:(id:string)=>void;onDelete:(p:any)=>void}){
  const loggedIn = !!profile.login?.ok;
  const active = !!profile.active;
  return <div className="profileRow">
    <div><strong>{profileLabel(profile)}</strong><span className="profileBadges">{active&&<i>当前</i>}<i>{loggedIn?'已登录':'未登录'}</i>{profile.login?.email&&<em>{profile.login.email}</em>}</span></div>
    {!active&&loggedIn&&<button onClick={()=>onSwitch(profile.id)}>切换</button>}
    {!loggedIn&&<button onClick={()=>onLogin(profile.id)}>登录</button>}
    <button className="dangerText" onClick={()=>onDelete(profile)} disabled={active&&loggedIn}>删除</button>
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
function AntigravityLoginPanel({job,code,onCode,onSubmit}:{job:any;code:string;onCode:(v:string)=>void;onSubmit:()=>void}){
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
      <small>{job.status==='running'?(submitted?'已提交授权码，正在等待 Antigravity 确认登录':'完成 Google 登录后，把页面上的授权码粘贴到这里。'):job.status==='done'?'登录完成':'登录失败，未完成账户会自动清理'}</small>
    </div>
  </section>;
}
function stripAnsi(text:string){ return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g,''); }
function extractDeviceCode(text:string){
  const cleaned=text.replace(/[^A-Za-z0-9-]+/g,' ');
  const match=cleaned.match(/\b([A-Z0-9]{4})\s*-\s*([A-Z0-9]{4,5})\b/i);
  return match ? `${match[1]}-${match[2]}`.toUpperCase() : '';
}
function modelLabel(model?:string){ return model ? model.replace(/^gpt-/, 'GPT-').replace(/^o(\d)/, 'o$1') : '读取中'; }
function catalogCurrent(catalog:any){ return catalog?.current || catalog?.models?.find((m:ModelOption)=>m.isDefault)?.model || catalog?.models?.[0]?.model || ''; }
function modelOptionLabel(model:ModelOption){
  const name = model.displayName || model.model;
  return name === model.model ? name : `${name} (${model.model})`;
}
function ModelPicker({models,value,onPick,emptyText='正在读取模型列表'}:{models:ModelOption[];value:string;onPick:(model:string)=>void;emptyText?:string}){
  return <div className="modelChoices">
    {!models.length&&<div className="modelLoading">{emptyText}</div>}
    {models.map(m=><button key={m.id||m.model} className={`modelChoice ${value===m.model?'active':''}`} onClick={()=>onPick(m.model)}><span><b>{modelOptionLabel(m)}</b>{m.description&&<small>{m.description}</small>}</span><i/></button>)}
  </div>;
}
function ModelSheet({models,value,busy,onPick,onClose}:{models:ModelOption[];value:string;busy:boolean;onPick:(model:string)=>void;onClose:()=>void}){
  return <Sheet className="modelSheet" onClose={onClose} title="切换模型" subtitle="从下一条消息开始生效"><ModelPicker models={models} value={value} onPick={m=>!busy&&onPick(m)}/></Sheet>;
}
function ModeButtons({value,onPick}:{value:string;onPick:(mode:string)=>void}){ return <div className="modeButtons"><button className={value==='yolo'?'active':''} onClick={()=>onPick('yolo')}>YOLO</button><button className={value==='workspace-write'?'active':''} onClick={()=>onPick('workspace-write')}>Workspace</button><button className={value==='read-only'?'active':''} onClick={()=>onPick('read-only')}>Read Only</button></div>; }
function QuotaBar({title,limitWindow}:{title:string;limitWindow:any}){
  const used=Math.max(0,Math.min(100,Math.round(limitWindow?.usedPercent || 0)));
  const remaining=100-used;
  const tone=remaining>50?'good':remaining>20?'warn':'danger';
  return <div className={`quotaCard ${tone}`}><div className="quotaLine"><b>{title}</b><strong>剩余 {remaining}%</strong></div><div className="quotaTrack" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={remaining} aria-label={`${title}剩余额度`}><i style={{width:`${remaining}%`}}/></div><span>已用 {used}% · {limitWindow?.windowDurationMins?quotaDuration(limitWindow.windowDurationMins):'滚动窗口'}{limitWindow?.resetsAt?` · 重置 ${new Date(limitWindow.resetsAt*1000).toLocaleString()}`:''}</span></div>;
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
function quotaDuration(mins:number){ if(mins===300)return '5 小时窗口'; if(mins===10080)return '7 天窗口'; if(mins%60===0)return `${mins/60} 小时窗口`; return `${mins} 分钟窗口`; }
function Sheet({children,title,subtitle,actions,onClose,className=''}:{children:React.ReactNode;title:string;subtitle?:string;actions?:React.ReactNode;onClose:()=>void;className?:string}){ return <div className="sheetBackdrop" onClick={onClose}><section className={`sheet ${className}`} onClick={e=>e.stopPropagation()}><header><div><b>{title}</b>{subtitle&&<span>{subtitle}</span>}</div><div className="sheetActions">{actions}<button onClick={onClose}>关闭</button></div></header>{children}</section></div>; }
function ConfirmDialog({title,detail,confirm,onCancel,onConfirm}:{title:string;detail:string;confirm:string;onCancel:()=>void;onConfirm:()=>void}){ return <div className="dialogBackdrop"><section className="dialog"><h2>{title}</h2><p>{detail}</p><div><button onClick={onCancel}>取消</button><button className="danger" onClick={onConfirm}>{confirm}</button></div></section></div>; }
function EmptyState({title,detail}:{title:string;detail:string}){ return <div className="empty"><b>{title}</b><span>{detail}</span></div>; }
function LoadingRows({count=4}:{count?:number}){ return <div className="loadingRows" aria-label="正在加载">{Array.from({length:count}).map((_,i)=><div className="skeletonRow" key={i}><i/><span/><small/></div>)}</div>; }
function ErrorState({title,detail,action,onAction}:{title:string;detail:string;action:string;onAction:()=>void}){ return <div className="errorState"><b>{title}</b><span>{detail}</span><button onClick={onAction}>{action}</button></div>; }
function InlineNotice({tone,text}:{tone:'error'|'info';text:string}){ return <div className={`notice ${tone}`}>{text}</div>; }
function draftKey(id:string){ return `agentdeck:draft:${id}`; }
function draftAttachmentsKey(id:string){ return `agentdeck:draftAttachments:${id}`; }
function sequenceKey(id:string){ return `agentdeck:lastSequence:${id}`; }
function loadDraftAttachments(id:string):Attachment[]{
  try {
    const items = JSON.parse(localStorage.getItem(draftAttachmentsKey(id)) || '[]');
    if (!Array.isArray(items)) return [];
    return items.filter((a:any)=>a?.id&&a?.url).map((a:any)=>({ id:String(a.id), name:String(a.name||'image'), type:String(a.type||'image'), size:Number(a.size||0), url:String(a.url) }));
  } catch { return []; }
}
function saveDraftAttachments(id:string, attachments:Attachment[]){
  const saved = attachments.filter(a=>a.id&&a.url&&!a.uploading&&!a.error).map(a=>({ id:a.id, name:a.name, type:a.type, size:a.size, url:a.url }));
  if (saved.length) localStorage.setItem(draftAttachmentsKey(id), JSON.stringify(saved));
  else localStorage.removeItem(draftAttachmentsKey(id));
}

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

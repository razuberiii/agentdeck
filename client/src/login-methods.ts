export type LoginMethodView = {
  id:string;
  methodId:string;
  title:string;
  description:string;
  kind:'oauth'|'api-key'|'vertex'|'gateway'|'unsupported';
  selected?:boolean;
};

export function loginMethodViews(methods:any[]):LoginMethodView[]{
  const rawMethods = (methods || []).map(raw => ({ raw, methodId:String(raw?.id || '').trim() })).filter(x => x.methodId);
  if (!rawMethods.length) return [
    { id:'oauth', methodId:'oauth', title:'Google 登录', description:'使用 Google 账号和订阅额度', kind:'oauth' },
    { id:'api-key', methodId:'api_key', title:'Gemini API Key', description:'使用 Google AI Studio API Key', kind:'api-key' },
    { id:'vertex', methodId:'vertex', title:'Vertex AI', description:'使用 Google Cloud 项目', kind:'vertex' },
  ];
  const byKind = new Map<LoginMethodView['kind'], LoginMethodView>();
  for(const { raw, methodId } of rawMethods){
    const kind = normalizeLoginMethodKind(raw, methodId);
    if (byKind.has(kind)) continue;
    const meta = methodMeta(kind);
    byKind.set(kind, {
      id:kind,
      methodId,
      title:kind === 'unsupported' ? '其他登录方式暂不支持' : meta.title,
      description:kind === 'unsupported' ? '当前 Gemini CLI 返回的方法暂不能在网页中配置' : (raw?.description || meta.description),
      kind,
    });
  }
  return [...byKind.values()].sort((a,b)=>methodOrder(a.kind)-methodOrder(b.kind));
}

function methodOrder(kind:string){ return kind==='oauth'?0:kind==='api-key'?1:kind==='vertex'?2:3; }

function normalizeLoginMethodKind(raw:any, id:string):LoginMethodView['kind']{
  const text=`${raw?.name||''} ${raw?.description||''} ${raw?.type||''} ${id}`.toLowerCase();
  if (/gateway/i.test(text)) return 'gateway';
  if (/vertex|gcp|google cloud/i.test(text)) return 'vertex';
  if (/(api.?key|apikey|google.?ai.?studio|\bapi\b)/i.test(text)) return 'api-key';
  if (/(oauth|google|sign.?in|login)/i.test(text)) return 'oauth';
  return 'unsupported';
}

function methodMeta(kind:LoginMethodView['kind']){
  if (kind === 'oauth') return { title:'Google 登录', description:'使用 Google 账号和订阅额度' };
  if (kind === 'api-key') return { title:'Gemini API Key', description:'使用 Google AI Studio API Key' };
  if (kind === 'vertex') return { title:'Vertex AI', description:'使用 Google Cloud 项目' };
  if (kind === 'gateway') return { title:'Gateway', description:'Gateway 登录方式暂未在网页中启用' };
  return { title:'其他登录方式暂不支持', description:'当前 Gemini CLI 返回的方法暂不能在网页中配置' };
}

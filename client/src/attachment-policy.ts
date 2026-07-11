export type AttachmentCapabilities={imageInput?:boolean;fileInput?:boolean;maxAttachmentBytes:number;maxAttachmentsPerMessage?:number;maxTotalAttachmentBytes?:number;providers?:Record<string,{imageInput?:boolean;fileInput?:boolean}>};

export function providerAttachmentCapabilities(capabilities:AttachmentCapabilities|undefined,provider:string){
  if(!capabilities)return undefined;
  return {...capabilities,...(capabilities.providers?.[provider]||{})};
}

export function attachmentLimitError(existing:{size?:number}[],file:{size:number},capabilities:AttachmentCapabilities){
  const maxCount=capabilities.maxAttachmentsPerMessage||10;
  const maxTotal=capabilities.maxTotalAttachmentBytes||maxCount*capabilities.maxAttachmentBytes;
  if(existing.length>=maxCount)return `最多添加 ${maxCount} 个附件`;
  if(existing.reduce((sum,item)=>sum+Number(item.size||0),0)+file.size>maxTotal)return `附件总大小超过 ${maxTotal}`;
  return '';
}

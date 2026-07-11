export async function withReceiptFailure<T>(execute:()=>Promise<T>,fail:(message:string)=>Promise<void>){
  try{return await execute();}
  catch(error:any){await fail(error?.message||String(error));throw error;}
}

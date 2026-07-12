export class KeyedSerialQueue {
  #tails=new Map<string,Promise<unknown>>();

  run<T>(key:string,task:()=>Promise<T>):Promise<T>{
    const previous=this.#tails.get(key)??Promise.resolve();
    const current=previous.catch(()=>undefined).then(task);
    this.#tails.set(key,current);
    current.finally(()=>{if(this.#tails.get(key)===current)this.#tails.delete(key);}).catch(()=>undefined);
    return current;
  }
}

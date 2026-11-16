import { HttpError } from "./security";
export class Router {
  routes: {method:string;path:string;fn:any}[]=[];
  get(path:string,fn:any){this.routes.push({method:'GET',path,fn})}
  post(path:string,fn:any){this.routes.push({method:'POST',path,fn})}
  patch(path:string,fn:any){this.routes.push({method:'PATCH',path,fn})}
  delete(path:string,fn:any){this.routes.push({method:'DELETE',path,fn})}
  put(path:string,fn:any){this.routes.push({method:'PUT',path,fn})}
  async handle(request:Request,env:Env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      const origin=request.headers.get('Origin');
      if (['POST','PATCH','DELETE','PUT'].includes(request.method) && origin && new URL(origin).origin!==url.origin) throw new HttpError(403,'Bad origin');
      for (const r of this.routes) {
        if(r.method!==request.method)continue;
        const keys:string[]=[];
        const re=new RegExp('^'+r.path.replace(/:([^/]+)/g,(_,k)=>{keys.push(k);return '([^/]+)'})+'$');
        const m=url.pathname.match(re);if(!m)continue;
        const params=Object.fromEntries(keys.map((k,i)=>[k,decodeURIComponent(m[i+1])]));
        if(Number(request.headers.get('content-length')||0)>200_000)throw new HttpError(413,'Request is too large');
        const raw=['POST','PATCH','PUT'].includes(request.method)?await request.text():'';
        if(raw.length>200_000)throw new HttpError(413,'Request is too large');
        const req={params, query:Object.fromEntries(url.searchParams), body:raw?JSON.parse(raw):{}, headers:Object.fromEntries(request.headers),get:(k:string)=>request.headers.get(k)};
        let status=200;const headers=new Headers();let response:Response|undefined;
        const res:any={
          status:(s:number)=>{status=s;return res},
          set:(h:Record<string,string>)=>{for(const [k,v] of Object.entries(h))headers.set(k,v);return res},
          cookie:(key:string,val:string,opt:any)=>{headers.append('Set-Cookie',`${key}=${val}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(opt.maxAge/1000)}${opt.secure?'; Secure':''}`);return res},
          clearCookie:(key:string)=>{headers.append('Set-Cookie',`${key}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);return res},
          json:(data:any)=>{headers.set('Content-Type','application/json');response=new Response(JSON.stringify(data),{status,headers});return res},
          send:(data:string)=>{response=new Response(data,{status,headers});return res},
        };
        await r.fn(req,res);
        return response??Response.json({error:'Empty response'},{status:500});
      }
      return Response.json({error:'Not found'},{status:404});
    }catch(e:any){
      if(e instanceof HttpError)return Response.json({error:e.message,...(e.fields?{fields:e.fields}:{})},{status:e.status});
      console.error(JSON.stringify({error:e.message,cause:e.cause?.message}));
      return Response.json({error:'Something went wrong. Try again.'},{status:500});
    }
  }
}

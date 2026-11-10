import { createHash, randomUUID } from "node:crypto";
import { expect } from "vitest";
import type { SessionArchiveStatus } from "../../../src/session/archive.js";

export const archiveTestReceiver = (options: { bodies: string[]; sourceThrough: string; fail?:()=>boolean; onManifest?:(body:string)=>Response; onRequest?:(method:string,path:string)=>void }) => {
 const files=new Map<string,Buffer>(), receipts=new Map<string,Record<string,unknown>>();
 let recordId="",phase="settling",resources:unknown[]=[],current:SessionArchiveStatus={state:"unavailable",sha256:null,byteLength:null,errorCode:null};
 const digest=(data:Uint8Array|string)=>createHash("sha256").update(data).digest("hex");
 const prepare=()=>({recordId,phase,resources:phase==="sealed"?resources:[],timelineRevision:phase==="sealed"?"1":null,error:null,historyEpoch:"test-history",sourceThrough:options.sourceThrough});
 const request:typeof fetch=async (input,init)=>{
  const url=new URL(String(input)),method=init?.method??"GET",pathname=url.pathname;options.onRequest?.(method,pathname);
  if(method==="POST"&&pathname.endsWith("/source-tail")){const body=JSON.parse(String(init?.body));return Response.json({sourceEpoch:body.sourceEpoch,batchId:body.batchId,lastAckedSourceSeq:body.events.at(-1).sourceSeq})}
  if(method==="POST"&&pathname.endsWith("/prepare")){recordId=JSON.parse(String(init?.body)).fence.sessionId;return Response.json(prepare())}
  if(method==="POST"&&pathname.endsWith("/seal")){phase="sealed";return Response.json(prepare())}
  if(method==="GET"&&pathname.endsWith("/archive"))return Response.json({archive:current});
  const match=pathname.match(/\/(history|files)\/([^/]+)(\/status)?$/);
  if(match){const [,kind,id]=match;const receipt=receipts.get(id!);
   if(method==="GET")return receipt?Response.json(receipt):new Response(null,{status:404});
   const headers=new Headers(init?.headers),block=Buffer.from(init!.body as Uint8Array),offset=Number(url.searchParams.get("offset"));
   expect(headers.get("Daynight-Chunk-SHA256")).toBe(digest(block));
   const before=files.get(id!)??Buffer.alloc(0);expect(offset).toBe(before.length);
   const next=Buffer.concat([before,block]);files.set(id!,next);
   const complete=next.length===Number(headers.get("Daynight-File-Byte-Length"));
   if(complete)expect(digest(next)).toBe(headers.get("Daynight-File-SHA256"));
   if(url.searchParams.get("purpose")==="resource"&&complete)resources.push({resource:JSON.parse(headers.get("Daynight-Resource-Descriptor")!),blobId:id});
   const result={...(kind==="history"?{syncId:id,timelineRevision:complete?"1":null}:{fileId:id}),state:complete?"complete":"receiving",acceptedOffset:String(next.length),byteLength:headers.get("Daynight-File-Byte-Length"),sha256:headers.get("Daynight-File-SHA256"),error:null};receipts.set(id!,result);return Response.json(result);
  }
  if(method==="PUT"&&pathname.endsWith("/content")){
   const body=String(init!.body);options.bodies.push(body);if(options.fail?.())return new Response(null,{status:503});if(options.onManifest)return options.onManifest(body);
   current={state:"ready",schemaVersion:3,completeness:JSON.parse(body).completeness,sha256:digest(body),byteLength:String(Buffer.byteLength(body)),errorCode:null};return Response.json({archive:current});
  }
  throw new Error(`Unexpected archive request ${method} ${pathname}`);
 };
 return {request,files,receipts,entries:(manifest:string)=>JSON.parse(files.get(JSON.parse(manifest).timeline.fileId)!.toString()).entries};
};

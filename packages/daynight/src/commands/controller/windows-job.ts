import { execFile } from "node:child_process";
const api = `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class DaynightJob {
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs,string name);
 [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int info,IntPtr data,uint size,IntPtr returned);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static void Create(string name,int pid) {
  IntPtr job=CreateJobObject(IntPtr.Zero,name); int error=Marshal.GetLastWin32Error();
  if(job==IntPtr.Zero) throw new Win32Exception(error);
  try { if(error==183) throw new InvalidOperationException("Controller job identity already exists.");
   IntPtr process=OpenProcess(0x101,false,pid); if(process==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
   try { if(!AssignProcessToJobObject(job,process)) throw new Win32Exception(Marshal.GetLastWin32Error()); } finally { CloseHandle(process); }
  } finally { CloseHandle(job); }
 }
 public static long[] Inspect(string name,bool stop) {
  IntPtr job=OpenJobObject(stop?12u:4u,false,name);
  if(job==IntPtr.Zero) { int error=Marshal.GetLastWin32Error(); if(error==2) return null; throw new Win32Exception(error); }
  try {
   if(stop && !TerminateJobObject(job,1)) throw new Win32Exception(Marshal.GetLastWin32Error());
   uint size=262144; IntPtr data=Marshal.AllocHGlobal((int)size);
   try { if(!QueryInformationJobObject(job,3,data,size,IntPtr.Zero)) throw new Win32Exception(Marshal.GetLastWin32Error());
    int count=Marshal.ReadInt32(data,4); if(count<0 || 8L+(long)count*IntPtr.Size>size) throw new InvalidOperationException("Invalid job process inventory.");
    long[] ids=new long[count]; for(int i=0;i<count;i++) ids[i]=Marshal.ReadIntPtr(data,8+i*IntPtr.Size).ToInt64(); return ids;
   } finally { Marshal.FreeHGlobal(data); }
  } finally { CloseHandle(job); }
 }
}
`;
const invoke = async (command: string): Promise<string> => {
  const script = `$ErrorActionPreference='Stop'\nAdd-Type -TypeDefinition @'\n${api}\n'@\n${command}`;
  return new Promise((resolve,reject) => execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script,"utf16le").toString("base64")], { encoding:"utf8", timeout:15000,maxBuffer:1048576,windowsHide:true },(error,stdout)=>error===null?resolve(stdout):reject(new Error("Windows controller Job Object operation failed.",{cause:error}))));
};
const validate = (name: string): void => { if (!/^Local\\Daynight-[0-9a-f-]{36}$/.test(name)) throw new Error("Invalid controller Job Object identity."); };
/** Job membership survives handle closure while associated processes remain; breakaway is not enabled. */
export const createControllerJob = async (launchId: string, pid: number): Promise<string> => {
  const name = `Local\\Daynight-${launchId}`; validate(name);
  if (!Number.isSafeInteger(pid) || pid<=0) throw new Error("Invalid controller process ID.");
  await invoke(`[DaynightJob]::Create('${name}',${pid})`); return name;
};
export const inspectControllerJob = async (name: string, stop = false): Promise<readonly number[]> => {
  validate(name); const output=await invoke(`$ids=[DaynightJob]::Inspect('${name}',$${stop?'true':'false'}); ConvertTo-Json -InputObject @($ids) -Compress`);
  const value:unknown=JSON.parse(output); if(!Array.isArray(value)||value.some(id=>id!==null&&(!Number.isSafeInteger(id)||id<=0))) throw new Error("Invalid controller Job Object process inventory.");
  return value.filter((id):id is number=>id!==null);
};

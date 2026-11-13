import type { MouseEvent } from 'react';
import type { AssistantTask } from '../../api/assistant-tasks';
import type { BotDefinition } from '../../api/bots';
import { assistantTaskState, assistantTaskUrl } from './assistant-task-data';
import { useAssistantTaskMessages } from './messages';
export function AssistantTaskSection({tasks,bots,selectedId,search,error,busy,onRefresh,onCreate,onWatchdog,follow}: {
  readonly tasks: readonly AssistantTask[] | null; readonly bots: readonly BotDefinition[]; readonly selectedId: string | null; readonly search: string; readonly error: unknown; readonly busy:boolean;
  readonly onRefresh:()=>void; readonly onCreate:()=>void; readonly onWatchdog:()=>void; readonly follow:(event:MouseEvent<HTMLAnchorElement>)=>void;
}) {
  const m = useAssistantTaskMessages(), live = tasks?.filter(t=>t.state !== 'deleted') ?? [], pending = live.filter(t=>t.state !== 'paused' && (t.claimState==='unowned'||t.claimState==='expired')).length;
  return <section className="assistant-task-section" aria-label={m.title}>
    <header className="bot-list-section"><h2>{m.title}<span className="bot-list-count">{tasks ? live.length : ''}</span></h2>{pending ? <span className="assistant-task-badge">{pending} {m.pending}</span>:null}</header>
    {error ? <div className="notice error" role="alert"><p>{m.error}</p><button className="button" type="button" aria-label={`${m.retry} · ${m.title}`} onClick={onRefresh}>{m.retry}</button></div>:null}
    {!tasks && !error ? <p role="status">{m.loading}</p>:null}
    {tasks && !live.length ? <p className="bot-empty">{m.empty}</p>:null}
    <ul className="assistant-task-list">{live.filter(t=>t.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(task=><li key={task.id}><a href={assistantTaskUrl(task.id)} aria-current={selectedId===task.id?'page':undefined} onClick={follow}><span className="assistant-task-icon" aria-hidden="true">{task.application==='watchdog'?'◎':'▤'}</span><span className="bot-list-label"><strong>{task.name}</strong><span className="bot-status"><span>{m[assistantTaskState(task)]}</span>{task.holderBotId ? <span>{bots.find(b=>b.id===task.holderBotId)?.name ?? task.holderBotId}</span>:null}</span></span></a></li>)}</ul>
    <div className="assistant-task-list-actions"><button className="button quiet" type="button" onClick={onCreate}>{m.create}</button><button className="button quiet" type="button" onClick={onWatchdog}>{m.watchdog}</button><button className="button quiet" type="button" aria-label={`${m.refresh} · ${m.title}`} aria-busy={busy} onClick={onRefresh}>{m.refresh}</button></div>
  </section>;
}
export function AssistantTaskOwned({tasks,botId,follow}: {readonly tasks:readonly AssistantTask[];readonly botId:string;readonly follow:(event:MouseEvent<HTMLAnchorElement>)=>void}) {
  const m=useAssistantTaskMessages(), owned=tasks.filter(t=>t.holderBotId===botId && t.state!=='deleted');
  return <section className="bot-details-section"><h3>{m.owned}</h3>{owned.length ? <ul className="assistant-task-owned">{owned.map(t=><li key={t.id}><a href={assistantTaskUrl(t.id)} onClick={follow}>{t.name}</a><span>{m[assistantTaskState(t)]}</span></li>)}</ul>:<p>{m.empty}</p>}</section>;
}

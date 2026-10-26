import { useRef, useState, type KeyboardEvent } from "react";
import { useI18n } from "../../i18n/LocaleProvider";
import { blockedBy, demoTasks, documentIds, receiptIds, sceneIds, taskIds, taskState } from "./demo";
import type { DemoDocumentId, DemoReceiptId, DemoSceneId, DemoTaskId, DemoTaskState } from "./demo";

const Status = ({ state }: { readonly state: DemoTaskState }) => {
  const { messages: { landing: { demo } } } = useI18n();
  return <span className={`demo-status ${state}`}>{demo.states[state]}</span>;
};

export const LandingDemo = () => {
  const { locale, messages: { landing: { demo: m } } } = useI18n();
  const [scene, setScene] = useState<DemoSceneId>("dependencies");
  const [taskId, setTaskId] = useState<DemoTaskId>("email");
  const [documentId, setDocumentId] = useState<DemoDocumentId>("brief");
  const [receiptId, setReceiptId] = useState<DemoReceiptId>("acceptance");
  const sceneButtons = useRef<Partial<Record<DemoSceneId, HTMLButtonElement>>>({});
  const taskButtons = useRef<Partial<Record<DemoTaskId, HTMLButtonElement>>>({});
  const document = m.documents[documentId];
  const receipt = m.receipts[receiptId];
  const task = m.tasks[taskId];
  const state = taskState(taskId);
  const number = (taskIds.indexOf(taskId) + 1).toString().padStart(2, "0");
  const taskNote = state === "done" ? task.result : state === "ready" ? m.readyNote : state === "running" ? m.runningNote :
    m.blockedNote({ tasks: new Intl.ListFormat(locale).format(blockedBy(taskId).map((id) => m.tasks[id].title)) });
  const keyboardScene = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let target: DemoSceneId | undefined;
    if (event.key === "ArrowRight") target = sceneIds[(index + 1) % sceneIds.length];
    if (event.key === "ArrowLeft") target = sceneIds[(index + sceneIds.length - 1) % sceneIds.length];
    if (event.key === "Home") target = sceneIds[0];
    if (event.key === "End") target = sceneIds[sceneIds.length - 1];
    if (target === undefined) return;
    event.preventDefault();
    setScene(target);
    sceneButtons.current[target]!.focus();
  };
  const inspectPrerequisite = (id: DemoTaskId) => {
    setTaskId(id);
    taskButtons.current[id]!.focus({ preventScroll: true });
  };

  return <section className="demo-section" id="demo" tabIndex={-1} aria-labelledby="demo-heading">
    <div className="wrap">
      <div className="demo-intro"><div><p className="eyebrow">{m.eyebrow}</p><h2 className="section-heading" id="demo-heading">{m.title[0]}<br />{m.title[1]}</h2></div><p>{m.intro}</p></div>
      <div className="demo-shell">
        <div className="demo-top"><span className="mark" aria-hidden="true" /><strong>{m.project}</strong><span className="example-label">{m.example}</span><span className="demo-breadcrumb">{m.breadcrumb}</span></div>
        <div className="scene-tabs" role="tablist" aria-label={m.sceneLabel}>
          {sceneIds.map((id, index) => <button key={id} className="scene-tab" type="button" role="tab" aria-label={m.scenes[id].label} id={`tab-${id}`} aria-controls={`scene-${id}`} aria-selected={scene === id} tabIndex={scene === id ? 0 : -1}
            ref={(element) => { if (element === null) delete sceneButtons.current[id]; else sceneButtons.current[id] = element; }}
            onClick={() => setScene(id)} onKeyDown={(event) => keyboardScene(event, index)}>
            <span className="tab-label"><span className="tab-number" aria-hidden="true">{(index + 1).toString().padStart(2, "0")}</span>{m.scenes[id].label}</span><span className="tab-copy">{m.scenes[id].summary}</span>
          </button>)}
        </div>
        {sceneIds.map((id) => <div className="scene" key={id} id={`scene-${id}`} role="tabpanel" aria-labelledby={`tab-${id}`} hidden={scene !== id}>
          <div className="scene-info"><h3>{m.scenes[id].heading}</h3><p>{m.scenes[id].instruction}</p></div>
          {id === "context" && <div className="context-layout">
            <aside className="file-list" aria-label={m.files}><p className="file-label">{m.files}</p>{documentIds.map((file) => <button key={file} className="file-button" type="button" aria-pressed={file === documentId} onClick={() => setDocumentId(file)}><span className="file-icon" aria-hidden="true">▤</span>{m.documents[file].label}</button>)}<p className="context-aside">{m.fileAside}</p></aside>
            <article className="context-document" aria-live="polite"><p className="document-meta">{document.meta}</p><h4>{document.title}</h4>{document.sections.map((section, index) => <div key={index}><h5>{section.title}</h5>{section.body !== undefined && <p>{section.body}</p>}{section.items !== undefined && <ul>{section.items.map((item, itemIndex) => <li key={itemIndex}>{item}</li>)}</ul>}</div>)}<div className="document-callout"><strong>{document.callout.title}</strong><br />{document.callout.body}</div></article>
          </div>}
          {id === "dependencies" && <div className="dependency-layout">
            <div className="task-list" aria-label={m.tasksLabel}>{taskIds.map((id, index) => <div className="chain-row" key={id}><span className={`chain-point ${taskState(id) === "done" ? "done" : ""}`} aria-hidden="true">{taskState(id) === "done" ? "✓" : ""}</span><button className="task-button" type="button" aria-pressed={id === taskId} data-demo-task={id}
              ref={(element) => { if (element === null) delete taskButtons.current[id]; else taskButtons.current[id] = element; }} onClick={() => setTaskId(id)}><span className="task-title"><span className="task-code" aria-hidden="true">{(index + 1).toString().padStart(2, "0")}</span>{m.tasks[id].title}</span>{" "}<Status state={taskState(id)} /></button></div>)}</div>
            <article className="task-detail" aria-live="polite"><div className="detail-overline"><span>{m.task({ number })}</span><Status state={state} /></div><h4>{task.title}</h4><p className="detail-copy">{task.description}</p><div className="detail-section"><h5>{demoTasks[taskId].dependsOn.length > 0 ? m.prerequisites : m.noPrerequisites}</h5>{demoTasks[taskId].dependsOn.length === 0 ? <p className="detail-copy">{m.startingPoint}</p> : <div className="pill-row">{demoTasks[taskId].dependsOn.map((id) => <button key={id} className="dependency-link" type="button" onClick={() => inspectPrerequisite(id)}>{m.tasks[id].title} · {m.states[taskState(id)]} <span aria-hidden="true">↗</span></button>)}</div>}</div><div className="detail-section"><h5>{m.completion}</h5><ul>{task.acceptance.map((item, index) => <li key={index}>{item}</li>)}</ul></div><div className={`blocked-callout ${state === "done" || state === "ready" ? "detail-ready" : ""}`}>{taskNote}</div></article>
          </div>}
          {id === "evidence" && <div className="evidence-layout"><div className="delivery-summary"><p className="eyebrow">{m.completed.eyebrow}</p><h4>{m.completed.title[0]}<br />{m.completed.title[1]}</h4><p>{m.completed.body}</p><div className="delivery-line"><span className="demo-status done">{m.completed.status}</span><p className="delivery-note">{m.completed.note}</p></div></div><div><div className="receipt-tabs" role="group" aria-label={m.receiptsLabel}>{receiptIds.map((id) => <button key={id} className="receipt-tab" type="button" aria-pressed={receiptId === id} onClick={() => setReceiptId(id)}>{m.receiptLabels[id]}</button>)}</div><article className="receipt-content" aria-live="polite"><h4>{receipt.title}</h4>{receipt.records.map((record, index) => receiptId === "acceptance" ? <div className="receipt-item" key={index}><span className="receipt-check" aria-hidden="true">✓</span><span><strong>{record.title}</strong><br />{record.body}</span></div> : <div className="receipt-record" key={index}><h5>{record.title}</h5><p>{record.body}</p></div>)}<p className="receipt-note">{receipt.note}</p></article></div></div>}
        </div>)}
      </div>
      <div className="demo-note"><strong>{m.conclusion}</strong><span>{m.note}</span></div>
    </div>
  </section>;
};

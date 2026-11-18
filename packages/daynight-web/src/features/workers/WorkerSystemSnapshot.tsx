import type { ReactNode } from 'react';
import type { WorkerDetail, WorkerExecutableProbe, WorkerProbe } from '../../api/workers';
import type { WorkerAgent } from '../../api/types';
import type { Tool, ToolPathTelemetry } from '../../api/worker-tool-paths';
import { useI18n } from '../../i18n/LocaleProvider';
import { formatWorkerBytes, WorkerTimestamp } from './presentation';
import { WorkerToolPathDetails } from './WorkerToolPathDetails';
import { toolSoftwareEntries } from './tool-path-presentation';

const agentNames: Readonly<Record<WorkerAgent, string>> = { codex: 'Codex', claude: 'Claude Code', copilot: 'Copilot' };

const ProbeFailure = ({ probe, software = false }: { readonly probe: Extract<WorkerProbe<unknown>, { state: 'error' }>; readonly software?: boolean }) => {
  const { messages: { workers: m } } = useI18n();
  return <><span className="worker-probe-error">{software ? m.detectionError : m.collectionError}</span><span className="worker-probe-reason">{m.probeCodes[probe.code]}</span></>;
};

const CheckedAt = ({ value }: { readonly value: string }) => {
  const { messages: { workers: m } } = useI18n();
  return <p className="worker-checked-at">{m.checkedAt}: <WorkerTimestamp value={value} /></p>;
};

const Meter = ({ value, label, high = false }: { readonly value: number; readonly label: string; readonly high?: boolean }) => <div className={`worker-meter${high ? ' high' : ''}`} role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}><span style={{ width: `${value}%` }} /></div>;

const MetricCard = ({ title, children, checkedAt }: { readonly title: string; readonly children: ReactNode; readonly checkedAt: string }) => <section className="worker-metric-card"><h2 className="worker-metric-label">{title}</h2>{children}<CheckedAt value={checkedAt} /></section>;

const SoftwareRow = ({ name, probe }: { readonly name: string; readonly probe: WorkerExecutableProbe }) => {
  const { messages: { workers: m } } = useI18n();
  return <div className="worker-info-row"><dt>{name}</dt><dd>
    {probe.state === 'ok' ? <span className="worker-software-version">{probe.value}</span> : probe.state === 'error' ? <ProbeFailure probe={probe} software /> : <span className="worker-software-unavailable">{m.notInstalled}</span>}
    <CheckedAt value={probe.checkedAt} />
  </dd></div>;
};

const ToolSoftwareRow = ({ tool, telemetry, online, probe }: { readonly tool: Exclude<Tool, 'herdr'>; readonly telemetry: ToolPathTelemetry | undefined; readonly online: boolean | null; readonly probe: WorkerExecutableProbe }) => {
  const { messages: { workers: { configuration: { toolPaths: m } } } } = useI18n();
  const name = agentNames[tool];
  if (telemetry === undefined) return <SoftwareRow name={name} probe={probe} />;
  const entries = toolSoftwareEntries(telemetry, tool);
  return <div className="worker-info-row worker-software-tool-paths" data-tool={tool}><dt>{name}</dt><dd>
    {entries.length === 0 ? <span className="worker-software-unavailable">{m.state.not_checked}</span> : entries.map(entry => <p className="worker-tool-version" key={entry.context}>
      {entry.actual !== null && <span className="worker-software-version">{entry.actual.version}</span>}{(entry.actual === null || entry.state === 'checking' || entry.state === 'pending' || entry.state === 'error') && <>{entry.actual !== null && ' '}<span className={`worker-tool-state ${entry.state}`}>{m.state[entry.state]}</span></>}
    </p>)}
    <p className="worker-checked-at worker-tool-connection">
      <span className={online === false ? undefined : 'concealed'} aria-hidden={online !== false}>{m.state.offline}</span>
      <span className={online === null ? undefined : 'concealed'} aria-hidden={online !== null}>{m.state.unconfirmed}</span>
    </p>
  </dd><dd className="worker-tool-software-detail-cell">
    <details className="worker-tool-software-details"><summary>{m.details}</summary><WorkerToolPathDetails tool={tool} telemetry={telemetry} online={online} /></details>
  </dd></div>;
};

export const WorkerSystemSnapshot = ({ worker, online, stale, openToolPaths }: { readonly worker: WorkerDetail; readonly online: boolean; readonly stale: boolean; readonly openToolPaths: () => void }) => {
  const { messages: { workers: m }, locale, format } = useI18n();
  const bytes = (value: number) => formatWorkerBytes(value, locale);
  const percent = (value: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
  return <>
      <p className="worker-sample-time">{m.sampledAt}: <WorkerTimestamp value={worker.telemetry.sampledAt} /></p>
      <div className="worker-metric-grid" data-worker-reading>
        <MetricCard title={m.cpuUsage} checkedAt={worker.telemetry.cpu.checkedAt}>{worker.telemetry.cpu.state === 'error' ? <ProbeFailure probe={worker.telemetry.cpu} /> : <>
          <p className="worker-metric-value">{percent(worker.telemetry.cpu.value.usagePercent)}<span className="worker-metric-unit">%</span></p><Meter value={worker.telemetry.cpu.value.usagePercent} label={m.cpuUsage} /><p className="worker-metric-detail">{worker.telemetry.cpu.value.model} · {m.logicalProcessors({ count: format.number(worker.telemetry.cpu.value.logicalProcessors) })}</p>
        </>}</MetricCard>
        <MetricCard title={m.memory} checkedAt={worker.telemetry.memory.checkedAt}>{worker.telemetry.memory.state === 'error' ? <ProbeFailure probe={worker.telemetry.memory} /> : <>
          <p className="worker-metric-value">{bytes(worker.telemetry.memory.value.usedBytes)}<span className="worker-metric-unit">{m.usedCapacity({ total: bytes(worker.telemetry.memory.value.totalBytes) })}</span></p>
          {worker.telemetry.memory.value.totalBytes > 0 && <Meter value={worker.telemetry.memory.value.usedBytes / worker.telemetry.memory.value.totalBytes * 100} label={m.memory} />}<p className="worker-metric-detail">{m.totalMemory({ total: bytes(worker.telemetry.memory.value.totalBytes) })}</p>
        </>}</MetricCard>
        <MetricCard title={m.disk} checkedAt={worker.telemetry.disk.checkedAt}>{worker.telemetry.disk.state === 'error' ? <ProbeFailure probe={worker.telemetry.disk} /> : <>
          <p className="worker-metric-value">{bytes(worker.telemetry.disk.value.availableBytes)}<span className="worker-metric-unit">{m.availableCapacity({ total: bytes(worker.telemetry.disk.value.totalBytes) })}</span></p>
          {worker.telemetry.disk.value.totalBytes > 0 && <Meter value={(worker.telemetry.disk.value.totalBytes - worker.telemetry.disk.value.availableBytes) / worker.telemetry.disk.value.totalBytes * 100} label={m.disk} high={worker.telemetry.disk.value.availableBytes / worker.telemetry.disk.value.totalBytes < .2} />}<p className="worker-metric-detail">{m.totalDisk({ total: bytes(worker.telemetry.disk.value.totalBytes) })}</p>
        </>}</MetricCard>
      </div>
      <div className="worker-detail-columns" data-worker-reading>
        <section className="worker-panel"><h2 className="worker-panel-heading">{m.environment}</h2><dl className="worker-info-list">
          <div className="worker-info-row"><dt>{m.operatingSystem}</dt><dd>{worker.telemetry.os.state === 'error' ? <ProbeFailure probe={worker.telemetry.os} /> : <>{worker.telemetry.os.value.type}<br />{worker.telemetry.os.value.release}<br /><span className="worker-os-version">{worker.telemetry.os.value.version}</span></>}<CheckedAt value={worker.telemetry.os.checkedAt} /></dd></div>
          <div className="worker-info-row"><dt>{m.architecture}</dt><dd>{worker.telemetry.os.state === 'error' ? <ProbeFailure probe={worker.telemetry.os} /> : worker.telemetry.os.value.arch}</dd></div>
          <div className="worker-info-row"><dt>{m.cpu}</dt><dd>{worker.telemetry.cpu.state === 'error' ? <ProbeFailure probe={worker.telemetry.cpu} /> : <>{worker.telemetry.cpu.value.model}<br />{m.logicalProcessors({ count: format.number(worker.telemetry.cpu.value.logicalProcessors) })}</>}</dd></div>
          <div className="worker-info-row"><dt>{m.workingDirectory}</dt><dd>{worker.telemetry.workingDirectory}</dd></div>
        </dl></section>
        <section className="worker-panel"><header className="worker-panel-heading"><h2>{m.software}</h2><button type="button" className="worker-tool-path-shortcut" onClick={openToolPaths}>{m.configuration.toolPaths.title}</button></header><dl className="worker-info-list">
          <div className="worker-info-row"><dt>Daynight CLI</dt><dd className="worker-software-version">{worker.telemetry.versions.daynight}</dd></div>
          {(['codex', 'copilot'] as const).map(tool => <ToolSoftwareRow key={tool} tool={tool} telemetry={worker.telemetry.toolPaths} online={stale ? null : online} probe={worker.telemetry.versions[tool]} />)}
        </dl></section>
      </div>
      <p className="worker-detail-footnote">{m.footer}</p>
  </>;
};

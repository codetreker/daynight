import './native-select-fixture.css';
import { useLayoutEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NativeSelect, isNativeSelectPopupOpen } from '../../src/ui/native-select/NativeSelect';

const chinese = new URLSearchParams(location.search).get('locale') === 'zh';
document.documentElement.lang = chinese ? 'zh-CN' : 'en';
const short = chinese ? '当前选项' : 'Current option';
const long = chinese ? '项目与团队中的很长动态选项名称，需要完整保留选项文本' : 'A long dynamic project and team option whose complete text must be retained';
const options = <><option value="a">{short}</option><option value="b">{long}</option><option value="disabled" disabled>Unavailable</option></>;
const densities = ['compact', 'filter', 'form'] as const;
const states = ['normal', 'disabled', 'fieldset', 'pending', 'invalid', 'long', 'empty'] as const;

const EmptySelect = ({ density }: { density: typeof densities[number] }) => {
  const ref = useRef<HTMLSelectElement>(null);
  useLayoutEffect(() => { ref.current!.selectedIndex = -1; }, []);
  return <NativeSelect ref={ref} density={density} data-testid={`${density}-empty`} aria-label={`${density} empty`}><option value="herdr">herdr</option><option value="web">web</option></NativeSelect>;
};

const Host = () => {
  const [value, setValue] = useState('a'), [changes, setChanges] = useState(0), [submissions, setSubmissions] = useState(0);
  return <main>
    <h1>Native select browser fixture</h1>
    <section className="matrix" aria-label="Densities and states">
      {densities.flatMap(density => states.map(state => <label key={`${density}-${state}`}>
        {`${density} ${state}`}
        {state === 'empty' ? <EmptySelect density={density} /> : <fieldset disabled={state === 'fieldset'}>
          <NativeSelect density={density} defaultValue={state === 'long' ? 'b' : 'a'} disabled={state === 'disabled'} pending={state === 'pending' || state === 'invalid'} aria-invalid={state === 'invalid' ? true : undefined} aria-label={`${density} ${state}`} data-testid={`${density}-${state}`}>{options}</NativeSelect>
        </fieldset>}
      </label>))}
    </section>
    <section className="layout-cases" aria-label="Layout cases">
      <div className="flex-row"><NativeSelect layout="fill" wrapperClassName="flex-field" defaultValue="b" aria-label="Flex long" data-testid="flex">{options}</NativeSelect><button>Adjacent</button></div>
      <div className="grid-row"><label>Grid long<NativeSelect layout="fill" defaultValue="b" aria-label="Grid long" data-testid="grid">{options}</NativeSelect></label><p>A taller description must not stretch the field or displace its arrow.</p></div>
      <NativeSelect wrapperClassName="fixed-column" defaultValue="b" aria-label="Fixed long" data-testid="fixed">{options}</NativeSelect>
      <NativeSelect layout="fill" wrapperClassName="fixed-column" defaultValue="b" aria-label="Fixed fill" data-testid="fixed-fill">{options}</NativeSelect>
      <NativeSelect dir="rtl" aria-label="RTL" data-testid="rtl">{options}</NativeSelect>
      <NativeSelect hidden aria-label="Hidden" data-testid="hidden">{options}</NativeSelect>
      <NativeSelect size={3} defaultValue="b" aria-label="Single list" data-testid="single-list">{options}</NativeSelect>
      <NativeSelect multiple size={4} defaultValue={['a', 'b']} aria-label="Multiple list" data-testid="multiple-list">{options}</NativeSelect>
      <NativeSelect touchMode="responsive" aria-label="Responsive touch" data-testid="responsive">{options}</NativeSelect>
      <div className="container-case wide" data-testid="container-wide"><div className="inner-container"><NativeSelect layout="fill" touchMode="container" aria-label="Wide container" data-testid="wide-container">{options}</NativeSelect></div></div>
      <div className="container-case narrow" data-testid="container-narrow"><div className="inner-container"><NativeSelect layout="fill" touchMode="container" aria-label="Narrow container" data-testid="narrow-container">{options}</NativeSelect></div></div>
    </section>
    <section aria-label="Native interaction">
      <button data-testid="before">Before field</button>
      <label htmlFor="interactive">Interactive field</label>
      <NativeSelect id="interactive" data-testid="interactive" value={value} aria-describedby="interaction-description" onChange={event => { setValue(event.currentTarget.value); setChanges(count => count + 1); }} onKeyDown={event => { window.nativeSelectPopupObserved = isNativeSelectPopupOpen(event.target); }}>{options}</NativeSelect>
      <p id="interaction-description">Native pointer and keyboard input.</p><output data-testid="changes">{changes}</output>
      <button onClick={() => setSubmissions(count => count + 1)} data-testid="rerender">Rerender</button>
      <form onSubmit={event => { event.preventDefault(); setSubmissions(count => count + 1); }}>
        <label htmlFor="required">Required field</label><NativeSelect id="required" name="choice" required defaultValue="" data-testid="required"><option value="" disabled>Choose an option</option>{options}</NativeSelect>
        <button type="submit">Submit native form</button><output data-testid="submissions">{submissions}</output>
      </form>
      <NativeSelect focusTone="task" pending aria-label="Task focus" data-testid="task-focus">{options}</NativeSelect>
    </section>
  </main>;
};

declare global { interface Window { nativeSelectPopupObserved?: boolean } }
createRoot(document.getElementById('root')!).render(<Host />);

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { parseSessionCommand, parseSessionSnapshot, parseSessionOperation } from '../../src/session/protocol.js';
import { parseControllerState } from '../../src/session/controller-protocol.js';
import { parseSessionControls } from '../../src/session/controls.js';
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const controls = () => ({ revision: '1', settings: [{ id: 'model', category: 'model', label: 'Model', description: null, value: 'default', options: [{ value: 'default', label: 'Native default' }], mutable: true, scope: 'next_turn' }], commands: [{ id: 'compact', name: 'compact', description: 'Compact the session', argumentHint: null, available: true }], settingsError: null, commandsError: null });
describe('session controls wire contract', () => {
 it('retains old snapshots and round-trips provider controls with actual turn timestamps', () => {
  const old = fixture('snapshot'); expect(parseSessionSnapshot(old).controls).toBeUndefined();
  const current = {...old, controls: controls(), turnStartedAt: '2026-10-28T05:00:00.000Z'};
  expect(parseSessionSnapshot(current)).toEqual(current);
  expect(parseControllerState({nativeSessionId:'native', initialInputState:'confirmed', synchronized:true, activity:'idle', currentTurnId:null, capabilities:old.capabilities, controls:controls(),turnStartedAt:null}).controls).toEqual(controls());
 });
 it.each([
  ['update_setting', {settingId:'model',value:'default',expectedControlsRevision:'1'}],
  ['execute_command', {commandId:'compact',arguments:'',expectedControlsRevision:'1',expectedTurnId:null}],
  ['refresh_controls', {}],
 ])('validates %s and its persistent receipt', (kind, payload) => {
  const base=fixture('send-message'); const command={...base,kind,payload};expect(parseSessionCommand(command)).toEqual(command);
  const {requestId:_request,payload:_payload,...fence}=command;
  expect(parseSessionOperation({...fence,state:'confirmed',providerResult:'handled',error:null}).kind).toBe(kind);
  expect(()=>parseSessionCommand({...command,payload:{...payload,extra:true}})).toThrow();
 });
 it('rejects duplicate descriptors, unbounded catalogs, unknown fields and invalid revisions', () => {
  const c=controls();expect(parseSessionControls(c)).toEqual(c);
  for(const bad of [{...c,settings:[...c.settings,...c.settings]},{...c,commands:[...c.commands,...c.commands]},{...c,settingsError:'\ud800'},{...c,settingsError:'\0'},{...c,settingsError:'   '},{...c,revision:'0'},{...c,revision:'9223372036854775808'},{...c,extra:true},{...c,settings:[{...c.settings[0],category:'admin'}]},{...c,commands:Array.from({length:501},(_,i)=>({...c.commands[0],id:String(i)}))}])expect(()=>parseSessionControls(bad)).toThrow();
 });
 it('rejects empty setting values, malformed timestamps and obsolete revision shapes', () => {
  const base=fixture('send-message');expect(()=>parseSessionCommand({...base,kind:'update_setting',payload:{settingId:'model',value:'',expectedControlsRevision:'1'}})).toThrow();
  expect(()=>parseSessionCommand({...base,kind:'update_setting',payload:{settingId:'model',value:'default',expectedControlsRevision:1}})).toThrow();
  expect(()=>parseSessionSnapshot({...fixture('snapshot'),turnStartedAt:'yesterday'})).toThrow();
 });
});

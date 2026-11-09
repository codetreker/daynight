import { describe, expect, it } from 'vitest';
import { isLoginReturnPath, parseAuthRoute, webhookUrl } from '../src/app/router';
const teamId='a0000000-0000-4000-8000-000000000001';
const endpointId='a0000000-0000-4000-8000-000000000002';
const deliveryId='a0000000-0000-4000-8000-000000000003';
describe('explicit Webhook navigation',()=>{
  it('keeps owner and resource identity through URL and login return paths',()=>{
    const selection={owner:'team' as const,teamId,endpointId,tab:'subscriptions' as const};
    const url=webhookUrl(selection);
    const target=new URL(url,window.location.origin);
    expect(parseAuthRoute(target.pathname,target.search)).toEqual({kind:'webhooks',...selection,error:null});
    expect(isLoginReturnPath(url)).toBe(true);
    expect(parseAuthRoute('/webhooks')).toEqual({kind:'webhooks',owner:'personal',teamId:null,endpointId:null,tab:'configuration',error:null});
    expect(parseAuthRoute('/webhooks','?owner=team')).toMatchObject({kind:'webhooks',owner:'team',teamId:null,error:null});
  });
  it.each(['?owner=personal&teamId='+teamId,'?owner=else','?owner=team&teamId=bad','?owner=team&endpointId='+endpointId,'?owner=personal&owner=team','?endpointId=bad','?tab=configuration&tab=subscriptions','?unknown=1'])('retains explicit invalid navigation without silently selecting another owner: %s',(query)=>{
    expect(parseAuthRoute('/webhooks',query)).toMatchObject({kind:'webhooks',error:'invalid_query'});
  });
  it('refuses constructing contradictory owner URLs',()=>{
    expect(()=>webhookUrl({owner:'personal',teamId,endpointId:null,tab:'configuration'})).toThrow();
  });
  it.each(['personal', 'team'] as const)('preserves the complete %s delivery identity through a login return', (owner)=>{
    const selection={owner,teamId:owner==='team'?teamId:null,endpointId,deliveryId,tab:'deliveries' as const};
    const url=webhookUrl(selection);
    const target=new URL(url,window.location.origin);
    expect(parseAuthRoute(target.pathname,target.search)).toEqual({kind:'webhooks',...selection,error:null});
    expect(parseAuthRoute('/login',`?returnPath=${encodeURIComponent(url)}`)).toEqual({kind:'login',returnPath:url});
  });
  it.each([
    `?deliveryId=${deliveryId}&tab=deliveries`,
    `?endpointId=${endpointId}&deliveryId=${deliveryId}`,
    `?endpointId=${endpointId}&deliveryId=bad&tab=deliveries`,
    `?endpointId=${endpointId}&deliveryId=${deliveryId}&deliveryId=${deliveryId}&tab=deliveries`,
    `?owner=team&endpointId=${endpointId}&deliveryId=${deliveryId}&tab=deliveries`,
  ])('rejects incomplete or contradictory delivery navigation: %s',(query)=>{
    expect(parseAuthRoute('/webhooks',query)).toMatchObject({kind:'webhooks',error:'invalid_query'});
  });
});

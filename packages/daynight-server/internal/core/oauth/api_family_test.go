package oauth

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func TestAPIFamilyIssuesFixedApplicationAndOnlyHashes(t *testing.T) {
	now := time.Date(2026, 11, 12, 12, 0, 0, 123456789, time.UTC)
	user := uuid.NewString()
	dao := newIssuanceDAO(t, t.Context(), 1)
	result, err := IssueAPIFamily(t.Context(), dao, user, "https://example.test/api/v1", now)
	if err != nil {
		t.Fatal(err)
	}
	if result.Grant.ClientID != APIClientID || result.Grant.Resource != "https://example.test/api/v1" || result.Grant.Scope != APIScope || result.Grant.UserID != user || string(result.Grant.ClientSnapshot) != `{"clientId":"societas-bot","clientName":"Societas Bot"}` {
		t.Fatalf("application facts: %+v", result.Grant)
	}
	if !secret.Valid(result.AccessToken, APIAccessPrefix) || !secret.Valid(result.RefreshToken, APIRefreshPrefix) || !bytes.Equal(dao.issue.AccessHash, secret.Hash(result.AccessToken)) || !bytes.Equal(dao.issue.RefreshHash, secret.Hash(result.RefreshToken)) || len(dao.issue.AccessHash) != 32 || len(dao.issue.RefreshHash) != 32 {
		t.Fatal("issued secrets are not canonical independent hashed API credentials")
	}
	created := now.Truncate(time.Microsecond)
	if result.Grant.CreatedAt != created || result.Grant.ExpiresAt != created.Add(GrantLifetime) || result.AccessExpiresAt != created.Add(AccessLifetime) || result.AccessID == result.Grant.ID || result.AccessID == "" {
		t.Fatalf("issued identity/deadlines: %+v", result)
	}
}

func TestAPIFamilyRefusesInvalidResourceAndSuppressesFailedSecrets(t *testing.T) {
	for _, resource := range []string{"https://example.test/mcp", "https://example.test/api/v1/", "https://example.test/api/v1?x=1", "https://example.test/api%2Fv1", "https://user@example.test/api/v1"} {
		t.Run(resource, func(t *testing.T) {
			dao := newIssuanceDAO(t, t.Context(), 0)
			result, err := IssueAPIFamily(t.Context(), dao, uuid.NewString(), resource, time.Now())
			if err == nil || !reflect.DeepEqual(result, IssuedFamily{}) {
				t.Fatalf("invalid resource returned %+v %v", result, err)
			}
		})
	}
	dao := newIssuanceDAO(t, t.Context(), 1)
	failure := errors.New("family insert failed")
	dao.issueErr = failure
	result, err := IssueAPIFamily(t.Context(), dao, uuid.NewString(), "https://example.test/api/v1", time.Now())
	if !errors.Is(err, failure) || !reflect.DeepEqual(result, IssuedFamily{}) {
		t.Fatalf("failure leaked issuance: %+v %v", result, err)
	}
}

type apiAuthenticationDAO struct {
	store.CredentialFamilyDAO
	t      *testing.T
	token  string
	now    time.Time
	result store.OAuthAccessIdentity
	calls  int
}

func (d *apiAuthenticationDAO) AuthenticateAccess(ctx context.Context, hash []byte, bindings []store.OAuthBinding, now time.Time) (store.OAuthAccessIdentity, error) {
	d.calls++
	if ctx != d.t.Context() || !bytes.Equal(hash, secret.Hash(d.token)) || !reflect.DeepEqual(bindings, []store.OAuthBinding{{Resource: "https://example.test/api/v1", Scope: APIScope, ClientID: APIClientID}}) || now != d.now.Truncate(time.Microsecond) {
		d.t.Fatalf("authentication request: %v %v %v", hash, bindings, now)
	}
	return d.result, nil
}
func TestAPIAccessUsesFixedBindingAndRequiresEffectiveExpiry(t *testing.T) {
	now := time.Now().UTC()
	dao := &apiAuthenticationDAO{t: t, token: secret.Random(APIAccessPrefix), now: now, result: store.OAuthAccessIdentity{Principal: model.Principal{Kind: model.OAuthCredential, UserID: uuid.NewString(), CredentialID: uuid.NewString()}, GrantID: uuid.NewString(), ExpiresAt: now.Add(time.Hour)}}
	result, err := AuthenticateAccess(t.Context(), dao, dao.token, "https://example.test/api/v1", now)
	if err != nil || result != dao.result || dao.calls != 1 {
		t.Fatalf("authentication: %+v %v", result, err)
	}
	for _, expiry := range []time.Time{{}, now, now.Add(-time.Microsecond)} {
		dao.result.ExpiresAt = expiry
		if got, err := AuthenticateAccess(t.Context(), dao, dao.token, "https://example.test/api/v1", now); err == nil || got != (store.OAuthAccessIdentity{}) {
			t.Fatalf("invalid effective expiry accepted: %v", expiry)
		}
	}
	calls := dao.calls
	for _, pair := range [][2]string{{dao.token, "https://example.test/mcp"}, {secret.Random(model.OAuthAccessPrefix), "https://example.test/api/v1"}, {secret.Random(APIRefreshPrefix), "https://example.test/api/v1"}, {dao.token + "=", "https://example.test/api/v1"}} {
		if _, err := AuthenticateAccess(t.Context(), dao, pair[0], pair[1], now); err == nil {
			t.Fatalf("wrong profile accepted: %q", pair[1])
		}
	}
	if dao.calls != calls {
		t.Fatal("wrong profile reached the DAO")
	}
}

func apiRotationFixture(t *testing.T) (*lifecyclePlan, *GrantLifecycle, func(context.Context, string) error) {
	t.Helper()
	p, s := rotationFixture(t)
	p.token = secret.Random(APIRefreshPrefix)
	p.grant.ClientID, p.grant.Resource, p.grant.Scope = APIClientID, "https://example.test/api/v1", APIScope
	p.grant.CreatedAt = p.now.Add(-45 * 24 * time.Hour)
	p.grant.ExpiresAt = p.now.Add(10 * 24 * time.Hour)
	p.refresh.ClientID, p.refresh.ExpiresAt = APIClientID, p.now.Add(5*24*time.Hour)
	for i := range p.writes {
		for j := range p.writes[i].steps {
			if p.writes[i].steps[j].method == "grant" {
				p.writes[i].steps[j].grant = p.grant
			}
			if p.writes[i].steps[j].method == "refresh" {
				p.writes[i].steps[j].refresh = p.refresh
			}
		}
	}
	admit := func(ctx context.Context, client string) error {
		if ctx != p.ctx || client != APIClientID || p.active || p.transactions != 1 || p.admissions != 0 {
			t.Fatal("client admission did not run between completed lookup and mutation")
		}
		p.admissions++
		return nil
	}
	return p, s, admit
}
func TestAPIRotationRollsFromPostLockTimeBeyondOriginalLifetime(t *testing.T) {
	p, s, admit := apiRotationFixture(t)
	p.rotationTime = p.now.Add(2 * time.Minute)
	p.writes[1].steps[3].now = p.rotationTime
	result, err := s.Rotate(p.ctx, p.token, APIClientID, p.grant.Resource, admit)
	if err != nil || p.rotation == nil || !secret.Valid(result.AccessToken, APIAccessPrefix) || !secret.Valid(result.RefreshToken, APIRefreshPrefix) {
		t.Fatalf("rotation: %+v %v", result, err)
	}
	renewed := p.rotationTime
	if p.rotation.GrantExpiresAt != renewed.Add(GrantLifetime) || p.rotation.AccessExpiresAt != renewed.Add(AccessLifetime) || p.rotation.Grant.CreatedAt != p.grant.CreatedAt || result.Grant == nil || result.Grant.CreatedAt != p.grant.CreatedAt || result.Grant.ExpiresAt != renewed.Add(GrantLifetime) || result.AccessExpiresAt != renewed.Add(AccessLifetime) || result.AccessID != p.rotation.AccessID || result.ExpiresIn != 3600 {
		t.Fatalf("rolling deadlines/identity: %+v %+v", p.rotation, result)
	}
	if !bytes.Equal(p.rotation.AccessHash, secret.Hash(result.AccessToken)) || !bytes.Equal(p.rotation.RefreshHash, secret.Hash(result.RefreshToken)) {
		t.Fatal("returned token differs from stored hash candidate")
	}
}
func TestAPIConsumedRefreshReplayUsesItsOriginalDeadline(t *testing.T) {
	for _, expired := range []bool{false, true} {
		t.Run(map[bool]string{false: "valid replay revokes", true: "expired replay preserves family"}[expired], func(t *testing.T) {
			p, s, admit := apiRotationFixture(t)
			consumed := p.refresh
			consumed.ConsumedAt = &p.now
			if expired {
				consumed.ExpiresAt = p.now
			}
			p.writes[1].steps[2].refresh = consumed
			if expired {
				p.writes[1].steps = p.writes[1].steps[:4]
				p.writes[1].callbackErr, p.writes[1].outcome = ErrInvalidGrant, store.TransactionNotCommitted
			} else {
				p.writes[1].steps[4] = lifecycleStep{method: "revoke", changed: true}
			}
			result, err := s.Rotate(p.ctx, p.token, APIClientID, p.grant.Resource, admit)
			if !errors.Is(err, ErrInvalidGrant) || result != (RotatedTokens{}) || p.rotation != nil || p.revocations != map[bool]int{false: 1, true: 0}[expired] {
				t.Fatalf("replay: %+v %v revocations=%d", result, err, p.revocations)
			}
		})
	}
}
func TestAPIRotationRejectsWrongProfileBeforeLookup(t *testing.T) {
	for _, test := range []struct{ token, client, resource string }{
		{secret.Random(APIRefreshPrefix), "other", "https://example.test/api/v1"},
		{secret.Random(RefreshPrefix), APIClientID, "https://example.test/api/v1"},
		{secret.Random(APIRefreshPrefix), APIClientID, "https://example.test/mcp"},
		{secret.Random(APIAccessPrefix), APIClientID, "https://example.test/api/v1"},
	} {
		fake := newLifecycleFake()
		result, err := NewGrantLifecycle(fake).Rotate(t.Context(), test.token, test.client, test.resource, func(context.Context, string) error { t.Fatal("admitted rejected profile"); return nil })
		if !errors.Is(err, ErrInvalidGrant) || result != (RotatedTokens{}) || len(fake.calls) != 0 {
			t.Fatalf("wrong profile touched storage: %+v %v %+v", result, err, fake.calls)
		}
	}
}
func TestAPIRotationSuppressesRollbackAndUnknownSecrets(t *testing.T) {
	for _, outcome := range []store.TransactionOutcome{store.TransactionNotCommitted, store.TransactionUnknown} {
		t.Run(string(outcome), func(t *testing.T) {
			p, s, admit := apiRotationFixture(t)
			p.writes[1].outcome = outcome
			result, err := s.Rotate(p.ctx, p.token, APIClientID, p.grant.Resource, admit)
			if err == nil || result != (RotatedTokens{}) || p.rotation == nil {
				t.Fatalf("unconfirmed rotation leaked: %+v %v", result, err)
			}
			if outcome == store.TransactionUnknown && !errors.Is(err, ErrAuthorizationUnknown) {
				t.Fatalf("unknown result: %v", err)
			}
		})
	}
}

func TestAPIRotationRechecksNaturalExpiryAfterLocks(t *testing.T) {
	for _, subject := range []string{"grant", "refresh"} {
		t.Run(subject, func(t *testing.T) {
			p, s, admit := apiRotationFixture(t)
			expiredAt := p.now.Add(time.Minute)
			if subject == "grant" {
				p.writes[1].steps[1].grant.ExpiresAt = expiredAt
			} else {
				p.writes[1].steps[2].refresh.ExpiresAt = expiredAt
			}
			p.writes[1].steps[3].now = p.now.Add(2 * time.Minute)
			p.writes[1].steps = p.writes[1].steps[:4]
			p.writes[1].callbackErr, p.writes[1].outcome = ErrInvalidGrant, store.TransactionNotCommitted
			result, err := s.Rotate(p.ctx, p.token, APIClientID, p.grant.Resource, admit)
			if !errors.Is(err, ErrInvalidGrant) || result != (RotatedTokens{}) || p.rotation != nil || p.revocations != 0 {
				t.Fatalf("expired %s renewed after lock: %+v %v", subject, result, err)
			}
		})
	}
}

func TestAPIRotationRejectsStoredBindingMismatchBeforeAdmission(t *testing.T) {
	for _, subject := range []string{"grant client", "grant resource", "grant scope", "refresh client"} {
		t.Run(subject, func(t *testing.T) {
			p, s, admit := apiRotationFixture(t)
			switch subject {
			case "grant client":
				p.writes[0].steps[1].grant.ClientID = "other"
			case "grant resource":
				p.writes[0].steps[1].grant.Resource = "https://example.test/mcp"
			case "grant scope":
				p.writes[0].steps[1].grant.Scope = Scope
			case "refresh client":
				p.writes[0].steps[0].refresh.ClientID = "other"
			}
			p.writes = p.writes[:1]
			p.writes[0].callbackErr, p.writes[0].outcome = ErrInvalidGrant, store.TransactionNotCommitted
			result, err := s.Rotate(p.ctx, p.token, APIClientID, p.grant.Resource, admit)
			if !errors.Is(err, ErrInvalidGrant) || result != (RotatedTokens{}) || p.admissions != 0 || p.rotation != nil || p.revocations != 0 {
				t.Fatalf("stored %s crossed admission: %+v %v", subject, result, err)
			}
		})
	}
}

func apiRevocationFixture(t *testing.T, prefix string) (*lifecyclePlan, *GrantLifecycle, []lifecycleStep) {
	t.Helper()
	p, s := lifecycleFixture(t)
	p.token = secret.Random(prefix)
	p.grant.ClientID, p.grant.Resource, p.grant.Scope = APIClientID, "https://example.test/api/v1", APIScope
	p.refresh.ClientID = APIClientID
	steps := []lifecycleStep{{method: "refresh", refresh: p.refresh}, {method: "grant", lock: true, grant: p.grant}, {method: "refresh", lock: true, refresh: p.refresh}}
	if prefix == APIAccessPrefix || prefix == model.OAuthAccessPrefix {
		steps[0], steps[2] = lifecycleStep{method: "access", grant: p.grant}, lifecycleStep{method: "access", grant: p.grant}
	}
	return p, s, steps
}

func TestAPIInternalSelfRevocationUsesBothTokenKindsAndRetainedFamilies(t *testing.T) {
	for _, prefix := range []string{APIAccessPrefix, APIRefreshPrefix} {
		for _, state := range []string{"active", "expired", "revoked"} {
			t.Run(prefix+state, func(t *testing.T) {
				p, s, steps := apiRevocationFixture(t, prefix)
				if state == "expired" {
					steps[1].grant.ExpiresAt = p.now.Add(-time.Hour)
					steps[0].refresh.ExpiresAt, steps[2].refresh.ExpiresAt = p.now.Add(-time.Hour), p.now.Add(-time.Hour)
				}
				if state == "revoked" {
					steps[1].grant.RevokedAt = &p.now
				}
				steps = append(steps, lifecycleStep{method: "time", now: p.now}, lifecycleStep{method: "revoke", changed: state != "revoked"})
				p.writes = []lifecycleWrite{{steps: steps, outcome: store.TransactionCommitted}}
				if err := s.RevokePublic(p.ctx, p.token, APIClientID); err != nil || p.revocations != 1 || p.rotation != nil {
					t.Fatalf("API self revocation: %v revocations=%d", err, p.revocations)
				}
			})
		}
	}
}

func TestAPIInternalSelfRevocationRejectsMismatchedFamilyBinding(t *testing.T) {
	for _, mismatch := range []string{"foreign client", "foreign fixed client", "scope", "MCP access", "MCP refresh", "refresh owner"} {
		t.Run(mismatch, func(t *testing.T) {
			prefix := APIRefreshPrefix
			if mismatch == "MCP access" {
				prefix = model.OAuthAccessPrefix
			}
			if mismatch == "MCP refresh" {
				prefix = RefreshPrefix
			}
			p, s, steps := apiRevocationFixture(t, prefix)
			client := APIClientID
			switch mismatch {
			case "foreign client":
				client = "other"
			case "foreign fixed client":
				client, steps[1].grant.ClientID = "other", "other"
			case "scope":
				steps[1].grant.Scope = Scope
			case "refresh owner":
				steps[2].refresh.ClientID = "other"
			}
			if mismatch != "refresh owner" {
				steps = steps[:2]
			}
			p.writes = []lifecycleWrite{{steps: steps, outcome: store.TransactionCommitted}}
			if err := s.RevokePublic(p.ctx, p.token, client); err != nil || p.revocations != 0 {
				t.Fatalf("mismatched family revoked: %v revocations=%d", err, p.revocations)
			}
		})
	}
}

func TestAPIInternalSelfRevocationRequiresConfirmedCommit(t *testing.T) {
	for _, outcome := range []store.TransactionOutcome{store.TransactionNotCommitted, store.TransactionUnknown} {
		t.Run(string(outcome), func(t *testing.T) {
			p, s, steps := apiRevocationFixture(t, APIRefreshPrefix)
			steps = append(steps, lifecycleStep{method: "time", now: p.now}, lifecycleStep{method: "revoke", changed: true})
			p.writes = []lifecycleWrite{{steps: steps, outcome: outcome}}
			err := s.RevokePublic(p.ctx, p.token, APIClientID)
			if err == nil || p.revocations != 1 {
				t.Fatalf("unconfirmed revoke reported success: %v revocations=%d", err, p.revocations)
			}
			if outcome == store.TransactionUnknown && !errors.Is(err, ErrAuthorizationUnknown) {
				t.Fatalf("unknown revocation: %v", err)
			}
		})
	}
}

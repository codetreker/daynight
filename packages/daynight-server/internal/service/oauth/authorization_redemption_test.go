package oauth

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func fixtureRedeem() RedeemInput {
	return RedeemInput{Code: core.CodePrefix + strings.Repeat("a", 43), ClientID: "client", RedirectURI: "https://client.example/cb", Resource: "https://server.example/mcp", Verifier: strings.Repeat("a", 43)}
}
func codeBinding(in RedeemInput) core.CodeBinding {
	return core.CodeBinding{ClientID: in.ClientID, RedirectURI: in.RedirectURI, Resource: in.Resource, Verifier: in.Verifier}
}

type redeemExpectation struct {
	issued  core.IssuedFamily
	failure error
}

func configureRedemption(f *oauthFixture, s *Authorizations, in RedeemInput, record store.OAuthAuthorization, phase string) redeemExpectation {
	f.t.Helper()
	failure := errors.New("injected storage failure")
	firstFresh, secondFresh := f.now.Add(time.Minute), f.now.Add(2*time.Minute)
	grant := store.OAuthGrant{ID: uuid.NewString(), UserID: record.UserID, ClientID: record.ClientID, Resource: record.Resource, Scope: core.Scope, ClientSnapshot: record.Client, CreatedAt: f.now, ExpiresAt: f.now.Add(core.GrantLifetime)}
	issued := core.IssuedFamily{Grant: grant, AccessID: uuid.NewString(), AccessToken: "provided access token", RefreshToken: "provided refresh token", AccessExpiresAt: firstFresh.Add(core.AccessLifetime)}
	updated := cloneAuthorization(record)
	updated.ID = uuid.NewString()
	updated.Status = "controlled consumed record"
	updated.GrantID = grant.ID
	updated.RetainUntil = grant.ExpiresAt.Add(time.Minute)
	dcr := redemptionDCRPhase(phase)
	replay := redemptionReplayPhase(phase)
	if dcr {
		var client core.ValidatedClient
		if err := json.Unmarshal(record.Client, &client); err != nil {
			f.t.Fatal(err)
		}
		if in.ClientID != fixtureDCRClientID() || record.ClientID != in.ClientID || client.ClientID != in.ClientID || client.Provenance != "dcr" {
			f.t.Fatal("DCR fixture identity and snapshot are inconsistent")
		}
	}
	if phase == "expired grant" {
		grant.CreatedAt = f.now.Add(-31 * 24 * time.Hour)
		grant.ExpiresAt = f.now.Add(-24 * time.Hour)
	}
	steps := []string{"valid code input", "writer authorization", "scope authorization", "code unlocked"}
	if phase != "missing code" && phase != "unknown missing code" {
		if replay {
			steps = append(steps, "scope family", "grant locked")
		}
		if phase != "lock-grant" {
			steps = append(steps, "code locked")
			if phase != "lock-code" {
				steps = append(steps, "fresh")
				if phase != "fresh" {
					steps = append(steps, "check code")
					if phase != "expired code" {
						if replay {
							steps = append(steps, "scope family", "grant read")
							if phase != "read-grant" && phase != "expired grant" {
								steps = append(steps, "scope family", "revoke family")
							}
						} else if phase != "invalid snapshot" {
							if dcr {
								steps = append(steps, "scope client", "pin client")
								if phase != "pin" && phase != "missing DCR" {
									steps = append(steps, "fresh")
									if phase != "fresh-after-pin" {
										steps = append(steps, "check expiry")
									}
								}
							}
							if !dcr || phase == "DCR success" {
								steps = append(steps, "scope family", "issue family")
								if phase != "issue" {
									steps = append(steps, "consume", "update authorization")
								}
							}
						}
					}
				}
			}
		}
	}
	steps = append(steps, "callback returned", "writer returned")
	f.steps = append(f.steps, steps...)
	s.operations.validCodeInput = func(code, client, resource, expected, verifier string) bool {
		f.step("valid code input")
		f.equal([]string{code, client, resource, expected, verifier}, []string{in.Code, in.ClientID, in.Resource, s.resource, in.Verifier})
		return true
	}
	reads := 0
	hash := sha256.Sum256([]byte(in.Code))
	f.authorization.byCode = func(got []byte, lock bool) (store.OAuthAuthorization, error) {
		f.equal(got, hash[:])
		reads++
		f.equal(lock, reads == 2)
		if reads > 2 {
			f.t.Fatal("extra code lookup")
		}
		if phase == "missing code" || phase == "unknown missing code" {
			return store.OAuthAuthorization{}, model.ErrNotFound
		}
		if lock && phase == "lock-code" {
			return store.OAuthAuthorization{}, failure
		}
		return cloneAuthorization(record), nil
	}
	freshCalls := 0
	f.authorization.fresh = func(now time.Time) (time.Time, error) {
		freshCalls++
		if freshCalls == 1 {
			f.equal(now, f.now)
			if phase == "fresh" {
				return time.Time{}, failure
			}
			return firstFresh, nil
		}
		f.equal(freshCalls, 2)
		f.equal(now, firstFresh)
		if phase == "fresh-after-pin" {
			return time.Time{}, failure
		}
		return secondFresh, nil
	}
	s.operations.checkCode = func(a store.OAuthAuthorization, binding core.CodeBinding, now time.Time) (bool, error) {
		f.step("check code")
		f.equal(a, record)
		f.equal(binding, codeBinding(in))
		f.equal(now, firstFresh)
		if phase == "expired code" {
			return false, core.ErrInvalidGrant
		}
		return replay, nil
	}
	f.client.pin = func(id string, now time.Time) (store.OAuthClient, error) {
		f.equal(id, record.ClientID)
		f.equal(now, firstFresh)
		if phase == "pin" {
			return store.OAuthClient{}, failure
		}
		if phase == "missing DCR" {
			return store.OAuthClient{}, model.ErrNotFound
		}
		return store.OAuthClient{ID: id, ExpiresAt: f.now.Add(7 * 24 * time.Hour)}, nil
	}
	s.operations.checkExpiry = func(a store.OAuthAuthorization, now time.Time) error {
		f.step("check expiry")
		f.equal(a, record)
		f.equal(now, secondFresh)
		if phase == "DCR expiry" {
			return core.ErrInvalidGrant
		}
		return nil
	}
	s.operations.issueFamily = func(ctx context.Context, dao store.CredentialFamilyDAO, input core.IssueInput, now time.Time) (core.IssuedFamily, error) {
		f.context(ctx)
		f.step("issue family")
		if !f.active || dao != f.family {
			f.t.Fatal("issuance lost current callback capability")
		}
		f.equal(input, core.IssueInput{UserID: record.UserID, ClientID: record.ClientID, Resource: record.Resource, ClientSnapshot: record.Client})
		wantTime := firstFresh
		if dcr {
			wantTime = secondFresh
		}
		f.equal(now, wantTime)
		if phase == "issue" {
			return core.IssuedFamily{}, failure
		}
		return cloneIssuedFamily(issued), nil
	}
	s.operations.consume = func(a *store.OAuthAuthorization, id string, until time.Time) {
		f.step("consume")
		if !f.active {
			f.t.Fatal("consume outside callback")
		}
		f.equal(*a, record)
		f.equal(id, issued.Grant.ID)
		f.equal(until, issued.Grant.ExpiresAt)
		*a = cloneAuthorization(updated)
	}
	f.authorization.update = func(a store.OAuthAuthorization) error {
		f.equal(a, updated)
		if phase == "update" {
			return failure
		}
		return nil
	}
	f.family.inspect = func(id string, lock bool) (store.OAuthGrant, error) {
		f.equal(id, record.GrantID)
		if lock && phase == "lock-grant" {
			return store.OAuthGrant{}, failure
		}
		if !lock && phase == "read-grant" {
			return store.OAuthGrant{}, failure
		}
		g := grant
		g.ID = record.GrantID
		return g, nil
	}
	f.family.revoke = func(id string, now time.Time) (bool, error) {
		f.equal(id, record.GrantID)
		f.equal(now, firstFresh)
		if phase == "revoke" {
			return false, failure
		}
		return true, nil
	}
	callbackErr, finalErr := error(nil), error(nil)
	outcome := store.TransactionCommitted
	switch phase {
	case "lock-code", "fresh", "issue", "update", "pin", "fresh-after-pin", "lock-grant", "read-grant", "revoke":
		callbackErr = failure
		finalErr = failure
		outcome = store.TransactionNotCommitted
	case "missing code", "missing DCR":
		callbackErr = model.ErrNotFound
		finalErr = model.ErrNotFound
		outcome = store.TransactionNotCommitted
	case "unknown missing code":
		callbackErr = model.ErrNotFound
		finalErr = model.ErrNotFound
		outcome = store.TransactionUnknown
	case "expired code", "DCR expiry", "expired grant", "invalid snapshot":
		callbackErr = &model.Fault{Code: "invalid_grant", Message: "Invalid OAuth grant.", Cause: core.ErrInvalidGrant}
		finalErr = core.ErrInvalidGrant
		outcome = store.TransactionNotCommitted
	case "unknown":
		outcome = store.TransactionUnknown
		finalErr = failure
	case "not committed":
		outcome = store.TransactionNotCommitted
	case "completion error":
		finalErr = failure
	}
	f.plan("authorization", true, callbackErr, outcome, finalErr)
	return redeemExpectation{issued: issued, failure: failure}
}
func expectedToken(issued core.IssuedFamily) TokenResult {
	return TokenResult{AccessToken: issued.AccessToken, RefreshToken: issued.RefreshToken, TokenType: "Bearer", Scope: core.Scope, ExpiresIn: int64(core.AccessLifetime / time.Second)}
}
func TestAuthorizationRedeemUsesCurrentScopeAndCompletion(t *testing.T) {
	for _, phase := range []string{"success", "DCR success", "unknown", "not committed", "completion error", "missing code", "unknown missing code", "missing DCR", "expired code", "DCR expiry", "expired grant", "invalid snapshot", "replay"} {
		t.Run(phase, func(t *testing.T) {
			f := newOAuthFixture(t)
			s := f.service()
			in := fixtureRedeem()
			record := fixtureRedemptionAuthorization(&in, f.now, phase)
			expected := configureRedemption(f, s, in, record, phase)
			got, err := s.RedeemCode(f.ctx, in)
			if phase == "success" || phase == "DCR success" {
				if err != nil {
					t.Fatal(err)
				}
				f.equal(got, expectedToken(expected.issued))
				return
			}
			f.equal(got, TokenResult{})
			if err == nil {
				t.Fatal("unconfirmed or rejected redemption returned tokens")
			}
			switch phase {
			case "unknown", "unknown missing code":
				checkAuthorizationError(t, err, core.ErrAuthorizationUnknown)
			case "completion error":
				checkAuthorizationError(t, err, expected.failure)
			case "not committed":
			default:
				checkAuthorizationError(t, err, core.ErrInvalidGrant)
			}
		})
	}
}
func TestAuthorizationRedeemStorageFailuresStopAtOriginalBoundary(t *testing.T) {
	for _, phase := range []string{"lock-code", "fresh", "issue", "update", "pin", "fresh-after-pin", "lock-grant", "read-grant", "revoke"} {
		t.Run(phase, func(t *testing.T) {
			f := newOAuthFixture(t)
			s := f.service()
			in := fixtureRedeem()
			record := fixtureRedemptionAuthorization(&in, f.now, phase)
			expected := configureRedemption(f, s, in, record, phase)
			got, err := s.RedeemCode(f.ctx, in)
			f.equal(got, TokenResult{})
			checkAuthorizationError(t, err, expected.failure)
			if phase != "lock-grant" && phase != "read-grant" && phase != "revoke" {
				retryPhase := "success"
				if redemptionDCRPhase(phase) {
					retryPhase = "DCR success"
				}
				expected = configureRedemption(f, s, in, record, retryPhase)
				got, err = s.RedeemCode(f.ctx, in)
				if err != nil {
					t.Fatal("same caller could not retry coordination", err)
				}
				f.equal(got, expectedToken(expected.issued))
			}
		})
	}
}
func TestAuthorizationRedeemRejectsInputAndWriterFailure(t *testing.T) {
	t.Run("input", func(t *testing.T) {
		f := newOAuthFixture(t, "valid code input")
		s := f.service()
		in := fixtureRedeem()
		s.operations.validCodeInput = func(code, client, resource, expected, verifier string) bool {
			f.step("valid code input")
			f.equal([]string{code, client, resource, expected, verifier}, []string{in.Code, in.ClientID, in.Resource, s.resource, in.Verifier})
			return false
		}
		got, err := s.RedeemCode(f.ctx, in)
		f.equal(got, TokenResult{})
		checkAuthorizationError(t, err, core.ErrInvalidGrant)
	})
	t.Run("writer", func(t *testing.T) {
		f := newOAuthFixture(t, "valid code input", "writer authorization", "writer returned")
		s := f.service()
		in := fixtureRedeem()
		s.operations.validCodeInput = func(code, client, resource, expected, verifier string) bool {
			f.step("valid code input")
			f.equal([]string{code, client, resource, expected, verifier}, []string{in.Code, in.ClientID, in.Resource, s.resource, in.Verifier})
			return true
		}
		failure := errors.New("writer unavailable")
		f.plan("authorization", false, nil, store.TransactionNotCommitted, failure)
		got, err := s.RedeemCode(f.ctx, in)
		f.equal(got, TokenResult{})
		checkAuthorizationError(t, err, failure)
	})
}

func TestCodeAdmissionRunsAfterLookupCompletionWithStoredClient(t *testing.T) {
	for _, phase := range []string{"success", "binding refusal", "expired bound code", "budget error", "lookup unknown"} {
		t.Run(phase, func(t *testing.T) {
			f := newOAuthFixture(t)
			s := f.service()
			in := fixtureRedeem()
			if phase == "binding refusal" {
				in.Verifier = strings.Repeat("b", 43)
			}
			in.ClientID = "untrusted client input"
			redeemPhase := "success"
			if phase == "expired bound code" {
				redeemPhase = "expired code"
			}
			record := fixtureRedemptionAuthorization(&in, f.now, redeemPhase)
			setCodeClientFacts(&record, "verified stored client", "preregistered")
			expected := configureRedemption(f, s, in, record, redeemPhase)
			mainSteps := append([]string{}, f.steps[1:]...)
			mainPlan := f.transactions[0]
			f.transactions = nil
			f.steps = []string{"valid code input", "writer authorization", "scope authorization", "code unlocked", "check binding", "callback returned", "writer returned"}
			callbackErr, finalErr := error(nil), error(nil)
			outcome := store.TransactionCommitted
			switch phase {
			case "binding refusal":
				callbackErr = &model.Fault{Code: "invalid_grant", Message: "Invalid OAuth grant.", Cause: core.ErrInvalidGrant}
				finalErr = core.ErrInvalidGrant
				outcome = store.TransactionNotCommitted
			case "lookup unknown":
				outcome = store.TransactionUnknown
				finalErr = model.ErrNotFound
			}
			f.plan("authorization", true, callbackErr, outcome, finalErr)
			if phase != "binding refusal" && phase != "lookup unknown" {
				f.steps = append(f.steps, "admit client")
				if phase != "budget error" {
					f.steps = append(f.steps, mainSteps...)
					f.transactions = append(f.transactions, mainPlan)
				}
			}
			mainLookup := f.authorization.byCode
			lookup := true
			hash := sha256.Sum256([]byte(in.Code))
			f.authorization.byCode = func(got []byte, lock bool) (store.OAuthAuthorization, error) {
				if lookup {
					lookup = false
					f.equal(got, hash[:])
					f.equal(lock, false)
					return cloneAuthorization(record), nil
				}
				return mainLookup(got, lock)
			}
			s.operations.checkBinding = func(a store.OAuthAuthorization, binding core.CodeBinding) error {
				f.step("check binding")
				f.equal(a, record)
				f.equal(binding, codeBinding(in))
				if phase == "binding refusal" {
					return core.ErrInvalidGrant
				}
				return nil
			}
			budgetFailure := errors.New("client budget failed")
			calls := 0
			in.AdmitClient = func(ctx context.Context, id string) error {
				f.context(ctx)
				f.step("admit client")
				if f.active || f.current != nil {
					t.Fatal("client admission happened before lookup writer returned")
				}
				f.equal(id, record.ClientID)
				calls++
				if phase == "budget error" {
					return budgetFailure
				}
				return nil
			}
			got, err := s.RedeemCode(f.ctx, in)
			if phase == "success" {
				if err != nil {
					t.Fatal(err)
				}
				f.equal(got, expectedToken(expected.issued))
			} else {
				f.equal(got, TokenResult{})
				want := error(core.ErrInvalidGrant)
				if phase == "budget error" {
					want = budgetFailure
				}
				if phase == "lookup unknown" {
					want = core.ErrAuthorizationUnknown
				}
				checkAuthorizationError(t, err, want)
			}
			wantCalls := 1
			if phase == "binding refusal" || phase == "lookup unknown" {
				wantCalls = 0
			}
			f.equal(calls, wantCalls)
		})
	}
}
func TestAuthorizationCodeRetryRequiresUncommittedScopeAndStopsAtTwo(t *testing.T) {
	for _, mode := range []string{"retry then replay", "two races", "unknown race", "committed race", "mismatched grant"} {
		t.Run(mode, func(t *testing.T) {
			f := newOAuthFixture(t)
			s := f.service()
			in := fixtureRedeem()
			record := fixtureRedemptionAuthorization(&in, f.now, "success")
			grantID := uuid.NewString()
			otherID := uuid.NewString()
			hash := sha256.Sum256([]byte(in.Code))
			s.operations.validCodeInput = func(code, client, resource, expected, verifier string) bool {
				f.step("valid code input")
				f.equal([]string{code, client, resource, expected, verifier}, []string{in.Code, in.ClientID, in.Resource, s.resource, in.Verifier})
				return true
			}
			f.steps = []string{"valid code input"}
			attempts := 1
			if mode == "retry then replay" || mode == "two races" {
				attempts = 2
			}
			for i := 0; i < attempts; i++ {
				f.steps = append(f.steps, "writer authorization", "scope authorization", "code unlocked")
				successReplay := mode == "retry then replay" && i == 1
				mismatch := mode == "mismatched grant"
				if successReplay || mismatch {
					f.steps = append(f.steps, "scope family", "grant locked")
				}
				f.steps = append(f.steps, "code locked")
				if successReplay {
					f.steps = append(f.steps, "fresh", "check code", "scope family", "grant read", "scope family", "revoke family")
				}
				f.steps = append(f.steps, "callback returned", "writer returned")
				callbackErr, finalErr := error(errRetryCode), error(errRetryCode)
				outcome := store.TransactionNotCommitted
				if successReplay {
					callbackErr = nil
					finalErr = nil
					outcome = store.TransactionCommitted
				}
				if mismatch {
					callbackErr = &model.Fault{Code: "invalid_grant", Message: "Invalid OAuth grant.", Cause: core.ErrInvalidGrant}
					finalErr = core.ErrInvalidGrant
				}
				if mode == "unknown race" {
					outcome = store.TransactionUnknown
				}
				if mode == "committed race" {
					outcome = store.TransactionCommitted
				}
				f.plan("authorization", true, callbackErr, outcome, finalErr)
			}
			reads := 0
			f.authorization.byCode = func(got []byte, lock bool) (store.OAuthAuthorization, error) {
				f.equal(got, hash[:])
				reads++
				f.equal(lock, reads%2 == 0)
				a := cloneAuthorization(record)
				if mode == "mismatched grant" {
					a.GrantID = grantID
					if lock {
						a.GrantID = otherID
					}
				} else if lock || (mode == "retry then replay" && reads > 2) {
					a.GrantID = grantID
				}
				if a.GrantID != "" {
					a.Status = "consumed"
					a.RetainUntil = f.now.Add(core.GrantLifetime)
				}
				return a, nil
			}
			f.family.inspect = func(id string, lock bool) (store.OAuthGrant, error) {
				f.equal(id, grantID)
				return store.OAuthGrant{ID: grantID, ExpiresAt: f.now.Add(time.Hour)}, nil
			}
			f.authorization.fresh = func(now time.Time) (time.Time, error) { f.equal(now, f.now); return f.now.Add(time.Minute), nil }
			s.operations.checkCode = func(a store.OAuthAuthorization, binding core.CodeBinding, now time.Time) (bool, error) {
				f.step("check code")
				want := cloneAuthorization(record)
				want.GrantID = grantID
				want.Status = "consumed"
				want.RetainUntil = f.now.Add(core.GrantLifetime)
				f.equal(a, want)
				f.equal(binding, codeBinding(in))
				f.equal(now, f.now.Add(time.Minute))
				return true, nil
			}
			f.family.revoke = func(id string, now time.Time) (bool, error) {
				f.equal(id, grantID)
				f.equal(now, f.now.Add(time.Minute))
				return true, nil
			}
			got, err := s.RedeemCode(f.ctx, in)
			f.equal(got, TokenResult{})
			want := error(core.ErrInvalidGrant)
			if mode == "unknown race" {
				want = core.ErrAuthorizationUnknown
			}
			if mode == "committed race" {
				want = errRetryCode
			}
			checkAuthorizationError(t, err, want)
			f.equal(reads, attempts*2)
		})
	}
}

func TestAuthorizationRedeemRetainsOperationAndCleanupErrorChain(t *testing.T) {
	f := newOAuthFixture(t)
	s := f.service()
	in := fixtureRedeem()
	a := fixtureRedemptionAuthorization(&in, f.now, "update")
	expected := configureRedemption(f, s, in, a, "update")
	cleanup := errors.New("transaction cleanup failed")
	joined := errors.Join(expected.failure, cleanup)
	f.transactions[0].finalError = joined
	got, err := s.RedeemCode(f.ctx, in)
	f.equal(got, TokenResult{})
	if err != joined || !errors.Is(err, expected.failure) || !errors.Is(err, cleanup) {
		t.Fatal("writer completion lost joined causes", err)
	}
}

func fixtureDCRClientID() string { return "dnoac_" + strings.Repeat("c", 43) }
func redemptionDCRPhase(phase string) bool {
	switch phase {
	case "pin", "fresh-after-pin", "missing DCR", "DCR success", "DCR expiry":
		return true
	default:
		return false
	}
}
func redemptionReplayPhase(phase string) bool {
	switch phase {
	case "lock-grant", "read-grant", "revoke", "expired grant", "replay":
		return true
	default:
		return false
	}
}

func fixtureRedemptionAuthorization(in *RedeemInput, now time.Time, phase string) store.OAuthAuthorization {
	provenance := "preregistered"
	if redemptionDCRPhase(phase) {
		in.ClientID = fixtureDCRClientID()
		provenance = "dcr"
	}
	if phase == "update" {
		in.ClientID = "update-failure-client"
	}
	record := fixtureAuthorization(uuid.NewString(), now)
	record.RedirectURI, record.Resource = in.RedirectURI, in.Resource
	setCodeClientFacts(&record, in.ClientID, provenance)
	record = fixtureApprovedAuthorization(record, uuid.NewString(), in.Code, now)
	expiry := *record.CodeExpiresAt
	switch phase {
	case "expired code":
		expiry = now.Add(-time.Second)
	case "DCR expiry":
		expiry = now.Add(90 * time.Second)
	}
	record.CodeExpiresAt = &expiry
	if redemptionReplayPhase(phase) {
		record.Status = "consumed"
		record.GrantID = uuid.NewString()
		record.RetainUntil = now.Add(core.GrantLifetime)
	}
	if phase == "invalid snapshot" {
		record.Client = []byte(`[]`)
	}
	return record
}

func setCodeClientFacts(record *store.OAuthAuthorization, id, provenance string) {
	record.ClientID = id
	client := fixtureClient()
	client.ClientID = id
	client.Provenance = provenance
	raw, err := json.Marshal(client)
	if err != nil {
		panic(err)
	}
	record.Client = raw
}

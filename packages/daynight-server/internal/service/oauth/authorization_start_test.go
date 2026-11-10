package oauth

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
)

func TestNewAuthorizationsBindsDefaultOperationsAndInstances(t *testing.T) {
	f := newOAuthFixture(t, "first client", "second client", "first client")
	firstClient, secondClient := f.clients(), f.clients()
	metadata := core.ClientMetadata{ClientID: "known"}
	firstClient.preregistered["known"] = cloneClientMetadata(metadata)
	secondClient.preregistered["known"] = cloneClientMetadata(metadata)
	firstMarker, secondMarker := fixtureClient(), fixtureClient()
	firstMarker.ClientName = "first instance"
	secondMarker.ClientName = "second instance"
	firstClient.operations.freezeClient = func(id, provenance string, m core.ClientMetadata, d time.Time, r string) (core.ValidatedClient, error) {
		f.step("first client")
		f.equal([]string{id, provenance, r}, []string{"known", "preregistered", "redirect"})
		f.equal(m, metadata)
		f.equal(d, time.Time{})
		return cloneValidatedClient(firstMarker), nil
	}
	secondClient.operations.freezeClient = func(id, provenance string, m core.ClientMetadata, d time.Time, r string) (core.ValidatedClient, error) {
		f.step("second client")
		f.equal([]string{id, provenance, r}, []string{"known", "preregistered", "redirect"})
		f.equal(m, metadata)
		f.equal(d, time.Time{})
		return cloneValidatedClient(secondMarker), nil
	}
	a := &boundAdmissionWriter{t: t, ctx: f.ctx, failure: errors.New("first authorization admission")}
	b := &boundAdmissionWriter{t: t, ctx: f.ctx, failure: errors.New("second authorization admission")}
	first, err := NewAuthorizations(f, firstClient, core.PublicAdmission{Writer: a}, "https://server.example")
	if err != nil {
		t.Fatal(err)
	}
	second, err := NewAuthorizations(f, secondClient, core.PublicAdmission{Writer: b}, "https://server.example")
	if err != nil {
		t.Fatal(err)
	}
	if first.writer != f || first.issuer != "https://server.example" || first.resource != "https://server.example/mcp" || first.now == nil {
		t.Fatal("authorization constructor wiring incomplete")
	}
	for _, pair := range [][2]any{{first.operations.validStart, core.ValidAuthorizationStart}, {first.operations.callbackURI, core.CallbackURI}, {first.operations.newAuthorization, core.NewAuthorization}, {first.operations.validBinding, core.ValidAuthorizationBinding}, {first.operations.bound, core.AuthorizationBound}, {first.operations.status, core.AuthorizationStatus}, {first.operations.validDecision, core.ValidAuthorizationDecision}, {first.operations.decide, core.DecideAuthorization}, {first.operations.validCodeInput, core.ValidAuthorizationCodeInput}, {first.operations.checkBinding, core.CheckAuthorizationCodeBinding}, {first.operations.checkCode, core.CheckAuthorizationCode}, {first.operations.checkExpiry, core.CheckAuthorizationCodeExpiry}, {first.operations.issueFamily, core.IssueFamily}, {first.operations.consume, core.ConsumeAuthorization}, {first.operations.prune, core.PruneAuthorizationBatch}} {
		sameFunction(t, pair[0], pair[1])
	}
	for _, item := range []struct {
		s       *Authorizations
		want    core.ValidatedClient
		failure error
	}{{first, firstMarker, a.failure}, {second, secondMarker, b.failure}, {first, firstMarker, a.failure}} {
		got, err := item.s.operations.resolveClient(f.ctx, "known", "redirect")
		if err != nil {
			t.Fatal(err)
		}
		f.equal(got, item.want)
		_, err = item.s.operations.take(f.ctx, "start", "source", "")
		if err != item.failure {
			t.Fatal("admission receiver changed", err)
		}
	}
	f.equal(a.calls, 2)
	f.equal(b.calls, 1)
}
func TestNewAuthorizationsRejectsInvalidConstruction(t *testing.T) {
	f := newOAuthFixture(t)
	c := f.clients()
	if s, err := NewAuthorizations(nil, c, core.PublicAdmission{}, "https://server.example"); s != nil || err != core.ErrInvalidAuthorization {
		t.Fatal(s, err)
	}
	if s, err := NewAuthorizations(f, nil, core.PublicAdmission{}, "https://server.example"); s != nil || err != core.ErrInvalidAuthorization {
		t.Fatal(s, err)
	}
	for _, issuer := range []string{"", "https://server.example/path", "https://server.example?x=1", "ftp://server.example", "https://u@server.example"} {
		if s, err := NewAuthorizations(f, c, core.PublicAdmission{}, issuer); s != nil || err != core.ErrInvalidAuthorization {
			t.Fatal(issuer, s, err)
		}
	}
}

func configureStart(f *oauthFixture, s *Authorizations, in StartInput, client core.ValidatedClient, record store.OAuthAuthorization) *StartResult {
	expected := &StartResult{}
	s.operations.take = func(ctx context.Context, kind, source, id string) (bool, error) {
		f.context(ctx)
		f.step("take")
		f.equal([]string{kind, source, id}, []string{"start", in.Source, ""})
		return true, nil
	}
	s.operations.validStart = func(response, scope, resource, expected, challenge, method, state string) bool {
		f.step("valid start")
		f.equal([]string{response, scope, resource, expected, challenge, method, state}, []string{in.ResponseType, in.Scope, in.Resource, s.resource, in.CodeChallenge, in.CodeChallengeMethod, in.State})
		return true
	}
	s.operations.resolveClient = func(ctx context.Context, id, redirect string) (core.ValidatedClient, error) {
		f.context(ctx)
		f.step("resolve")
		f.equal([]string{id, redirect}, []string{in.ClientID, in.RedirectURI})
		return cloneValidatedClient(client), nil
	}
	s.operations.callbackURI = func(redirect string, fields url.Values) (string, error) {
		f.step("callback URI")
		f.equal(redirect, client.SelectedExactRedirect)
		f.equal(fields, url.Values(nil))
		return "checked callback", nil
	}
	s.operations.newAuthorization = func(request core.AuthorizationRequest, now time.Time) store.OAuthAuthorization {
		f.step("new authorization")
		*expected = StartResult{RequestID: request.ID, Binding: request.Binding}
		if id, err := uuid.Parse(request.ID); err != nil || id == uuid.Nil {
			f.t.Fatal("request identity not allocated")
		}
		if !secret.Valid(request.Binding, core.BindingPrefix) {
			f.t.Fatal("browser binding not allocated")
		}
		raw, _ := json.Marshal(client)
		f.equal(request, core.AuthorizationRequest{ID: request.ID, Binding: request.Binding, Client: raw, ClientID: client.ClientID, RedirectURI: client.SelectedExactRedirect, Resource: in.Resource, Scope: in.Scope, Challenge: in.CodeChallenge, State: in.State, StatePresent: in.StatePresent})
		f.equal(now, f.now)
		return cloneAuthorization(record)
	}
	f.authorization.insert = func(got store.OAuthAuthorization, limit int, now time.Time) (bool, error) {
		f.equal(got, record)
		f.equal(limit, 10000)
		f.equal(now, f.now)
		return true, nil
	}
	return expected
}
func TestAuthorizationStartCoordinatesControlledResults(t *testing.T) {
	for _, mode := range []string{"success", "capacity", "insert error", "writer error", "unknown", "not committed"} {
		t.Run(mode, func(t *testing.T) {
			f := newOAuthFixture(t, "take", "valid start", "resolve", "callback URI", "new authorization", "writer authorization", "scope authorization", "insert authorization", "callback returned", "writer returned")
			s := f.service()
			s.now = func() time.Time { return f.now.In(time.FixedZone("offset", 9*3600)).Add(99 * time.Nanosecond) }
			in := fixtureStart()
			record := fixtureAuthorization(uuid.NewString(), f.now.Add(-time.Hour))
			record.Status = "controlled state"
			expectedStart := configureStart(f, s, in, fixtureClient(), record)
			failure := errors.New("authorization write failed")
			callbackErr, finalErr := error(nil), error(nil)
			outcome := store.TransactionCommitted
			switch mode {
			case "capacity":
				f.authorization.insert = func(got store.OAuthAuthorization, limit int, now time.Time) (bool, error) {
					f.equal(got, record)
					f.equal(limit, 10000)
					f.equal(now, f.now)
					return false, nil
				}
			case "insert error":
				f.authorization.insert = func(got store.OAuthAuthorization, limit int, now time.Time) (bool, error) {
					f.equal(got, record)
					f.equal(limit, 10000)
					f.equal(now, f.now)
					return false, failure
				}
				callbackErr = failure
				finalErr = failure
			case "writer error":
				finalErr = failure
			case "unknown":
				outcome = store.TransactionUnknown
				finalErr = failure
			case "not committed":
				outcome = store.TransactionNotCommitted
			}
			f.plan("authorization", true, callbackErr, outcome, finalErr)
			got, err := s.Start(f.ctx, in)
			if mode == "success" {
				if err != nil {
					t.Fatal(got, err)
				}
				f.equal(got, *expectedStart)
			} else {
				f.equal(got, StartResult{})
				if err == nil {
					t.Fatal("unconfirmed start succeeded")
				}
				if mode == "unknown" {
					checkAuthorizationError(t, err, core.ErrAuthorizationUnknown)
				} else if mode == "capacity" {
					checkAuthorizationError(t, err, core.ErrAuthorizationCapacity)
				} else if finalErr != nil && err != finalErr {
					t.Fatal(err)
				}
			}
		})
	}
}
func TestAuthorizationStartStopsAtDirectOperationFailure(t *testing.T) {
	emptySource := fixtureStart()
	emptySource.Source = ""
	tokenResponse := fixtureStart()
	tokenResponse.ResponseType = "token"
	plainPKCE := fixtureStart()
	plainPKCE.CodeChallengeMethod = "plain"
	otherResource := fixtureStart()
	otherResource.Resource = "https://other/mcp"
	missingClient := fixtureStart()
	missingClient.ClientID = "missing"
	for _, scenario := range []struct {
		name, phase string
		input       StartInput
	}{
		{"admission error", "admission error", emptySource},
		{"admission refusal", "admission refusal", fixtureStart()},
		{"input refusal/token response", "input refusal", tokenResponse},
		{"input refusal/plain PKCE", "input refusal", plainPKCE},
		{"input refusal/other resource", "input refusal", otherResource},
		{"resolve", "resolve", missingClient},
		{"callback URI", "callback URI", fixtureStart()},
		{"writer", "writer", fixtureStart()},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			phase := scenario.phase
			steps := []string{"take"}
			if phase != "admission error" && phase != "admission refusal" {
				steps = append(steps, "valid start")
			}
			if phase == "resolve" || phase == "callback URI" || phase == "writer" {
				steps = append(steps, "resolve")
			}
			if phase == "callback URI" || phase == "writer" {
				steps = append(steps, "callback URI")
			}
			if phase == "writer" {
				steps = append(steps, "new authorization", "writer authorization", "writer returned")
			}
			f := newOAuthFixture(t, steps...)
			s := f.service()
			in := scenario.input
			record := fixtureAuthorization(uuid.NewString(), f.now)
			configureStart(f, s, in, fixtureClient(), record)
			failure := errors.New("start failed")
			want := error(failure)
			switch phase {
			case "admission error":
				s.operations.take = func(ctx context.Context, kind, source, id string) (bool, error) {
					f.context(ctx)
					f.step("take")
					f.equal([]string{kind, source, id}, []string{"start", in.Source, ""})
					return false, failure
				}
			case "admission refusal":
				s.operations.take = func(ctx context.Context, kind, source, id string) (bool, error) {
					f.context(ctx)
					f.step("take")
					f.equal([]string{kind, source, id}, []string{"start", in.Source, ""})
					return false, nil
				}
				want = core.ErrRateLimited
			case "input refusal":
				s.operations.validStart = func(a, b, c, d, e, g, h string) bool {
					f.step("valid start")
					f.equal([]string{a, b, c, d, e, g, h}, []string{in.ResponseType, in.Scope, in.Resource, s.resource, in.CodeChallenge, in.CodeChallengeMethod, in.State})
					return false
				}
				want = core.ErrInvalidAuthorization
			case "resolve":
				s.operations.resolveClient = func(ctx context.Context, id, redirect string) (core.ValidatedClient, error) {
					f.context(ctx)
					f.step("resolve")
					f.equal([]string{id, redirect}, []string{in.ClientID, in.RedirectURI})
					return core.ValidatedClient{}, failure
				}
			case "callback URI":
				s.operations.callbackURI = func(id string, fields url.Values) (string, error) {
					f.step("callback URI")
					f.equal(id, fixtureClient().SelectedExactRedirect)
					f.equal(fields, url.Values(nil))
					return "", failure
				}
			case "writer":
				f.plan("authorization", false, nil, store.TransactionNotCommitted, failure)
			}
			got, err := s.Start(f.ctx, in)
			f.equal(got, StartResult{})
			checkAuthorizationError(t, err, want)
		})
	}
}

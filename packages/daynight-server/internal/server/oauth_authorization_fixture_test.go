package server

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	oauthservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"net/url"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func oauthHTTPExpectRegistration(t *testing.T, f *oauthHTTPFixture, body string, metadata core.ClientMetadata) {
	t.Helper()
	called := oauthHTTPCount(t, 1)
	expected := []byte(body)
	result := metadata
	result.RedirectURIs = slices.Clone(metadata.RedirectURIs)
	f.Ops.RegisterFn = func(ctx context.Context, source string, raw []byte) (core.ClientMetadata, error) {
		called()
		oauthHTTPDirectContext(t, ctx)
		oauthHTTPCheck(t, source, "127.0.0.1")
		oauthHTTPCheck(t, raw, expected)
		out := result
		out.RedirectURIs = slices.Clone(result.RedirectURIs)
		return out, nil
	}
}

func oauthHTTPPending(f *oauthHTTPFixture, id, binding, state, clientID, redirect, provenance string) store.OAuthAuthorization {
	challenge := sha256.Sum256([]byte(strings.Repeat("v", 43)))
	client := oauthHTTPClientFacts(f, clientID, redirect)
	if client.Provenance != provenance {
		unexpectedHTTPCall(f.t, "OAuth fixture client provenance")
	}
	raw, err := json.Marshal(client)
	if err != nil {
		f.t.Fatal(err)
	}
	return store.OAuthAuthorization{ID: id, BindingHash: secret.Hash(binding), Client: raw, ClientID: clientID, RedirectURI: redirect, Resource: f.Origin + "/mcp", Scope: core.Scope, Challenge: base64.RawURLEncoding.EncodeToString(challenge[:]), State: state, StatePresent: true, Status: "pending", CreatedAt: f.Now, ExpiresAt: f.Now.Add(10 * time.Minute), RetainUntil: f.Now.Add(10*time.Minute + 24*time.Hour)}
}
func oauthHTTPApproved(f *oauthHTTPFixture, pending store.OAuthAuthorization, code string) store.OAuthAuthorization {
	a := oauthHTTPCloneAuthorization(pending)
	a.Status = "approved"
	a.UserID = f.Principal.UserID
	a.CodeHash = secret.Hash(code)
	expires := f.Now.Add(5 * time.Minute)
	a.CodeExpiresAt = &expires
	a.State = ""
	a.StatePresent = false
	a.RetainUntil = f.Now.Add(24 * time.Hour)
	return a
}
func oauthHTTPRead(t *testing.T, f *oauthHTTPFixture, row store.OAuthAuthorization, binding string) {
	t.Helper()
	row = oauthHTTPCloneAuthorization(row)
	called := oauthHTTPCount(t, 1)
	var client core.ValidatedClient
	if err := json.Unmarshal(row.Client, &client); err != nil {
		t.Fatal(err)
	}
	view := oauthservice.AuthorizationView{RequestID: row.ID, Status: row.Status, UserID: f.Principal.UserID, ClientName: client.ClientName, ClientID: row.ClientID, ClientProvenance: client.Provenance, RedirectURI: row.RedirectURI, Resource: row.Resource, Scope: row.Scope, CodeExpired: false}
	f.Ops.InspectFn = func(ctx context.Context, id, actualBinding string, p model.Principal) (oauthservice.AuthorizationView, error) {
		called()
		oauthHTTPDirectContext(t, ctx)
		oauthHTTPCheck(t, id, row.ID)
		oauthHTTPCheck(t, actualBinding, binding)
		oauthHTTPCheck(t, p, f.Principal)
		return view, nil
	}
}
func oauthHTTPExpectDecisionRefusal(t *testing.T, f *oauthHTTPFixture, row store.OAuthAuthorization, p model.Principal, expected, decision, binding string) {
	t.Helper()
	called := oauthHTTPCount(t, 1)
	row = oauthHTTPCloneAuthorization(row)
	f.Ops.DecideFn = func(ctx context.Context, in oauthservice.DecisionInput) (oauthservice.DecisionResult, error) {
		called()
		oauthHTTPDirectContext(t, ctx)
		oauthHTTPCheck(t, in, oauthservice.DecisionInput{RequestID: row.ID, Binding: binding, ExpectedUserID: expected, Decision: decision, Principal: p})
		oauthHTTPCheck(t, secret.Hash(in.Binding), row.BindingHash)
		return oauthservice.DecisionResult{}, core.ErrInvalidAuthorization
	}
}
func oauthHTTPDecision(t *testing.T, f *oauthHTTPFixture, row store.OAuthAuthorization, status, binding string, refused bool) *atomic.Pointer[store.OAuthAuthorization] {
	t.Helper()
	row = oauthHTTPCloneAuthorization(row)
	called := oauthHTTPCount(t, 1)
	captured := new(atomic.Pointer[store.OAuthAuthorization])
	code := secret.Random("dnoc_")
	resultRow := oauthHTTPCloneAuthorization(row)
	resultRow.Status = status
	resultRow.State = ""
	resultRow.StatePresent = false
	resultRow.UserID = f.Principal.UserID
	resultRow.RetainUntil = f.Now.Add(24 * time.Hour)
	decision := "deny"
	values := url.Values{"error": {"access_denied"}, "iss": {f.Origin}}
	if row.StatePresent {
		values.Set("state", row.State)
	}
	if status == "approved" {
		decision = "approve"
		values.Del("error")
		values.Set("code", code)
		resultRow.CodeHash = secret.Hash(code)
		expires := f.Now.Add(5 * time.Minute)
		resultRow.CodeExpiresAt = &expires
	}
	callback, err := url.Parse(row.RedirectURI)
	if err != nil {
		t.Fatal(err)
	}
	callback.RawQuery = values.Encode()
	result := oauthservice.DecisionResult{RedirectURI: callback.String()}
	f.Ops.DecideFn = func(ctx context.Context, in oauthservice.DecisionInput) (oauthservice.DecisionResult, error) {
		called()
		oauthHTTPDirectContext(t, ctx)
		oauthHTTPCheck(t, in, oauthservice.DecisionInput{RequestID: row.ID, Binding: binding, ExpectedUserID: f.Principal.UserID, Decision: decision, Principal: f.Principal})
		oauthHTTPCheck(t, secret.Hash(in.Binding), row.BindingHash)
		if refused {
			return oauthservice.DecisionResult{}, core.ErrInvalidAuthorization
		}
		copy := oauthHTTPCloneAuthorization(resultRow)
		captured.Store(&copy)
		return result, nil
	}
	return captured
}
func oauthHTTPExpectStart(t *testing.T, f *oauthHTTPFixture, clientID, redirect, state string) *atomic.Pointer[store.OAuthAuthorization] {
	t.Helper()
	called := oauthHTTPCount(t, 1)
	captured := new(atomic.Pointer[store.OAuthAuthorization])
	id, binding := uuid.NewString(), secret.Random("dnob_")
	row := oauthHTTPPending(f, id, binding, state, clientID, redirect, oauthHTTPClientFacts(f, clientID, redirect).Provenance)
	row.StatePresent = state != ""
	f.Ops.StartFn = func(ctx context.Context, in oauthservice.StartInput) (oauthservice.StartResult, error) {
		called()
		oauthHTTPDirectContext(t, ctx)
		source := in.Source
		if source != "127.0.0.1" {
			unexpectedHTTPCall(t, "OAuth Start source")
		}
		oauthHTTPCheck(t, in, oauthservice.StartInput{Source: source, ClientID: clientID, RedirectURI: redirect, ResponseType: "code", Scope: core.Scope, Resource: f.Origin + "/mcp", State: state, StatePresent: state != "", CodeChallenge: row.Challenge, CodeChallengeMethod: "S256"})
		copy := oauthHTTPCloneAuthorization(row)
		captured.Store(&copy)
		f.mu.Lock()
		f.Starts[source]++
		f.mu.Unlock()
		return oauthservice.StartResult{RequestID: id, Binding: binding}, nil
	}
	return captured
}
func oauthHTTPClientFacts(f *oauthHTTPFixture, clientID, redirect string) core.ValidatedClient {
	name, provenance, deadline := "", "preregistered", time.Time{}
	redirects := []string{redirect}
	switch {
	case clientID == "acceptance-client":
		name = "Acceptance"
	case clientID == "known":
		name = "Known"
	case f.ClientBudgetID != "" && clientID == f.ClientBudgetID:
		name = "Public client"
		provenance = "dcr"
		redirects = []string{"http://127.0.0.1/callback"}
		deadline = f.Now.Add(7 * 24 * time.Hour)
	default:
		unexpectedHTTPCall(f.t, "OAuth fixture client configuration")
	}
	metadata := core.ClientMetadata{ClientID: clientID, ClientName: name, RedirectURIs: redirects, TokenEndpointAuthMethod: "none"}
	canonical, err := json.Marshal(metadata)
	if err != nil {
		panic(err)
	}
	digest := sha256.Sum256(canonical)
	return core.ValidatedClient{ClientID: clientID, Provenance: provenance, ClientName: name, MetadataDigest: hex.EncodeToString(digest[:]), Redirects: slices.Clone(redirects), SelectedExactRedirect: redirect, MetadataDeadline: deadline}
}

func oauthHTTPAssertView(t *testing.T, f *oauthHTTPFixture, data []byte, row store.OAuthAuthorization) {
	t.Helper()
	var client core.ValidatedClient
	if err := json.Unmarshal(row.Client, &client); err != nil {
		t.Fatal(err)
	}
	want := oauthservice.AuthorizationView{RequestID: row.ID, Status: row.Status, UserID: f.Principal.UserID, ClientName: client.ClientName, ClientID: row.ClientID, ClientProvenance: client.Provenance, RedirectURI: row.RedirectURI, Resource: row.Resource, Scope: row.Scope, CodeExpired: false}
	var got oauthservice.AuthorizationView
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	oauthHTTPCheck(t, got, want)
}

func oauthHTTPAssertRegistration(t *testing.T, data []byte, want core.ClientMetadata) {
	t.Helper()
	want.RedirectURIs = slices.Clone(want.RedirectURIs)
	var got core.ClientMetadata
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	oauthHTTPCheck(t, got, want)
}

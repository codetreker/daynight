package identity

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	uniauth "github.com/codetreker/uniauth/sdk/go"
)

func TestStartLoginCoordinatesSDKAndCreate(t *testing.T) {
	for _, provider := range []string{"microsoft", "google", "github"} {
		t.Run(provider, func(t *testing.T) {
			f := newIdentityHTTPFixture(t)
			browser := secret.Random("")
			start := core.LoginStart{ID: "allocated-login", State: secret.Random(""), BrowserBinding: secret.Random(""), ExpiresAt: f.now.Add(time.Minute)}
			pending := model.LoginTransaction{ID: start.ID, Provider: provider, ReturnPath: "/projects?view=graph#tasks", StateHash: []byte("state"), BrowserBindingHash: []byte("binding"), ExpiresAt: start.ExpiresAt}
			f.plan = []string{"prepare", "write", "create", "finish"}
			f.transaction()
			f.identity.ops.startLogin = func(p, path string, now time.Time) (core.LoginStart, model.LoginTransaction, error) {
				f.hit("prepare")
				f.equal([]any{p, path, now}, []any{provider, pending.ReturnPath, f.now})
				return start, pending, nil
			}
			committedExpiry := f.now.Add(10 * time.Minute)
			f.identity.ops.createLogin = func(ctx context.Context, dao store.IdentityDAO, got model.LoginTransaction, now time.Time) (time.Time, error) {
				f.hit("create")
				f.bound(ctx, dao)
				want := pending
				want.ScopeHash = secret.Hash(browser)
				f.equal(got, want)
				f.equal(now, f.now)
				return committedExpiry, nil
			}
			got, err := f.identity.StartLogin(f.ctx, provider, pending.ReturnPath, browser)
			if err != nil {
				t.Fatal(err)
			}
			parsed, err := url.Parse(got.AuthorizationURL)
			if err != nil {
				t.Fatal(err)
			}
			f.equal([]any{parsed.Path, parsed.Query().Get("provider"), parsed.Query().Get("app_id"), parsed.Query().Get("state"), parsed.Query().Get("redirect_uri")}, []any{"/auth/authorize", provider, "test-app", start.State, f.identity.CallbackURL()})
			want := start
			want.AuthorizationURL = got.AuthorizationURL
			want.ExpiresAt = committedExpiry
			f.equal(got, want)
			if f.calls.Load() != 0 {
				t.Fatal("start retrieved identity")
			}
		})
	}
}
func TestStartLoginRefusalAndSDKConfiguration(t *testing.T) {
	refusal := &model.Fault{Code: "invalid_input"}
	failure := errors.New("write failed")
	for _, stage := range []string{"prepare", "browser", "sdk", "create", "completion"} {
		t.Run(stage, func(t *testing.T) {
			f := newIdentityHTTPFixture(t)
			f.plan = []string{"prepare"}
			browser := secret.Random("")
			f.identity.ops.startLogin = func(string, string, time.Time) (core.LoginStart, model.LoginTransaction, error) {
				f.hit("prepare")
				if stage == "prepare" {
					return core.LoginStart{}, model.LoginTransaction{}, refusal
				}
				return core.LoginStart{State: secret.Random("")}, model.LoginTransaction{}, nil
			}
			if stage == "browser" {
				browser = "invalid"
			}
			if stage == "sdk" {
				f.identity.callbackURL = "ftp://not-http.example/callback"
			}
			if stage == "create" || stage == "completion" {
				f.transaction()
				f.plan = append(f.plan, "write", "create", "finish")
				if stage == "completion" {
					f.transactions[0].err = failure
				}
				f.identity.ops.createLogin = func(context.Context, store.IdentityDAO, model.LoginTransaction, time.Time) (time.Time, error) {
					f.hit("create")
					if stage == "create" {
						return time.Time{}, refusal
					}
					return f.now, nil
				}
			}
			got, err := f.identity.StartLogin(f.ctx, "microsoft", "/", browser)
			if err == nil || got != (core.LoginStart{}) {
				t.Fatalf("failure leaked login: %#v %v", got, err)
			}
			if stage == "prepare" || stage == "create" {
				if err != refusal {
					t.Fatalf("original refusal lost: %v", err)
				}
			}
			if stage == "completion" && !errors.Is(err, failure) {
				t.Fatalf("completion cause: %v", err)
			}
		})
	}
}

func TestCompleteLoginCoordinatesIndependentScopes(t *testing.T) {
	for _, stage := range []string{"success", "upsert", "bootstrap", "session", "consume-completion", "final-completion", "consume-unknown", "consume-not-committed", "consume-invalid", "final-unknown", "final-not-committed", "final-invalid"} {
		t.Run(stage, func(t *testing.T) {
			f := newIdentityHTTPFixture(t)
			query := url.Values{"state": {secret.Random("")}, "code": {"alice"}}
			binding := secret.Random("")
			pending := model.LoginTransaction{ID: "consumed-login", Provider: "microsoft", ReturnPath: "/projects/project/tasks/task/attachments/docs/guide.md?tab=overview#details"}
			f.replies["alice"] = identityReply{200, identityProfile("identity-alice")}
			f.consume(query, binding, pending, nil)
			f.plan = []string{"validate-callback", "write", "consume", "finish"}
			f.transaction()
			failure := errors.New("persistence failed")
			if strings.HasPrefix(stage, "consume-") {
				if stage == "consume-completion" {
					f.transactions[0].err = failure
				} else {
					outcome := store.TransactionOutcome(strings.TrimPrefix(stage, "consume-"))
					if outcome == "not-committed" {
						outcome = store.TransactionNotCommitted
					}
					f.transactions[0].completion.Outcome = outcome
				}
			} else {
				f.plan = append(f.plan, "provider", "profile", "new-session", "write", "upsert")
				if stage != "upsert" {
					f.plan = append(f.plan, "admit-profile", "bootstrap")
					if stage != "bootstrap" {
						f.plan = append(f.plan, "lookup", "validate-team", "admit-response", "session")
					}
				}
				f.plan = append(f.plan, "finish")
				f.transaction()
				if strings.HasPrefix(stage, "final-") {
					if stage == "final-completion" {
						f.transactions[1].err = failure
					} else {
						outcome := store.TransactionOutcome(strings.TrimPrefix(stage, "final-"))
						if outcome == "not-committed" {
							outcome = store.TransactionNotCommitted
						}
						f.transactions[1].completion.Outcome = outcome
					}
				}
				if stage == "upsert" || stage == "bootstrap" || stage == "session" {
					f.transactions[1].callbackErr = failure
					f.transactions[1].err = failure
					f.transactions[1].completion.Outcome = store.TransactionNotCommitted
				}
			}
			user := model.User{ID: "canonical-user", UniAuthID: "identity-alice", CreatedAt: f.now.Add(-time.Hour), UpdatedAt: f.now}
			ref := model.TeamRef{ID: "canonical-team", Kind: "personal"}
			session := model.Session{ID: "new-session", TokenHash: []byte("opaque-hash"), CreatedAt: f.now, ExpiresAt: f.now.Add(7 * 24 * time.Hour)}
			value := "opaque-session-secret"
			f.identity.ops.validateProvider = func(expected, actual string, mismatch error) error {
				f.hit("provider")
				f.equal([]any{expected, actual}, []any{"microsoft", "microsoft"})
				var protocol *uniauth.ProtocolError
				if !errors.As(mismatch, &protocol) || protocol.Reason != "provider_mismatch" {
					t.Fatalf("mismatch cause=%v", mismatch)
				}
				return nil
			}
			f.identity.ops.admitProfileFields = func(got model.User) error {
				f.hit("profile")
				if got.UniAuthID != "identity-alice" || got.Email == nil || *got.Email != "shared@example.com" || got.Name == nil || *got.Name != "Display name" || got.EmailVerified == nil || *got.EmailVerified || got.AvatarURL != nil {
					t.Fatalf("SDK profile mapping: %#v", got)
				}
				return nil
			}
			f.identity.ops.newSession = func(now time.Time) (model.Session, string) {
				f.hit("new-session")
				f.equal(now, f.now)
				return session, value
			}
			f.identity.ops.completeLogin = func(ctx context.Context, dao store.IdentityDAO, got model.User, now time.Time) (model.User, error) {
				f.hit("upsert")
				f.bound(ctx, dao)
				f.equal(now, f.now)
				if got.UniAuthID != "identity-alice" {
					t.Fatal("wrong normalized user")
				}
				if stage == "upsert" {
					return user, failure
				}
				return user, nil
			}
			f.identity.ops.admitCompleteUser = func(got model.User, response bool) error {
				if response {
					f.hit("admit-response")
					want := user
					want.PersonalTeam = ref
					f.equal(got, want)
				} else {
					f.hit("admit-profile")
					f.equal(got, user)
				}
				return nil
			}
			f.identity.ops.user = func(ctx context.Context, dao store.IdentityDAO, principal model.Principal) (model.User, store.PersonalTeamFacts, error) {
				f.hit("lookup")
				f.bound(ctx, dao)
				f.equal(principal.UserID, user.ID)
				return user, store.PersonalTeamFacts{ID: ref.ID, MemberCount: 1, OwnerAdminCount: 1}, nil
			}
			f.identity.ops.validatePersonalTeam = func(facts store.PersonalTeamFacts) error {
				f.hit("validate-team")
				f.equal(facts.ID, ref.ID)
				return nil
			}
			f.identity.ops.bootstrapPersonalTeam = func(ctx context.Context, dao store.PersonalTeamDAO, id string, now time.Time) (model.TeamRef, error) {
				f.hit("bootstrap")
				if ctx != f.ctx || dao != f.scope.personal {
					t.Fatal("personal capability not from identity scope")
				}
				f.equal([]any{id, now}, []any{user.ID, f.now})
				if stage == "bootstrap" {
					return ref, failure
				}
				return ref, nil
			}
			f.identity.ops.createSession = func(ctx context.Context, dao store.IdentityDAO, got model.Session) error {
				f.hit("session")
				f.bound(ctx, dao)
				want := session
				want.UserID = user.ID
				f.equal(got, want)
				if stage == "session" {
					return failure
				}
				return nil
			}
			got, err := f.identity.CompleteLogin(f.ctx, query, binding)
			if stage == "success" {
				wantUser := user
				wantUser.PersonalTeam = ref
				wantSession := session
				wantSession.UserID = user.ID
				f.equal(got, core.LoginCompletion{LoginID: pending.ID, ReturnPath: pending.ReturnPath, User: wantUser, Session: wantSession, Secret: value})
				if err != nil {
					t.Fatal(err)
				}
			} else {
				if err == nil {
					t.Fatal("failed completion succeeded")
				}
				if (stage == "upsert" || stage == "bootstrap" || stage == "session" || strings.HasSuffix(stage, "completion")) && !errors.Is(err, failure) {
					t.Fatalf("cause lost: %v", err)
				}
				if strings.HasPrefix(stage, "consume-") {
					f.equal(got, core.LoginCompletion{})
				} else {
					f.equal(got, core.LoginCompletion{LoginID: pending.ID, ReturnPath: pending.ReturnPath})
				}
			}
			wantCalls := int32(1)
			if strings.HasPrefix(stage, "consume-") {
				wantCalls = 0
			}
			if f.calls.Load() != wantCalls {
				t.Fatalf("HTTP claims=%d want=%d", f.calls.Load(), wantCalls)
			}
		})
	}
}

func TestCallbackSDKAdmissionAndProviderFailures(t *testing.T) {
	for _, tc := range []struct {
		name    string
		query   url.Values
		fault   string
		consume bool
	}{
		{"missing result", url.Values{}, "unauthenticated", false},
		{"duplicate code", url.Values{"code": {"a", "b"}}, "unauthenticated", false},
		{"empty code", url.Values{"code": {""}}, "unauthenticated", false},
		{"conflicting result", url.Values{"code": {"valid"}, "error": {"provider_failed"}}, "unauthenticated", false},
		{"unknown failure", url.Values{"error": {"unknown"}}, "unauthenticated", false},
		{"provider denied", url.Values{"error": {"provider_denied"}}, "unauthenticated", true},
		{"provider failed", url.Values{"error": {"provider_failed"}}, "unauthenticated", true},
		{"capacity exceeded", url.Values{"error": {"capacity_exceeded"}}, "unauthenticated", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newIdentityHTTPFixture(t)
			query := tc.query
			query.Set("state", secret.Random(""))
			binding := secret.Random("")
			pending := model.LoginTransaction{ID: "pending", ReturnPath: "/tasks"}
			f.consume(query, binding, pending, nil)
			f.plan = []string{"validate-callback"}
			if tc.consume {
				f.plan = append(f.plan, "write", "consume", "finish")
				f.transaction()
			}
			got, err := f.identity.CompleteLogin(f.ctx, query, binding)
			requireFault(t, err, tc.fault)
			want := core.LoginCompletion{}
			if tc.consume {
				want.LoginID, want.ReturnPath = pending.ID, pending.ReturnPath
				var callback *uniauth.CallbackError
				if !errors.As(err, &callback) || callback.Code != query.Get("error") {
					t.Fatalf("SDK callback cause=%v", err)
				}
			}
			f.equal(got, want)
			if f.calls.Load() != 0 {
				t.Fatal("callback failure reached upstream")
			}
		})
	}
	for _, name := range []string{"API", "schema", "provider", "profile"} {
		t.Run(name, func(t *testing.T) {
			f := newIdentityHTTPFixture(t)
			query := url.Values{"state": {secret.Random("")}, "code": {"result"}}
			binding := secret.Random("")
			pending := model.LoginTransaction{ID: "consumed", ReturnPath: "/retry", Provider: "microsoft"}
			f.consume(query, binding, pending, nil)
			f.plan = []string{"validate-callback", "write", "consume", "finish"}
			f.transaction()
			reply := identityReply{200, identityProfile("alice")}
			failure := &model.Fault{Code: "unauthenticated"}
			switch name {
			case "API":
				reply = identityReply{503, map[string]any{"error": map[string]string{"code": "unavailable", "message": "Gateway unavailable"}}}
			case "schema":
				reply.body = map[string]any{"provider": "microsoft"}
			case "provider":
				mismatched := identityProfile("mismatched")
				mismatched["provider"] = "google"
				reply.body = mismatched
				f.plan = append(f.plan, "provider")
			case "profile":
				f.plan = append(f.plan, "provider", "profile")
			}
			f.identity.ops.validateProvider = func(expected, actual string, mismatch error) error {
				f.hit("provider")
				want := "microsoft"
				if name == "provider" {
					want = "google"
				}
				f.equal([]any{expected, actual}, []any{"microsoft", want})
				var protocol *uniauth.ProtocolError
				if !errors.As(mismatch, &protocol) || protocol.Reason != "provider_mismatch" {
					t.Fatalf("provider cause=%v", mismatch)
				}
				if name == "provider" {
					return failure
				}
				return nil
			}
			f.identity.ops.admitProfileFields = func(model.User) error { f.hit("profile"); return failure }
			f.replies["result"] = reply
			got, err := f.identity.CompleteLogin(f.ctx, query, binding)
			f.equal(got, core.LoginCompletion{LoginID: pending.ID, ReturnPath: pending.ReturnPath})
			if err == nil {
				t.Fatal("provider failure accepted")
			}
			if name == "API" {
				var upstream *uniauth.APIError
				if !errors.As(err, &upstream) || upstream.StatusCode != 503 || upstream.RequestID != "gateway-request" {
					t.Fatalf("API error=%v", err)
				}
			}
			if name == "schema" {
				var protocol *uniauth.ProtocolError
				var provider *model.IdentityProviderError
				if !errors.As(err, &protocol) || protocol.Reason != "identity_schema" || !errors.As(err, &provider) || provider.Code != "identity_unavailable" {
					t.Fatalf("protocol error=%v", err)
				}
			}
			if name == "provider" || name == "profile" {
				if !errors.Is(err, failure) {
					t.Fatalf("lower cause=%v", err)
				}
			}
			if f.calls.Load() != 1 {
				t.Fatal("result retrieval retried")
			}
		})
	}
}

func TestConsumedLoginRefusalNeverRetrieves(t *testing.T) {
	for _, cause := range []error{model.Unauthenticated(model.ErrNotFound), context.Canceled, errors.New("database failure")} {
		t.Run(cause.Error(), func(t *testing.T) {
			f := newIdentityHTTPFixture(t)
			query := url.Values{"state": {secret.Random("")}, "code": {"unused"}}
			binding := secret.Random("")
			f.consume(query, binding, model.LoginTransaction{}, cause)
			f.transaction()
			f.plan = []string{"validate-callback", "write", "consume", "finish"}
			var fault *model.Fault
			if !errors.As(cause, &fault) {
				f.transactions[0].callbackErr = cause
				f.transactions[0].err = cause
			}
			got, err := f.identity.CompleteLogin(f.ctx, query, binding)
			f.equal(got, core.LoginCompletion{})
			if err != cause || f.calls.Load() != 0 {
				t.Fatalf("consume error=%v HTTP=%d", err, f.calls.Load())
			}
		})
	}
}

func TestLoginTransportCancellationDrains(t *testing.T) {
	f := newIdentityHTTPFixture(t)
	ctx, cancel := context.WithCancel(f.ctx)
	defer cancel()
	f.ctx = ctx
	query := url.Values{"state": {secret.Random("")}, "code": {"cancelled"}}
	binding := secret.Random("")
	pending := model.LoginTransaction{ID: "consumed", ReturnPath: "/"}
	f.consume(query, binding, pending, nil)
	f.transaction()
	f.plan = []string{"validate-callback", "write", "consume", "finish"}
	f.replies["cancelled"] = identityReply{200, identityProfile("alice")}
	entered, release := make(chan struct{}), make(chan struct{})
	f.before = func(*http.Request) { close(entered); <-release }
	defer close(release)
	result := make(chan error, 1)
	go func() { _, err := f.identity.CompleteLogin(ctx, query, binding); result <- err }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("gateway did not start")
	}
	cancel()
	select {
	case err := <-result:
		var request *uniauth.RequestError
		if !errors.Is(err, context.Canceled) || !errors.As(err, &request) {
			t.Fatalf("cancel cause=%v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("request not drained")
	}
	if f.calls.Load() != 1 {
		t.Fatal("cancelled retrieval retried")
	}
}

func TestLoginEncodedProfileAdmissionAndNullableFields(t *testing.T) {
	for _, tc := range []struct {
		name, avatar string
		reject       bool
	}{{"expanded", strings.Repeat("<", 180000), true}, {"data URL", "data:image/png;base64," + strings.Repeat("a", 240000), false}} {
		t.Run(tc.name, func(t *testing.T) {
			f := newIdentityHTTPFixture(t)
			query := url.Values{"state": {secret.Random("")}, "code": {"profile"}}
			binding := secret.Random("")
			pending := model.LoginTransaction{ID: "consumed", Provider: "microsoft", ReturnPath: "/"}
			f.consume(query, binding, pending, nil)
			f.transaction()
			f.plan = []string{"validate-callback", "write", "consume", "finish", "provider", "profile"}
			profile := identityProfile("alice")
			profile["avatar_url"] = tc.avatar
			profile["name"], profile["email"], profile["email_verified"] = nil, nil, nil
			f.replies["profile"] = identityReply{200, profile}
			f.identity.ops.validateProvider = func(string, string, error) error { f.hit("provider"); return nil }
			f.identity.ops.admitProfileFields = func(got model.User) error {
				f.hit("profile")
				if got.AvatarURL == nil || *got.AvatarURL != tc.avatar || got.Email != nil || got.Name != nil || got.EmailVerified != nil {
					t.Fatalf("nullable SDK profile changed: %#v", got)
				}
				return nil
			}
			stop := errors.New("session marker")
			if !tc.reject {
				f.plan = append(f.plan, "new-session", "write")
				f.transaction()
				f.transactions[1].before = stop
				f.identity.ops.newSession = func(time.Time) (model.Session, string) { f.hit("new-session"); return model.Session{}, "opaque" }
			}
			got, err := f.identity.CompleteLogin(f.ctx, query, binding)
			f.equal(got, core.LoginCompletion{LoginID: pending.ID, ReturnPath: pending.ReturnPath})
			if tc.reject {
				var provider *model.IdentityProviderError
				var violation *limit.Violation
				if !errors.As(err, &provider) || provider.Code != "identity_unavailable" || !errors.As(err, &violation) || violation.Field != "profile" {
					t.Fatalf("encoded profile failure=%v", err)
				}
			} else if !errors.Is(err, stop) {
				t.Fatalf("data URL did not reach next stage: %v", err)
			}
		})
	}
}

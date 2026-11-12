package team

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	coreteam "github.com/codetreker/daynight/packages/daynight-server/internal/core/team"
	authhttp "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth"
	authconfig "github.com/codetreker/daynight/packages/daynight-server/internal/server/auth/config"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	teamservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/team"
)

const directActor = "10000000-0000-4000-8000-000000000001"
const directTeam = "20000000-0000-4000-8000-000000000001"
const directTarget = "30000000-0000-4000-8000-000000000001"
const directBody = `{"expectedUserId":"` + directActor + `","user":{"externalUserId":"microsoft:tenant:target","profile":{"name":"Target","avatarUrl":null}},"role":"member"}`

func directHTTP(t *testing.T, operation func(context.Context, model.Principal, string, coreteam.AddTeamMember) (coreteam.DirectMemberResult, error), logger *slog.Logger) http.Handler {
	t.Helper()
	auth, err := authhttp.NewRequestAuthentication(func(_ context.Context, kind model.CredentialKind, value string) (model.Principal, error) {
		if value != "valid" {
			return model.Principal{}, authhttp.Failure()
		}
		return model.Principal{UserID: directActor, CredentialID: "40000000-0000-4000-8000-000000000001", Kind: kind}, nil
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	h := &teamHandler{addMember: operation, logger: logger}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /api/v1/teams/{teamId}/members", auth.Require(h.addDirectMember))
	return httpx.RequestLogging(logger, mux)
}

func directRequest(body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/v1/teams/"+directTeam+"/members", strings.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer valid")
	r.Header.Set("X-Request-ID", "project-test")
	return r
}

func TestDirectMemberRouteUsesAuthentication(t *testing.T) {
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	calls := 0
	auth, err := authhttp.NewRequestAuthentication(func(context.Context, model.CredentialKind, string) (model.Principal, error) {
		calls++
		return model.Principal{}, authhttp.Failure()
	}, authconfig.AuthSettings{PublicOrigin: "https://daynight.example"}, logger)
	if err != nil {
		t.Fatal(err)
	}
	mux := http.NewServeMux()
	RegisterDirectMemberRoutes(mux, &teamservice.DirectMembers{}, &authhttp.Authentication{RequestAuthentication: auth}, logger)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, directRequest(directBody))
	if calls != 1 || w.Code != http.StatusUnauthorized {
		t.Fatalf("authentication calls=%d status=%d", calls, w.Code)
	}
}

func TestDirectMemberProtocol(t *testing.T) {
	for _, cookie := range []bool{false, true} {
		for _, added := range []bool{false, true} {
			calls := 0
			now := time.Date(2026, 11, 13, 0, 0, 0, 0, time.FixedZone("offset", 3600))
			member := model.TeamMember{TeamID: directTeam, UserID: directTarget, Role: model.ProjectMemberRole, Version: 9007199254740993, CreatedAt: now, UpdatedAt: now}
			deadline := time.Now().Add(time.Second)
			ctx, cancel := context.WithDeadline(context.Background(), deadline)
			h := directHTTP(t, func(got context.Context, p model.Principal, id string, input coreteam.AddTeamMember) (coreteam.DirectMemberResult, error) {
				calls++
				actual, ok := got.Deadline()
				wantKind := model.PATCredential
				if cookie {
					wantKind = model.SessionCredential
				}
				if !ok || !actual.Equal(deadline) || p.UserID != directActor || p.Kind != wantKind || p.CredentialID == "" || id != directTeam || input.ExpectedUserID != directActor || input.User.UniAuthID != "msft:target@tenant" || input.User.Name == nil || *input.User.Name != "Target" || input.Role != model.ProjectMemberRole {
					t.Fatalf("context/principal/input mismatch: %v %v %s %+v", actual, p, id, input)
				}
				return coreteam.DirectMemberResult{Membership: member, Added: added}, nil
			}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			r := directRequest(directBody).WithContext(ctx)
			if cookie {
				r.Header.Del("Authorization")
				r.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: "valid"})
				r.Header.Set("Origin", "https://daynight.example")
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			cancel()
			var got api.AddTeamMemberReceipt
			if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
				t.Fatal(err)
			}
			if calls != 1 || w.Code != 200 || got.Membership.UserID != directTarget || got.Membership.Version != member.Version || got.Membership.Role != "member" || got.Added != added || got.ActorRole != "admin" || got.Membership.CreatedAt.Location() != time.UTC || !got.Membership.CreatedAt.Equal(now) || w.Header().Get("Cache-Control") != "no-store" {
				t.Fatalf("calls=%d response=%s", calls, w.Body.String())
			}
		}
	}
}

func TestDirectMemberRejectsMalformedRequestsBeforeOperation(t *testing.T) {
	cases := []struct{ body, query, media string }{
		{`{}`, "", "application/json"},
		{strings.Replace(directBody, `,"role":"member"`, "", 1), "", "application/json"},
		{strings.Replace(directBody, `"user":{"externalUserId":"microsoft:tenant:target","profile":{"name":"Target","avatarUrl":null}}`, `"user":null`, 1), "", "application/json"},
		{strings.Replace(directBody, `"member"`, `false`, 1), "", "application/json"},
		{strings.Replace(directBody, `"expectedUserId":"`+directActor+`"`, `"expectedUserId":null`, 1), "", "application/json"},
		{strings.Replace(directBody, `"role":"member"`, `"role":"member","version":1`, 1), "", "application/json"},
		{strings.Replace(directBody, `"role":"member"`, `"role":"member","role":"admin"`, 1), "", "application/json"},
		{strings.Replace(directBody, `"name":"Target"`, `"name":"Target","email":null`, 1), "", "application/json"},
		{strings.Replace(directBody, `"name":"Target"`, `"name":"Target","name":"Other"`, 1), "", "application/json"},
		{strings.Replace(directBody, `microsoft:tenant:target`, `\ud800`, 1), "", "application/json"},
		{directBody, "?version=1", "application/json"},
		{directBody, "", "text/plain"},
		{strings.Repeat(" ", 1<<20) + directBody, "", "application/json"},
	}
	for i, tc := range cases {
		t.Run(string(rune('a'+i)), func(t *testing.T) {
			calls := 0
			h := directHTTP(t, func(context.Context, model.Principal, string, coreteam.AddTeamMember) (coreteam.DirectMemberResult, error) {
				calls++
				t.Fatal("rejected input reached operation")
				return coreteam.DirectMemberResult{}, nil
			}, slog.New(slog.NewTextHandler(io.Discard, nil)))
			r := directRequest(tc.body)
			r.URL.RawQuery = strings.TrimPrefix(tc.query, "?")
			r.Header.Set("Content-Type", tc.media)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			status, code := 400, "invalid_input"
			if len(tc.body) > 1<<20 {
				status, code = 413, "payload_too_large"
			}
			assertProjectError(t, w, status, code)
			if calls != 0 {
				t.Fatal(calls)
			}
		})
	}
}

func TestDirectMemberAuthenticationRejectsBeforeOperation(t *testing.T) {
	for _, setup := range []func(*http.Request){func(r *http.Request) { r.Header.Del("Authorization") }, func(r *http.Request) { r.Header.Set("Authorization", "Bearer invalid") }, func(r *http.Request) {
		r.Header.Del("Authorization")
		r.AddCookie(&http.Cookie{Name: "__Host-daynight_session", Value: "valid"})
	}} {
		calls := 0
		h := directHTTP(t, func(context.Context, model.Principal, string, coreteam.AddTeamMember) (coreteam.DirectMemberResult, error) {
			calls++
			return coreteam.DirectMemberResult{}, nil
		}, slog.New(slog.NewTextHandler(io.Discard, nil)))
		r := directRequest(directBody)
		setup(r)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if calls != 0 || (w.Code != 401 && w.Code != 403) {
			t.Fatalf("calls=%d status=%d", calls, w.Code)
		}
	}
}

func TestDirectMemberCancellationAndResponseLossDoNotRepeat(t *testing.T) {
	for _, mode := range []string{"cancel_operation", "cancel_response", "writer_error", "short_write"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			calls := 0
			var logs bytes.Buffer
			h := directHTTP(t, func(got context.Context, _ model.Principal, _ string, _ coreteam.AddTeamMember) (coreteam.DirectMemberResult, error) {
				calls++
				if mode == "cancel_operation" {
					cancel()
					<-got.Done()
					return coreteam.DirectMemberResult{}, got.Err()
				}
				if mode == "cancel_response" {
					cancel()
				}
				return coreteam.DirectMemberResult{Membership: model.TeamMember{TeamID: directTeam, UserID: directTarget}, Added: true}, nil
			}, slog.New(slog.NewJSONHandler(&logs, nil)))
			r := directRequest(directBody).WithContext(ctx)
			w := &threadFailingWriter{ResponseRecorder: httptest.NewRecorder(), short: mode == "short_write"}
			h.ServeHTTP(w, r)
			if calls != 1 || w.Body.Len() != 0 {
				t.Fatalf("calls=%d body=%s", calls, w.Body.String())
			}
			if mode == "cancel_operation" {
				if w.calls != 0 {
					t.Fatal("canceled operation wrote response")
				}
				return
			}
			if !strings.Contains(logs.String(), `"team_error_code":"write_outcome_unknown"`) || !strings.Contains(logs.String(), `"write_outcome":"unknown"`) {
				t.Fatalf("logs=%s", logs.String())
			}
			if mode == "cancel_response" {
				if w.calls != 0 {
					t.Fatal("canceled response wrote bytes")
				}
			} else if w.Code != 200 || w.calls != 1 {
				t.Fatalf("status=%d writes=%d", w.Code, w.calls)
			}
		})
	}
}

func TestDirectMemberCompletionErrors(t *testing.T) {
	missingCredential := &store.Error{MissingRow: true, Cause: model.ErrNotFound}
	credentialRefusal := &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.Unauthenticated(missingCredential)}
	unknown := &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("private commit")}
	cleanup := &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.New("private cleanup")}
	network := &net.OpError{Op: "read", Net: "tcp", Err: errors.New("private network")}
	for _, tc := range []struct {
		name   string
		err    error
		status int
		code   string
	}{
		{"unknown", &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("private commit")}, 503, "write_outcome_unknown"},
		{"unknown_deadline", &store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: context.DeadlineExceeded}, 503, "write_outcome_unknown"},
		{"cleanup_priority", errors.Join(&store.TransactionError{Phase: "commit", Outcome: store.TransactionUnknown, CommitAttempted: true, Cause: errors.New("private commit")}, &store.TransactionError{Phase: "cleanup", Outcome: store.TransactionUnknown, CleanupFailed: true, Cause: errors.New("private cleanup")}), 500, "internal_error"},
		{"sql_refusal", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &store.Error{DatabaseFailure: true, Cause: &model.Fault{Code: "forbidden", Message: "private SQL"}}}, 500, "internal_error"},
		{"role_conflict", &model.Fault{Code: "resource_conflict", Message: "Membership has another role."}, 409, "resource_conflict"},
		{"revoked", &model.Fault{Code: "unauthenticated", Message: "Credential revoked."}, 401, "unauthenticated"},
		{"missing_credential", credentialRefusal, 401, "unauthenticated"},
		{"missing_credential_sentinel", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: model.Unauthenticated(model.ErrNotFound)}, 401, "unauthenticated"},
		{"nested_missing_credential", fmt.Errorf("Team operation: %w", fmt.Errorf("credential lookup: %w", credentialRefusal)), 401, "unauthenticated"},
		{"joined_missing_credential_first", errors.Join(credentialRefusal, errors.New("private context")), 401, "unauthenticated"},
		{"joined_missing_credential_last", errors.Join(errors.New("private context"), credentialRefusal), 401, "unauthenticated"},
		{"credential_unknown_first", errors.Join(unknown, credentialRefusal), 503, "write_outcome_unknown"},
		{"credential_unknown_last", errors.Join(credentialRefusal, unknown), 503, "write_outcome_unknown"},
		{"credential_cleanup_first", errors.Join(cleanup, credentialRefusal), 500, "internal_error"},
		{"credential_cleanup_last", errors.Join(credentialRefusal, cleanup), 500, "internal_error"},
		{"credential_sql_first", errors.Join(&store.Error{DatabaseFailure: true, Cause: errors.New("private SQL")}, credentialRefusal), 500, "internal_error"},
		{"credential_sql_last", errors.Join(credentialRefusal, &store.Error{DatabaseFailure: true, Cause: errors.New("private SQL")}), 500, "internal_error"},
		{"credential_network_first", errors.Join(network, credentialRefusal), 500, "internal_error"},
		{"credential_network_last", errors.Join(credentialRefusal, network), 500, "internal_error"},
		{"missing_team", &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: &store.Error{MissingRow: true, Cause: model.ErrNotFound}}, 404, "not_found"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			var logs bytes.Buffer
			h := directHTTP(t, func(context.Context, model.Principal, string, coreteam.AddTeamMember) (coreteam.DirectMemberResult, error) {
				calls++
				return coreteam.DirectMemberResult{}, tc.err
			}, slog.New(slog.NewJSONHandler(&logs, nil)))
			w := httptest.NewRecorder()
			h.ServeHTTP(w, directRequest(directBody))
			assertProjectError(t, w, tc.status, tc.code)
			if calls != 1 || strings.Contains(w.Body.String(), "private") || strings.Contains(logs.String(), "private") {
				t.Fatalf("calls=%d body=%s logs=%s", calls, w.Body.String(), logs.String())
			}
		})
	}
}

type directCredentialDAO struct {
	store.IdentityDAO
	check func(context.Context, model.Principal, time.Time) error
}

func (d directCredentialDAO) LockProfileCredential(ctx context.Context, p model.Principal, now time.Time) error {
	return d.check(ctx, p, now)
}

type directAuthorizationDAO struct {
	store.TeamWriteDAO
	t      *testing.T
	read   func(context.Context, string) (model.Team, error)
	writes *int
}

func (d directAuthorizationDAO) Team(ctx context.Context, userID string) (model.Team, error) {
	return d.read(ctx, userID)
}

func (d directAuthorizationDAO) Member(context.Context, string) (model.TeamMember, error) {
	d.t.Fatal("credential refusal reached target membership lookup")
	return model.TeamMember{}, nil
}

func (d directAuthorizationDAO) AddMember(context.Context, string, model.ProjectRole) (model.TeamMember, error) {
	*d.writes++
	d.t.Fatal("credential refusal reached membership write")
	return model.TeamMember{}, nil
}

type directCredentialScope struct {
	t        *testing.T
	identity store.IdentityDAO
	team     store.TeamWriteDAO
}

func (s directCredentialScope) IdentityDAO() store.IdentityDAO                 { return s.identity }
func (s directCredentialScope) CredentialFamilyDAO() store.CredentialFamilyDAO { return nil }
func (s directCredentialScope) TeamDAO() store.TeamWriteDAO                    { return s.team }
func (s directCredentialScope) EligibilityDAO() store.WebhookEligibilityDAO {
	s.t.Fatal("credential refusal reached eligibility")
	return nil
}

type directCredentialWriter struct {
	t     *testing.T
	write func(context.Context, string, func(store.TeamWriteScope) error) (store.Completion, error)
}

func (w directCredentialWriter) CreateTeam(context.Context, string, func(store.TeamCreationDAO) error) (store.Completion, error) {
	w.t.Fatal("direct membership attempted Team creation")
	return store.Completion{}, nil
}
func (w directCredentialWriter) WriteTeam(ctx context.Context, id string, op func(store.TeamWriteScope) error) (store.Completion, error) {
	return w.write(ctx, id, op)
}

func TestDirectMemberCredentialRefusalAcrossInitializationReturns401(t *testing.T) {
	for _, final := range []bool{false, true} {
		t.Run(map[bool]string{false: "initial_scope", true: "final_scope"}[final], func(t *testing.T) {
			var events []string
			writes, ensured, scopes := 0, 0, 0
			completeTarget := model.User{ID: directTarget, UniAuthID: "msft:target@tenant", PersonalTeam: model.TeamRef{ID: "50000000-0000-4000-8000-000000000001", Kind: "personal"}}
			deadline := time.Now().Add(time.Second)
			ctx, cancel := context.WithDeadline(context.Background(), deadline)
			defer cancel()
			writer := directCredentialWriter{t: t, write: func(got context.Context, id string, op func(store.TeamWriteScope) error) (store.Completion, error) {
				scopes++
				if id != directTeam {
					t.Fatalf("Team ID=%s", id)
				}
				scope := directCredentialScope{t: t,
					identity: directCredentialDAO{check: func(got context.Context, p model.Principal, now time.Time) error {
						events = append(events, "credential")
						actual, ok := got.Deadline()
						if !ok || !actual.Equal(deadline) || p.UserID != directActor || p.CredentialID != "40000000-0000-4000-8000-000000000001" || p.Kind != model.PATCredential || now.IsZero() {
							t.Fatalf("credential context/actor=%v %+v", actual, p)
						}
						if !final || scopes == 2 {
							return &store.Error{MissingRow: true, Cause: model.ErrNotFound}
						}
						return nil
					}},
					team: directAuthorizationDAO{t: t, writes: &writes, read: func(_ context.Context, userID string) (model.Team, error) {
						events = append(events, "admin")
						if userID != directActor {
							t.Fatalf("Team actor=%s", userID)
						}
						return model.Team{TeamRef: model.TeamRef{ID: directTeam, Kind: "ordinary"}, Membership: model.TeamMember{TeamID: directTeam, UserID: directActor, Role: model.ProjectAdmin}}, nil
					}},
				}
				if err := op(scope); err != nil {
					return store.Completion{Outcome: store.TransactionNotCommitted}, &store.TransactionError{Phase: "operation", Outcome: store.TransactionNotCommitted, Cause: err}
				}
				return store.Completion{Outcome: store.TransactionCommitted}, nil
			}}
			members := teamservice.NewDirectMembers(writer, func(got context.Context, input model.User) (model.User, error) {
				ensured++
				events = append(events, "ensure")
				if input.UniAuthID != completeTarget.UniAuthID || input.ID != "" {
					t.Fatalf("target input=%+v", input)
				}
				actual, ok := got.Deadline()
				if !ok || !actual.Equal(deadline) {
					t.Fatal("ensure lost deadline")
				}
				return completeTarget, nil
			}, "https://daynight.example/api/v1")
			var logs bytes.Buffer
			h := directHTTP(t, members.AddMember, slog.New(slog.NewJSONHandler(&logs, nil)))
			w := httptest.NewRecorder()
			h.ServeHTTP(w, directRequest(directBody).WithContext(ctx))
			assertProjectError(t, w, 401, "unauthenticated")
			want := []string{"credential"}
			wantScopes, wantEnsure := 1, 0
			if final {
				want = []string{"credential", "admin", "ensure", "credential"}
				wantScopes, wantEnsure = 2, 1
			}
			if writes != 0 || scopes != wantScopes || ensured != wantEnsure || !reflect.DeepEqual(events, want) {
				t.Fatalf("scopes=%d ensure=%d writes=%d events=%v", scopes, ensured, writes, events)
			}
		})
	}
}

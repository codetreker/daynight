package server

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	usage "github.com/codetreker/daynight/packages/daynight-server/internal/core/credentialusage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/oauth"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/server/httpx"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/application"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/credentialusage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
)

type usageAssemblyBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (b *usageAssemblyBuffer) Write(p []byte) (int, error) {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.Write(p)
}
func (b *usageAssemblyBuffer) String() string {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.b.String()
}

type usageAssemblyIdentity struct {
	application.IdentityOperations
	entered chan struct{}
	release <-chan struct{}
}

func (a usageAssemblyIdentity) User(_ context.Context, _ model.Principal) (model.User, error) {
	close(a.entered)
	<-a.release
	return model.User{}, &model.Fault{Code: "not_found", Message: "not found"}
}

type usageAssemblyBody struct {
	entered chan struct{}
	release <-chan struct{}
}

func (b usageAssemblyBody) Read([]byte) (int, error) {
	close(b.entered)
	<-b.release
	return 0, io.EOF
}
func (usageAssemblyBody) Close() error { return nil }

type usageAssemblyFamilyScope struct{ dao store.CredentialFamilyDAO }

func (s usageAssemblyFamilyScope) CredentialFamilyDAO() store.CredentialFamilyDAO { return s.dao }

type usageAssemblyFamilyDAO struct {
	store.CredentialFamilyDAO
	t         *testing.T
	principal model.Principal
	grantID   string
}

func (d usageAssemblyFamilyDAO) AuthenticateAccess(_ context.Context, hash []byte, resource, scope string, at time.Time) (store.OAuthAccessIdentity, error) {
	if !bytes.Equal(hash, secret.Hash(httpTestToken(model.OAuthCredential))) || resource != "https://daynight.example/mcp" || scope != oauth.Scope || at.IsZero() {
		d.t.Fatal("unexpected OAuth authentication input")
	}
	return store.OAuthAccessIdentity{Principal: d.principal, GrantID: d.grantID}, nil
}

func TestCredentialUsageThroughServerAssembly(t *testing.T) {
	for _, tc := range []struct{ name, mode, route string }{
		{"http accepted", "accepted", "http"},
		{"mcp pat accepted", "accepted", "mcp"},
		{"mcp oauth accepted", "accepted", "oauth"},
		{"http full", "full", "http"},
		{"mcp full", "full", "mcp"},
		{"http stopped", "stopped", "http"},
		{"mcp stopped", "stopped", "mcp"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var logs usageAssemblyBuffer
			logger := slog.New(slog.NewJSONHandler(&logs, nil))
			principal := defaultHTTPPrincipal()
			grantID := "c3333333-3333-4333-8333-333333333333"
			database := newHTTPTestStoreForPrincipal(t, principal)
			database.WriteCredentialFamilyCall = func(ctx context.Context, fn func(store.CredentialFamilyScope) error) (store.Completion, error) {
				oauthPrincipal := model.Principal{Kind: model.OAuthCredential, UserID: principal.UserID, CredentialID: "d4444444-4444-4444-8444-444444444444"}
				err := fn(usageAssemblyFamilyScope{dao: usageAssemblyFamilyDAO{t: t, principal: oauthPrincipal, grantID: grantID}})
				return store.Completion{Outcome: store.TransactionCommitted}, err
			}
			c := configuredTestConfig()
			client, err := service.NewIdentityClient(c.UniAuth)
			if err != nil {
				t.Fatal(err)
			}
			app := service.NewModules(c, database, nil, attachmentTestFiles(t), client)
			entered, release := make(chan struct{}), make(chan struct{})
			fillRelease := make(chan struct{})
			var releaseOnce, fillOnce sync.Once
			unblock := func() { releaseOnce.Do(func() { close(release) }) }
			unblockFill := func() { fillOnce.Do(func() { close(fillRelease) }) }
			defer unblock()
			defer unblockFill()
			app.Identity = usageAssemblyIdentity{IdentityOperations: app.Identity, entered: entered, release: release}
			written := make(chan model.CredentialUsageEvent, 8)
			writerEntered := make(chan struct{}, 1)
			recorder, err := credentialusage.New(runtimeUsageWriter(func(ctx context.Context, events []model.CredentialUsageEvent) (store.Completion, error) {
				if tc.mode == "full" {
					select {
					case writerEntered <- struct{}{}:
					default:
					}
					select {
					case <-fillRelease:
					case <-ctx.Done():
						return store.Completion{Outcome: store.TransactionNotCommitted}, ctx.Err()
					}
				} else {
					for _, event := range events {
						written <- event
					}
				}
				return store.Completion{Outcome: store.TransactionCommitted}, nil
			}), logger, nil)
			if err != nil {
				t.Fatal(err)
			}
			if err := recorder.Start(context.Background()); err != nil {
				t.Fatal(err)
			}
			app.CredentialUsage = recorder
			handler, err := New(app, c, logger)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				unblock()
				unblockFill()
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer cancel()
				handler.BeginShutdown()
				if err := handler.Shutdown(ctx); err != nil {
					t.Error(err)
				}
				if err := recorder.Drain(ctx); err != nil {
					t.Error(err)
				}
			}()
			if tc.mode == "stopped" {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				err := recorder.Drain(ctx)
				cancel()
				if err != nil {
					t.Fatal(err)
				}
			}
			if tc.mode == "full" {
				for i := 1; i <= usage.ResidentLimit; i++ {
					ctx := credentialusage.WithSource(usage.WithCollector(requestid.With(context.Background(), "fill"), &usage.Collector{}), usage.SourceHTTPPAT)
					event := model.CredentialUsageEvent{Kind: model.UsageSubjectPAT, UserID: principal.UserID, SubjectID: fmt.Sprintf("00000000-0000-4000-8000-%012x", i), At: time.Now().UTC().Truncate(time.Microsecond)}
					if admission, err := recorder.Record(ctx, event); err != nil || admission != usage.Accepted {
						t.Fatalf("fill %d: %v %v", i, admission, err)
					}
					if i == 1 {
						select {
						case <-writerEntered:
						case <-time.After(5 * time.Second):
							t.Fatal("writer did not start")
						}
					}
				}
			}
			var req *http.Request
			if tc.route == "http" {
				req = httptest.NewRequest(http.MethodGet, "/api/v1/me", nil)
			} else {
				req = httptest.NewRequest(http.MethodPost, "/mcp", nil)
				req.Body = usageAssemblyBody{entered: entered, release: release}
			}
			token := httpTestToken(model.PATCredential)
			subject, kind := principal.CredentialID, model.UsageSubjectPAT
			if tc.route == "oauth" {
				token, subject, kind = httpTestToken(model.OAuthCredential), grantID, model.UsageSubjectOAuthGrant
			}
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("X-Request-ID", "assembled-use")
			before := time.Now().UTC().Truncate(time.Microsecond)
			response := httptest.NewRecorder()
			done := make(chan struct{})
			go func() { httpx.RequestLogging(logger, handler).ServeHTTP(response, req); close(done) }()
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("request did not reach blocked handler")
			}
			if tc.mode == "accepted" {
				select {
				case event := <-written:
					if event.Kind != kind || event.UserID != principal.UserID || event.SubjectID != subject || event.At.Before(before) || event.At.After(time.Now().UTC()) || event.At.Location() != time.UTC || event.At.Nanosecond()%1000 != 0 {
						t.Fatalf("usage event %+v", event)
					}
				case <-time.After(5 * time.Second):
					t.Fatal("usage writer did not receive the event")
				}
			} else {
				code := "queue_full"
				if tc.mode == "stopped" {
					code = "shutdown_incomplete"
				}
				got := logs.String()
				if !strings.Contains(got, `"error_code":"`+code+`"`) || !strings.Contains(got, `"subject_id":"`+subject+`"`) || !strings.Contains(got, `"origin_request_id":"assembled-use"`) || strings.Contains(got, token) {
					t.Fatalf("fault unavailable while request is blocked: %s", got)
				}
			}
			unblock()
			select {
			case <-done:
			case <-time.After(5 * time.Second):
				t.Fatal("request did not finish")
			}
			if tc.route == "http" && response.Code != http.StatusNotFound || tc.route != "http" && response.Code < 400 {
				t.Fatalf("unexpected protocol result %d", response.Code)
			}
			if tc.mode != "accepted" {
				code := "queue_full"
				if tc.mode == "stopped" {
					code = "shutdown_incomplete"
				}
				if count := strings.Count(logs.String(), `"error_code":"`+code+`"`); count != 1 {
					t.Fatalf("fault published %d times", count)
				}
			}
			if tc.mode == "accepted" {
				ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
				err := recorder.Drain(ctx)
				cancel()
				if err != nil {
					t.Fatal(err)
				}
				select {
				case event := <-written:
					t.Fatalf("duplicate usage event %+v", event)
				default:
				}
			}
		})
	}
}

package github

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
	"time"

	core "github.com/codetreker/daynight/packages/daynight-server/internal/core/github"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

const projectAppResource = "44444444-4444-4444-8444-444444444444"
const projectAppGrantID = "55555555-5555-4555-8555-555555555555"
const projectAppTeamID = "66666666-6666-4666-8666-666666666666"

type projectAppScopeStub struct {
	t     *testing.T
	read  func(context.Context, string, func(store.GitHubProjectAppReadDAO) error) error
	write func(context.Context, string, string, string, func(store.GitHubProjectAppWriteDAO) error) (store.Completion, error)
}

func (s projectAppScopeStub) ReadGitHubProjectApp(ctx context.Context, id string, work func(store.GitHubProjectAppReadDAO) error) error {
	if s.read == nil {
		s.t.Fatal("unexpected read scope")
	}
	return s.read(ctx, id, work)
}
func (s projectAppScopeStub) WriteGitHubProjectApp(ctx context.Context, id, actor, app string, work func(store.GitHubProjectAppWriteDAO) error) (store.Completion, error) {
	if s.write == nil {
		s.t.Fatal("unexpected write scope")
	}
	return s.write(ctx, id, actor, app, work)
}

type projectAppDAOStub struct {
	store.GitHubProjectAppWriteDAO
	facts  func(context.Context, model.Principal) (store.GitHubProjectAppFacts, error)
	app    func(context.Context, string, string, string) (store.GitHubProjectApp, error)
	save   func(context.Context, store.GitHubProjectAppWrite) (bool, error)
	impact func(context.Context, string) error
}

func (d projectAppDAOStub) Facts(ctx context.Context, p model.Principal) (store.GitHubProjectAppFacts, error) {
	return d.facts(ctx, p)
}
func (d projectAppDAOStub) App(ctx context.Context, a, g, team string) (store.GitHubProjectApp, error) {
	return d.app(ctx, a, g, team)
}
func (d projectAppDAOStub) Save(ctx context.Context, w store.GitHubProjectAppWrite) (bool, error) {
	return d.save(ctx, w)
}
func (d projectAppDAOStub) AdvanceImpact(ctx context.Context, id string) error {
	return d.impact(ctx, id)
}
func (d projectAppDAOStub) ObservedAt(context.Context) (time.Time, error) {
	return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), nil
}

type projectAppAcquireFunc func(context.Context, string, int64) (*remote.Client, func(), error)

func (f projectAppAcquireFunc) Acquire(ctx context.Context, id string, v int64) (*remote.Client, func(), error) {
	return f(ctx, id, v)
}

func projectAppServiceFacts() store.GitHubProjectAppFacts {
	role := model.ProjectAdmin
	return store.GitHubProjectAppFacts{Project: model.Project{ID: mgmtProject, RepoURL: "https://github.com/owner/repo", Ownership: model.ProjectOwnership{TeamID: projectAppTeamID, Version: 8}}, Access: model.ProjectAccess{Role: role, TeamRole: &role}, Connection: githubpr.DefaultConnection(mgmtProject)}
}
func projectAppServiceSelection() core.ProjectAppSelection {
	return core.ProjectAppSelection{AppResourceID: projectAppResource, GrantID: projectAppGrantID, AppVersion: 2, OwnershipVersion: 8}
}
func projectAppReadDAO(t *testing.T, f store.GitHubProjectAppFacts) projectAppDAOStub {
	t.Helper()
	return projectAppDAOStub{facts: func(_ context.Context, p model.Principal) (store.GitHubProjectAppFacts, error) {
		if p != mgmtPrincipal {
			t.Fatalf("principal=%+v", p)
		}
		return f, nil
	}, app: func(_ context.Context, a, g, team string) (store.GitHubProjectApp, error) {
		if a != projectAppResource || g != projectAppGrantID || team != projectAppTeamID {
			t.Fatalf("App lookup=%s %s %s", a, g, team)
		}
		return store.GitHubProjectApp{ID: a, GitHubAppID: 13, Version: 2, CredentialVersion: 3, Name: "shared", GitHubSlug: "shared"}, nil
	}}
}

func projectAppRemoteClient(t *testing.T, handler http.HandlerFunc) *remote.Client {
	t.Helper()
	srv := httptest.NewTLSServer(handler)
	t.Cleanup(srv.Close)
	original := http.DefaultTransport
	transport := original.(*http.Transport).Clone()
	transport.Proxy = nil
	roots := x509.NewCertPool()
	roots.AddCert(srv.Certificate())
	transport.TLSClientConfig = &tls.Config{RootCAs: roots, ServerName: "example.com", MinVersion: tls.VersionTLS12}
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if addr != "api.github.com:443" {
			return nil, fmt.Errorf("unexpected origin %s", addr)
		}
		return (&net.Dialer{}).DialContext(ctx, network, srv.Listener.Addr().String())
	}
	http.DefaultTransport = transport
	key, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	client, err := remote.NewClient(13, key)
	http.DefaultTransport = original
	transport.CloseIdleConnections()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(client.CloseIdleConnections)
	return client
}
func projectAppRemoteResponse(t *testing.T, w http.ResponseWriter, r *http.Request) {
	t.Helper()
	switch r.URL.Path {
	case "/repos/owner/repo/installation":
		fmt.Fprint(w, `{"id":99,"account":{"login":"owner"}}`)
	case "/app/installations/99/access_tokens":
		w.WriteHeader(201)
		fmt.Fprintf(w, `{"token":"token","expires_at":%q}`, time.Now().Add(time.Hour).UTC().Format(time.RFC3339))
	case "/repos/owner/repo":
		fmt.Fprint(w, `{"id":42,"full_name":"owner/repo","private":true}`)
	case "/repos/owner/repo/pulls":
		fmt.Fprint(w, `[]`)
	case "/installation/repositories":
		fmt.Fprint(w, `{"repositories":[{"id":42,"full_name":"owner/repo","private":true}]}`)
	default:
		t.Errorf("unexpected remote path %s", r.URL)
		http.NotFound(w, r)
	}
}

func TestProjectAppManagerDiscoveryRechecksAndReleases(t *testing.T) {
	for _, stale := range []bool{false, true} {
		t.Run(fmt.Sprint(stale), func(t *testing.T) {
			var events []string
			client := projectAppRemoteClient(t, func(w http.ResponseWriter, r *http.Request) { projectAppRemoteResponse(t, w, r) })
			reads := 0
			db := projectAppScopeStub{t: t, read: func(ctx context.Context, id string, work func(store.GitHubProjectAppReadDAO) error) error {
				reads++
				events = append(events, "read")
				if id != mgmtProject {
					t.Fatal(id)
				}
				f := projectAppServiceFacts()
				if stale && reads == 2 {
					f.Project.Ownership.Version++
				}
				return work(projectAppReadDAO(t, f))
			}}
			provider := projectAppAcquireFunc(func(ctx context.Context, id string, v int64) (*remote.Client, func(), error) {
				if id != projectAppResource || v != 3 {
					t.Fatalf("acquire=%s %d", id, v)
				}
				events = append(events, "acquire")
				return client, func() { events = append(events, "release") }, nil
			})
			out, err := NewProjectAppManager(db, provider, slog.Default()).Discover(context.Background(), mgmtPrincipal, mgmtProject, projectAppServiceSelection())
			if reads != 2 || !reflect.DeepEqual(events, []string{"read", "acquire", "read", "release"}) {
				t.Fatalf("events=%v", events)
			}
			if stale {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "version_conflict" {
					t.Fatalf("stale=%v", err)
				}
			} else if err != nil || out.Installation.ID != 99 || out.Repository.ID != 42 {
				t.Fatalf("discovery=%+v %v", out, err)
			}
		})
	}
}

func TestProjectAppManagerPrecheckAndProviderFailure(t *testing.T) {
	cause := errors.New("provider unavailable")
	for _, mode := range []string{"role", "version", "provider", "read"} {
		t.Run(mode, func(t *testing.T) {
			acquires := 0
			f := projectAppServiceFacts()
			if mode == "role" {
				f.Access.TeamRole = nil
			}
			if mode == "version" {
				f.Connection.Version = 2
			}
			db := projectAppScopeStub{t: t, read: func(ctx context.Context, id string, work func(store.GitHubProjectAppReadDAO) error) error {
				if mode == "read" {
					return cause
				}
				return work(projectAppReadDAO(t, f))
			}}
			provider := projectAppAcquireFunc(func(context.Context, string, int64) (*remote.Client, func(), error) {
				acquires++
				return nil, nil, cause
			})
			_, err := NewProjectAppManager(db, provider, slog.Default()).Connect(context.Background(), mgmtPrincipal, mgmtProject, core.ProjectAppConnect{ProjectAppSelection: projectAppServiceSelection(), Version: 1, InstallationID: 99})
			if err == nil || (mode == "provider" && (acquires != 1 || !errors.Is(err, cause))) || (mode != "provider" && acquires != 0) {
				t.Fatalf("mode=%s acquire=%d err=%v", mode, acquires, err)
			}
		})
	}
}

func TestProjectAppManagerConnectBoundProofAndCompletion(t *testing.T) {
	for _, scenario := range []struct {
		name    string
		bound   bool
		outcome store.TransactionOutcome
	}{{"bound", true, store.TransactionCommitted}, {"unknown", true, store.TransactionUnknown}, {"initial", false, store.TransactionCommitted}} {
		t.Run(scenario.name, func(t *testing.T) {
			paths := []string{}
			client := projectAppRemoteClient(t, func(w http.ResponseWriter, r *http.Request) {
				paths = append(paths, r.URL.Path)
				projectAppRemoteResponse(t, w, r)
			})
			f := projectAppServiceFacts()
			repoID := int64(42)
			name := "owner/old-name"
			if scenario.bound {
				f.Connection.RepositoryID = &repoID
				f.Connection.RepositoryFullName = &name
			}
			releases, writes, saves := 0, 0, 0
			cause := errors.New("receipt lost")
			db := projectAppScopeStub{t: t, read: func(ctx context.Context, id string, work func(store.GitHubProjectAppReadDAO) error) error {
				return work(projectAppReadDAO(t, f))
			}, write: func(ctx context.Context, id, actor, app string, work func(store.GitHubProjectAppWriteDAO) error) (store.Completion, error) {
				writes++
				if id != mgmtProject || actor != mgmtPrincipal.UserID || app != projectAppResource {
					t.Fatalf("write=%s %s %s", id, actor, app)
				}
				dao := projectAppReadDAO(t, f)
				dao.save = func(ctx context.Context, w store.GitHubProjectAppWrite) (bool, error) {
					saves++
					if w.AppResourceID == nil || *w.AppResourceID != projectAppResource || w.GrantID == nil || *w.GrantID != projectAppGrantID || w.Configuration.RepositoryID == nil || *w.Configuration.RepositoryID != 42 {
						t.Fatalf("proof write=%+v", w)
					}
					return true, nil
				}
				dao.impact = func(context.Context, string) error { return nil }
				err := work(dao)
				if scenario.outcome == store.TransactionUnknown {
					err = errors.Join(err, cause)
				}
				return store.Completion{Outcome: scenario.outcome}, err
			}}
			provider := projectAppAcquireFunc(func(context.Context, string, int64) (*remote.Client, func(), error) {
				return client, func() { releases++ }, nil
			})
			_, err := NewProjectAppManager(db, provider, slog.Default()).Connect(context.Background(), mgmtPrincipal, mgmtProject, core.ProjectAppConnect{ProjectAppSelection: projectAppServiceSelection(), Version: 1, InstallationID: 99})
			if writes != 1 || saves != 1 || releases != 1 {
				t.Fatalf("writes=%d saves=%d release=%d err=%v", writes, saves, releases, err)
			}
			wantPaths := []string{"/app/installations/99/access_tokens", "/installation/repositories", "/repos/owner/repo", "/repos/owner/repo/pulls", "/repos/owner/repo/installation"}
			if !scenario.bound {
				wantPaths = []string{"/repos/owner/repo/installation", "/app/installations/99/access_tokens", "/repos/owner/repo", "/repos/owner/repo/pulls"}
			}
			if !reflect.DeepEqual(paths, wantPaths) {
				t.Fatalf("paths=%v", paths)
			}
			if scenario.outcome == store.TransactionUnknown {
				var mgmt *ManagementError
				if !errors.As(err, &mgmt) || mgmt.Code != "github_write_outcome_unknown" || !errors.Is(err, cause) {
					t.Fatalf("unknown=%v", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestProjectAppManagerLocalOperationsUseBoundScope(t *testing.T) {
	for _, op := range []string{"get", "disconnect", "settings", "sync"} {
		t.Run(op, func(t *testing.T) {
			f := projectAppServiceFacts()
			reads, writes := 0, 0
			dao := projectAppReadDAO(t, f)
			db := projectAppScopeStub{t: t, read: func(ctx context.Context, id string, work func(store.GitHubProjectAppReadDAO) error) error {
				reads++
				return work(dao)
			}, write: func(ctx context.Context, id, actor, app string, work func(store.GitHubProjectAppWriteDAO) error) (store.Completion, error) {
				writes++
				if id != mgmtProject || actor != mgmtPrincipal.UserID || app != "" {
					t.Fatalf("scope=%s %s %s", id, actor, app)
				}
				return store.Completion{Outcome: store.TransactionCommitted}, work(dao)
			}}
			manager := NewProjectAppManager(db, nil, slog.Default())
			var err error
			switch op {
			case "get":
				_, err = manager.Get(context.Background(), mgmtPrincipal, mgmtProject)
			case "disconnect":
				_, err = manager.Disconnect(context.Background(), mgmtPrincipal, mgmtProject, core.ProjectAppDisconnect{Version: 1, OwnershipVersion: 8})
			case "settings":
				_, err = manager.Settings(context.Background(), mgmtPrincipal, mgmtProject, 1, f.Connection.PollIntervalMinutes)
			case "sync":
				_, err = manager.Sync(context.Background(), mgmtPrincipal, mgmtProject, 1, false)
			}
			if err != nil || (op == "get" && (reads != 1 || writes != 0)) || (op != "get" && (reads != 0 || writes != 1)) {
				t.Fatalf("op=%s reads=%d writes=%d err=%v", op, reads, writes, err)
			}
		})
	}
}

func TestProjectAppManagerInvalidRequestsHaveNoExternalWork(t *testing.T) {
	for _, operation := range []string{"discover", "connect"} {
		for _, invalid := range []string{"principal", "project", "selection", "version", "installation"} {
			if operation == "discover" && (invalid == "version" || invalid == "installation") {
				continue
			}
			t.Run(operation+"/"+invalid, func(t *testing.T) {
				principal, id := mgmtPrincipal, mgmtProject
				in := core.ProjectAppConnect{ProjectAppSelection: projectAppServiceSelection(), Version: 1, InstallationID: 99}
				switch invalid {
				case "principal":
					principal = model.Principal{}
				case "project":
					id = "invalid"
				case "selection":
					in.GrantID = "invalid"
				case "version":
					in.Version = 0
				case "installation":
					in.InstallationID = 0
				}
				manager := NewProjectAppManager(projectAppScopeStub{t: t}, nil, slog.Default())
				var err error
				if operation == "discover" {
					_, err = manager.Discover(context.Background(), principal, id, in.ProjectAppSelection)
				} else {
					_, err = manager.Connect(context.Background(), principal, id, in)
				}
				var fault *model.Fault
				if !errors.As(err, &fault) || (fault.Code != "invalid_input" && fault.Code != "unauthenticated") {
					t.Fatalf("invalid request=%v", err)
				}
			})
		}
	}
	_, err := NewProjectAppManager(projectAppScopeStub{t: t}, nil, slog.Default()).Disconnect(context.Background(), mgmtPrincipal, mgmtProject, core.ProjectAppDisconnect{Version: 1})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "invalid_input" {
		t.Fatalf("missing ownership condition=%v", err)
	}
}

func TestProjectAppManagerDiscoveryFailureDoesNotReturnCandidate(t *testing.T) {
	for _, mode := range []string{"role", "read", "provider", "remote", "second-read", "connection-changed", "repository-changed"} {
		t.Run(mode, func(t *testing.T) {
			cause := errors.New("controlled unavailable dependency")
			client := projectAppRemoteClient(t, func(w http.ResponseWriter, r *http.Request) {
				if mode == "remote" {
					w.WriteHeader(http.StatusServiceUnavailable)
					return
				}
				projectAppRemoteResponse(t, w, r)
			})
			reads, acquired, released := 0, 0, 0
			db := projectAppScopeStub{t: t, read: func(ctx context.Context, id string, work func(store.GitHubProjectAppReadDAO) error) error {
				reads++
				if mode == "read" || (mode == "second-read" && reads == 2) {
					return cause
				}
				f := projectAppServiceFacts()
				if mode == "role" {
					f.Access.TeamRole = nil
				}
				if reads == 2 {
					if mode == "connection-changed" {
						f.Connection.Version++
					}
					if mode == "repository-changed" {
						f.Project.RepoURL = "https://github.com/owner/changed"
					}
				}
				return work(projectAppReadDAO(t, f))
			}}
			provider := projectAppAcquireFunc(func(context.Context, string, int64) (*remote.Client, func(), error) {
				acquired++
				if mode == "provider" {
					return nil, nil, cause
				}
				return client, func() { released++ }, nil
			})
			out, err := NewProjectAppManager(db, provider, slog.Default()).Discover(context.Background(), mgmtPrincipal, mgmtProject, projectAppServiceSelection())
			if err == nil || out != (core.InstallationCandidate{}) {
				t.Fatalf("candidate=%+v err=%v", out, err)
			}
			if mode == "read" || mode == "provider" || mode == "second-read" {
				if !errors.Is(err, cause) {
					t.Fatalf("lost cause=%v", err)
				}
			}
			wantAcquired, wantReleased, wantReads := 1, 1, 2
			switch mode {
			case "role", "read":
				wantAcquired, wantReleased, wantReads = 0, 0, 1
			case "provider":
				wantReleased, wantReads = 0, 1
			case "remote":
				wantReads = 1
				var upstream *remote.Error
				if !errors.As(err, &upstream) || upstream.Status != http.StatusServiceUnavailable {
					t.Fatalf("remote cause=%v", err)
				}
			}
			if acquired != wantAcquired || released != wantReleased || reads != wantReads {
				t.Fatalf("read/acquire/release=%d/%d/%d", reads, acquired, released)
			}
		})
	}
}

func TestProjectAppManagerConnectProofFailureReleasesWithoutWrite(t *testing.T) {
	for _, mode := range []string{"invalid-repository", "pull-request-access"} {
		t.Run(mode, func(t *testing.T) {
			requests := 0
			client := projectAppRemoteClient(t, func(w http.ResponseWriter, r *http.Request) {
				requests++
				if r.URL.Path == "/repos/owner/repo/pulls" {
					w.WriteHeader(http.StatusForbidden)
					fmt.Fprint(w, `{"message":"Resource not accessible by integration"}`)
					return
				}
				projectAppRemoteResponse(t, w, r)
			})
			f := projectAppServiceFacts()
			if mode == "invalid-repository" {
				f.Project.RepoURL = "https://example.com/owner/repo"
			}
			db := projectAppScopeStub{t: t, read: func(ctx context.Context, id string, work func(store.GitHubProjectAppReadDAO) error) error {
				return work(projectAppReadDAO(t, f))
			}}
			released := 0
			provider := projectAppAcquireFunc(func(context.Context, string, int64) (*remote.Client, func(), error) {
				return client, func() { released++ }, nil
			})
			out, err := NewProjectAppManager(db, provider, slog.Default()).Connect(context.Background(), mgmtPrincipal, mgmtProject, core.ProjectAppConnect{ProjectAppSelection: projectAppServiceSelection(), Version: 1, InstallationID: 99})
			if err == nil || out.Connection.ProjectID != "" || released != 1 {
				t.Fatalf("out=%+v released=%d err=%v", out, released, err)
			}
			if mode == "invalid-repository" {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != "github_repository_mismatch" || requests != 0 {
					t.Fatalf("invalid repository: requests=%d err=%v", requests, err)
				}
			} else {
				var management *ManagementError
				var upstream *remote.Error
				if !errors.As(err, &management) || management.Code != "github_permission_denied" || !errors.As(err, &upstream) || upstream.Status != http.StatusForbidden {
					t.Fatalf("PR permission failure=%v", err)
				}
			}
		})
	}
}

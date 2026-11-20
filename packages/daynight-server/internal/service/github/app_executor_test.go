package github

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/githubpr"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/github/remote"
)

func TestAppExecutorDiagnosticsRetainAdmittedConnectionIdentity(t *testing.T) {
	for _, failWork := range []bool{false, true} {
		t.Run(fmt.Sprintf("failure=%v", failWork), func(t *testing.T) {
			f := newPollFixture(t)
			f.workKind, f.connection.NextPollAt = "webhook", nil
			db := appFixtureStore(t, f)
			cause := errors.New(diagnosticPrivateContent)
			write := db.write
			db.write = func(ctx context.Context, project string, expected *store.GitHubAppWorkIdentity, fn func(store.GitHubAppWorkDAO) error) (store.Completion, error) {
				if failWork && expected != nil {
					return store.Completion{Outcome: store.TransactionNotCommitted}, cause
				}
				return write(ctx, project, expected, fn)
			}
			var output bytes.Buffer
			e, err := NewAppExecutor(db, appClientFunc(func(context.Context, string, int64) (*remote.Client, func(), error) {
				// Later connection reads must not replace the identity captured at admission.
				repository, installation := int64(300), int64(200)
				f.connection.RepositoryID, f.connection.InstallationID = &repository, &installation
				return &remote.Client{}, func() {}, nil
			}), slog.New(slog.NewJSONHandler(&output, nil)))
			if err != nil {
				t.Fatal(err)
			}
			err = e.Execute(context.Background(), testProject)
			if (failWork && !errors.Is(err, cause)) || (!failWork && err != nil) {
				t.Fatalf("execution result: %v", err)
			}
			records := diagnosticRecords(t, &output)
			if len(records) != 2 {
				t.Fatalf("execution records=%d, want start and terminal", len(records))
			}
			for _, record := range records {
				for key, value := range map[string]any{"component": "github_sync", "project_id": testProject, "sync_id": f.lease.Token, "repository_id": float64(30), "installation_id": float64(20), "app_resource_id": executionIdentity.AppResourceID, "app_id": float64(10), "credential_version": float64(3), "grant_id": executionIdentity.GrantID, "team_id": executionIdentity.TeamID, "ownership_version": float64(7), "generation": float64(7), "trigger": "webhook"} {
					if record[key] != value {
						t.Fatalf("%s=%v, want %v", key, record[key], value)
					}
				}
			}
			t.Log(output.String())
		})
	}
}

type appExecutionStore struct {
	store.SnapshotReader
	write func(context.Context, string, *store.GitHubAppWorkIdentity, func(store.GitHubAppWorkDAO) error) (store.Completion, error)
}

func (s appExecutionStore) WriteGitHubAppWork(ctx context.Context, project string, expected *store.GitHubAppWorkIdentity, fn func(store.GitHubAppWorkDAO) error) (store.Completion, error) {
	return s.write(ctx, project, expected, fn)
}

type appExecutionDAO struct {
	store.GitHubWorkDAO
	identity store.GitHubAppWorkIdentity
}

func (d appExecutionDAO) Identity() store.GitHubAppWorkIdentity { return d.identity }

type noClaimDAO struct {
	store.GitHubAppWorkDAO
	t *testing.T
}

func (d noClaimDAO) Claim(context.Context, store.GitHubClaim) (bool, error) {
	d.t.Fatal("claimed work that is not due")
	return false, nil
}

type appClientFunc func(context.Context, string, int64) (*remote.Client, func(), error)

func (f appClientFunc) Acquire(ctx context.Context, id string, version int64) (*remote.Client, func(), error) {
	return f(ctx, id, version)
}

var executionIdentity = store.GitHubAppWorkIdentity{AppResourceID: "58484824-12a6-42f3-914a-052a6673403b", GrantID: "878c7887-c79d-4c79-8ac8-d19f40a1d146", TeamID: "90f335d4-873a-4812-a611-247437338c23", AppID: 10, CredentialVersion: 3, OwnershipVersion: 7}

func appFixtureStore(t *testing.T, f *pollFixture) appExecutionStore {
	t.Helper()
	return appExecutionStore{SnapshotReader: f.db, write: func(ctx context.Context, project string, expected *store.GitHubAppWorkIdentity, fn func(store.GitHubAppWorkDAO) error) (store.Completion, error) {
		if (f.transactions == 0) != (expected == nil) {
			t.Fatalf("admission identity: transaction=%d expected=%+v", f.transactions, expected)
		}
		if expected != nil && *expected != executionIdentity {
			t.Fatalf("original authorization changed: %+v", expected)
		}
		return f.db.WriteWork(ctx, project, func(dao store.GitHubWorkDAO) error {
			return fn(appExecutionDAO{GitHubWorkDAO: dao, identity: executionIdentity})
		})
	}}
}

func appExecutor(t *testing.T, db AppExecutionStore, source AppClientSource) *AppExecutor {
	t.Helper()
	e, err := NewAppExecutor(db, source, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	return e
}

func TestAppExecutorRequiresConfirmedAdmissionBeforeAcquire(t *testing.T) {
	cause := errors.New("store failed")
	for _, tc := range []struct {
		name    string
		outcome store.TransactionOutcome
		failure error
		want    error
	}{
		{"unknown", store.TransactionUnknown, cause, errUnknown},
		{"refused", store.TransactionNotCommitted, cause, cause},
		{"unavailable", store.TransactionNotCommitted, store.ErrGitHubAppWorkUnavailable, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newPollFixture(t)
			db := appFixtureStore(t, f)
			write := db.write
			db.write = func(ctx context.Context, project string, expected *store.GitHubAppWorkIdentity, fn func(store.GitHubAppWorkDAO) error) (store.Completion, error) {
				if tc.name != "unavailable" {
					if _, err := write(ctx, project, expected, fn); err != nil {
						t.Fatal(err)
					}
				}
				return store.Completion{Outcome: tc.outcome}, tc.failure
			}
			e := appExecutor(t, db, appClientFunc(func(context.Context, string, int64) (*remote.Client, func(), error) {
				t.Fatal("borrowed without confirmed admission")
				return nil, nil, nil
			}))
			err := e.Execute(context.Background(), testProject)
			if (tc.want == nil && err != nil) || (tc.want != nil && !errors.Is(err, tc.want)) {
				t.Fatalf("admission error: %v", err)
			}
		})
	}
}

func TestAppExecutorIdleAndProviderFailure(t *testing.T) {
	f := newPollFixture(t)
	f.connection.SyncEnabled = false
	f.connection.RepositoryID, f.connection.InstallationID = nil, nil
	e := appExecutor(t, appFixtureStore(t, f), appClientFunc(func(context.Context, string, int64) (*remote.Client, func(), error) {
		t.Fatal("borrowed for idle Project")
		return nil, nil, nil
	}))
	if err := e.Execute(context.Background(), testProject); err != nil {
		t.Fatal(err)
	}
	f = newPollFixture(t)
	cause := errors.New("credential read failed")
	e = appExecutor(t, appFixtureStore(t, f), appClientFunc(func(_ context.Context, app string, version int64) (*remote.Client, func(), error) {
		if app != executionIdentity.AppResourceID || version != executionIdentity.CredentialVersion || f.lease.Token == "" {
			t.Fatalf("borrowed wrong/unclaimed identity %q %d", app, version)
		}
		return nil, nil, cause
	}))
	if err := e.Execute(context.Background(), testProject); !errors.Is(err, cause) {
		t.Fatalf("provider failure: %v", err)
	}
}

func TestAppExecutorEnabledWithoutDueWorkDoesNotClaim(t *testing.T) {
	f := newPollFixture(t)
	next := f.now.Add(time.Minute)
	f.connection.NextPollAt = &next
	db := appFixtureStore(t, f)
	write := db.write
	db.write = func(ctx context.Context, project string, expected *store.GitHubAppWorkIdentity, fn func(store.GitHubAppWorkDAO) error) (store.Completion, error) {
		if expected != nil {
			t.Fatal("started a work transaction without a claim")
		}
		return write(ctx, project, expected, func(dao store.GitHubAppWorkDAO) error {
			return fn(noClaimDAO{GitHubAppWorkDAO: dao, t: t})
		})
	}
	e := appExecutor(t, db, appClientFunc(func(context.Context, string, int64) (*remote.Client, func(), error) {
		t.Fatal("borrowed a client without due work")
		return nil, nil, nil
	}))
	if err := e.Execute(context.Background(), testProject); err != nil {
		t.Fatal(err)
	}
	if f.transactions != 1 || f.lease.Token != "" || len(f.runtimes) != 0 || len(f.publications) != 0 {
		t.Fatalf("unexpected work: transactions=%d lease=%+v runtimes=%d publications=%d", f.transactions, f.lease, len(f.runtimes), len(f.publications))
	}
}

func TestAppExecutorBoundsAcquisitionAndHonorsEarlierDeadline(t *testing.T) {
	f := newPollFixture(t)
	calls := 0
	e := appExecutor(t, appFixtureStore(t, f), appClientFunc(func(ctx context.Context, _ string, _ int64) (*remote.Client, func(), error) {
		calls++
		deadline, ok := ctx.Deadline()
		if !ok || time.Until(deadline) > 15*time.Second {
			t.Fatal("client acquisition lacks bounded deadline")
		}
		<-ctx.Done()
		return nil, nil, ctx.Err()
	}))
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if err := e.ExecuteWithClaimContext(ctx, context.Background(), testProject); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("acquisition deadline: %v", err)
	}
	if calls != 1 || len(f.runtimes) != 0 {
		t.Fatalf("acquisitions=%d runtime writes=%d", calls, len(f.runtimes))
	}
}

func TestAppExecutorReleasesClientAfterRuntimeAndRetainsIdentity(t *testing.T) {
	f := newPollFixture(t)
	f.workKind, f.connection.NextPollAt = "webhook", nil
	released := 0
	e := appExecutor(t, appFixtureStore(t, f), appClientFunc(func(context.Context, string, int64) (*remote.Client, func(), error) {
		return &remote.Client{}, func() {
			released++
			if len(f.runtimes) != 1 || !f.runtimes[0].ReleaseClaim {
				t.Fatal("released before work exited")
			}
		}, nil
	}))
	if err := e.Execute(context.Background(), testProject); err != nil {
		t.Fatal(err)
	}
	if released != 1 || f.transactions != 3 {
		t.Fatalf("release=%d transactions=%d", released, f.transactions)
	}
}

func TestAppExecutorRequestCheckpointRejectsOriginalAuthorizationAndReleases(t *testing.T) {
	f := newPollFixture(t)
	db := appFixtureStore(t, f)
	write := db.write
	checks := 0
	db.write = func(ctx context.Context, project string, expected *store.GitHubAppWorkIdentity, fn func(store.GitHubAppWorkDAO) error) (store.Completion, error) {
		if expected != nil {
			if *expected != executionIdentity {
				t.Fatalf("checkpoint identity changed: %+v", expected)
			}
			checks++
			if checks == 2 {
				return store.Completion{Outcome: store.TransactionNotCommitted}, store.ErrGitHubAppWorkUnavailable
			}
		}
		return write(ctx, project, expected, fn)
	}
	provider, err := NewClientProvider(credentialReaderFunc(func(_ context.Context, app string) (githubpr.CredentialSnapshot, error) {
		return snapshot(app, executionIdentity.CredentialVersion, providerKey(t)), nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { closeProvider(t, provider) })
	released := 0
	e := appExecutor(t, db, appClientFunc(func(ctx context.Context, app string, version int64) (*remote.Client, func(), error) {
		client, release, err := provider.Acquire(ctx, app, version)
		return client, func() { released++; release() }, err
	}))
	err = e.Execute(context.Background(), testProject)
	if !errors.Is(err, store.ErrGitHubAppWorkUnavailable) || !errors.Is(err, errCheckpoint) || checks != 2 || released != 1 {
		t.Fatalf("checkpoint result=%v checks=%d released=%d", err, checks, released)
	}
}

func TestAppExecutorConstructionAndInput(t *testing.T) {
	if _, err := NewAppExecutor(nil, nil, nil); err == nil {
		t.Fatal("accepted missing dependencies")
	}
	f := newPollFixture(t)
	e, err := NewAppExecutor(appFixtureStore(t, f), appClientFunc(nil), nil)
	if err != nil || e.log == nil {
		t.Fatalf("constructor: %+v %v", e, err)
	}
	for _, input := range []struct {
		work, claims context.Context
		project      string
	}{{nil, context.Background(), testProject}, {context.Background(), nil, testProject}, {context.Background(), context.Background(), ""}} {
		if err := e.ExecuteWithClaimContext(input.work, input.claims, input.project); err == nil {
			t.Fatal("accepted invalid execution")
		}
	}
}

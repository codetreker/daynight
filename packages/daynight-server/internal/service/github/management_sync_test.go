package github

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/requestid"
)

type syncContextStore struct {
	*mgmtStore
	t *testing.T
}

func (s syncContextStore) WriteProject(ctx context.Context, id string, work func(store.ProjectWriteScope) error) (store.Completion, error) {
	s.t.Helper()
	deadline, ok := ctx.Deadline()
	if requestid.From(ctx) != "sync-context" || !ok || time.Until(deadline) <= 0 {
		s.t.Fatal("sync transaction did not receive request context and deadline")
	}
	return s.mgmtStore.WriteProject(ctx, id, work)
}

func TestManagerSyncCarriesContext(t *testing.T) {
	s, _ := mgmtFixture()
	ctx := requestid.With(context.Background(), "sync-context")
	_, err := NewManager(syncContextStore{mgmtStore: s, t: t}, nil, 0).Sync(ctx, mgmtPrincipal, mgmtProject, 1, false)
	if err != nil || s.writes != 1 {
		t.Fatalf("sync: %v", err)
	}
}

func TestManagerSyncOutcomeAndLog(t *testing.T) {
	for _, outcome := range []store.TransactionOutcome{store.TransactionCommitted, store.TransactionUnknown} {
		t.Run(string(outcome), func(t *testing.T) {
			s, remote := mgmtFixture()
			app, installation, repo := int64(13), int64(99), int64(42)
			c := &s.write.github.c
			c.Enabled, c.AppID, c.InstallationID, c.RepositoryID, c.AccessState = true, &app, &installation, &repo, "available"
			s.outcome = outcome
			var logs bytes.Buffer
			manager := NewManager(s, remote, app, slog.New(slog.NewJSONHandler(&logs, nil)))
			ctx := requestid.With(context.Background(), "request-1")
			result, err := manager.Sync(ctx, mgmtPrincipal, mgmtProject, 1, true)
			if s.writes != 1 || remote.discover != 0 || remote.verify != 0 || s.write.github.w == nil || !s.write.github.w.SyncEnabled {
				t.Fatalf("calls/writes: %d %+v", s.writes, s.write.github.w)
			}
			if outcome == store.TransactionUnknown {
				var e *ManagementError
				if !errors.As(err, &e) || e.Code != "github_write_outcome_unknown" {
					t.Fatalf("unknown: %v", err)
				}
			} else if err != nil || !result.Connection.SyncEnabled {
				t.Fatalf("committed: %+v %v", result, err)
			}
			var log map[string]any
			if err := json.Unmarshal(logs.Bytes(), &log); err != nil {
				t.Fatal(err)
			}
			if log["phase"] != "sync_config" || log["request_id"] != "request-1" || log["user_id"] != mgmtPrincipal.UserID || log["project_id"] != mgmtProject || log["sync_enabled"] != true || log["generation"] != float64(1) || log["version"] != float64(2) || log["write_outcome"] != string(outcome) {
				t.Fatalf("log: %v", log)
			}
		})
	}
}

func TestManagerSyncRefusalsAndDisableWithoutService(t *testing.T) {
	s, _ := mgmtFixture()
	manager := NewManager(s, nil, 0, slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil)))
	_, err := manager.Sync(context.Background(), mgmtPrincipal, mgmtProject, 1, true)
	var failure *ManagementError
	if !errors.As(err, &failure) || failure.Code != "github_not_configured" || s.write.github.w != nil {
		t.Fatalf("unavailable: %v", err)
	}
	s.write.github.c.Enabled, s.write.github.c.SyncEnabled = true, true
	result, err := manager.Sync(context.Background(), mgmtPrincipal, mgmtProject, 1, false)
	if err != nil || result.Connection.SyncEnabled || !result.Connection.Enabled || result.ServiceAvailable || s.writes != 2 {
		t.Fatalf("disable: %+v %v", result, err)
	}
}

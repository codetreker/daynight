package service

import (
	"bytes"
	"context"
	"errors"
	"log/slog"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/testdata/testsupport"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/secret"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type appLogCapture struct {
	mu      sync.Mutex
	buf     bytes.Buffer
	changed chan struct{}
}

func (l *appLogCapture) Write(p []byte) (int, error) {
	l.mu.Lock()
	n, err := l.buf.Write(p)
	l.mu.Unlock()
	select {
	case l.changed <- struct{}{}:
	default:
	}
	return n, err
}
func (l *appLogCapture) wait(t *testing.T, fragment string) string {
	t.Helper()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	for {
		l.mu.Lock()
		s := l.buf.String()
		l.mu.Unlock()
		if strings.Contains(s, fragment) {
			return s
		}
		select {
		case <-l.changed:
		case <-deadline.C:
			t.Fatalf("log %q not received: %s", fragment, s)
		}
	}
}

func TestOpenAppWithLoggerReportsMaintenance(t *testing.T) {
	c := appTestConfig(t)
	logs := &appLogCapture{changed: make(chan struct{}, 1)}
	logger := slog.New(slog.NewJSONHandler(logs, nil))
	app, err := OpenAppWithLogger(context.Background(), c, logger)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := app.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	if app.PrivateContent == nil {
		t.Fatal("private content lifecycle missing")
	}
	got := logs.wait(t, "private transfer maintenance")
	if !strings.Contains(got, `"component":"mcptransfer"`) || !strings.Contains(got, `"temp_reserved_bytes":0`) || strings.Contains(got, c.UniAuthAppSecret) {
		t.Fatalf("unsafe or incomplete maintenance record: %s", got)
	}
}

func TestOpenAppReportsBackgroundMaintenanceFailure(t *testing.T) {
	c := appTestConfig(t)
	first, err := OpenApp(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(context.Background(), c.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(context.Background(), `DROP TABLE private_upload_chunks, private_transfers`); err != nil {
		t.Fatal(err)
	}
	logs := &appLogCapture{changed: make(chan struct{}, 1)}
	app, err := OpenAppWithLogger(context.Background(), c, slog.New(slog.NewJSONHandler(logs, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := app.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	got := logs.wait(t, "private transfer maintenance failed")
	if !strings.Contains(got, `"operation":"maintain"`) || strings.Contains(got, c.UniAuthAppSecret) || strings.Contains(got, "private_transfers") {
		t.Fatalf("unsafe failure log: %s", got)
	}
}

func TestOpenAppReportsOAuthMaintenanceFailure(t *testing.T) {
	c := appTestConfig(t)
	first, err := OpenApp(context.Background(), c)
	if err != nil {
		t.Fatal(err)
	}
	if err := first.Close(context.Background()); err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(context.Background(), c.DatabaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(context.Background(), `DROP TABLE oauth_clients`); err != nil {
		t.Fatal(err)
	}
	logs := &appLogCapture{changed: make(chan struct{}, 1)}
	app, err := OpenAppWithLogger(context.Background(), c, slog.New(slog.NewJSONHandler(logs, nil)))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := app.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	got := logs.wait(t, "OAuth maintenance failed")
	if !strings.Contains(got, `"component":"oauth"`) || !strings.Contains(got, `"operation":"maintain"`) || strings.Contains(got, "oauth_clients") {
		t.Fatalf("unsafe OAuth maintenance failure log: %s", got)
	}
}

func TestAppCloseWaitsForPrivateTransferPermit(t *testing.T) {
	tasks, db, project, url, principal := testsupport.TaskService(t)
	task := testsupport.CreateTask(t, tasks, principal, project.ID, "transfer")
	now := time.Now().UTC()
	pat := uuid.NewString()
	if _, err := db.Pool.Exec(context.Background(), `INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at,expires_at) VALUES($1,$2,$3,'test',$4,$5)`, pat, principal.UserID, secret.Hash(uuid.NewString()), now, now.Add(time.Hour)); err != nil {
		t.Fatal(err)
	}
	c := appTestConfig(t)
	c.DatabaseURL = url
	app, err := OpenAppWithLogger(context.Background(), c, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := app.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	actor := mcptransfer.Actor{Principal: model.Principal{Kind: model.PATCredential, UserID: principal.UserID, CredentialID: pat}, AuthorityKind: "pat", AuthorityID: pat}
	binding := mcptransfer.Binding{ID: uuid.NewString(), Direction: "upload", ProjectID: project.ID, TaskID: task.ID, Path: "file", ContentType: "text/plain"}
	if _, _, err := app.PrivateContent.OpenRecord(context.Background(), actor, binding); err != nil {
		t.Fatal(err)
	}
	permit, err := app.PrivateContent.AcquirePermit(context.Background(), actor, binding.ID)
	if err != nil {
		t.Fatal(err)
	}
	defer permit.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	err = app.Close(ctx)
	cancel()
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("close did not wait for permit: %v", err)
	}
	if err := app.Ready(context.Background()); err != nil {
		t.Fatalf("database closed while permit active: %v", err)
	}
	select {
	case <-permit.Context.Done():
	default:
		t.Fatal("shutdown did not cancel permit")
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	ctx, cancel = context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := app.Close(ctx); err != nil {
		t.Fatal(err)
	}
	if err := app.Ready(ctx); err == nil {
		t.Fatal("database remained open after shutdown")
	}
}

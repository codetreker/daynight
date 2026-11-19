//go:build startupshutdown

package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	storagegates "github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/redis"
	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	redisstore "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/redis"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/google/uuid"
)

type transferRecoverySweepLog struct{ completed chan struct{} }

func (w transferRecoverySweepLog) Write(data []byte) (int, error) {
	var entry struct {
		Message string `json:"msg"`
	}
	if json.Unmarshal(data, &entry) == nil && entry.Message == "private transfer maintenance" {
		select {
		case w.completed <- struct{}{}:
		default:
		}
	}
	return len(data), nil
}

func transferRecoveryStorage(t *testing.T, root, redisURL string) *local.Storage {
	t.Helper()
	client, err := redisstore.NewClient(redisURL)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := client.Close(); err != nil {
			t.Error(err)
		}
	})
	files, err := local.NewWithGates(root, storagegates.New(client))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := files.Close(); err != nil {
			t.Error(err)
		}
	})
	return files
}

func TestMCPTransferCrossProcessCrashRecovery(t *testing.T) {
	if mode := os.Getenv("DAYNIGHT_MCPTRANSFER_RECOVERY_HELPER"); mode != "" {
		files := transferRecoveryStorage(t, os.Getenv("DAYNIGHT_MCPTRANSFER_RECOVERY_ROOT"), os.Getenv("DAYNIGHT_MCPTRANSFER_RECOVERY_REDIS"))
		id := os.Getenv("DAYNIGHT_MCPTRANSFER_RECOVERY_ID")
		switch mode {
		case "writer":
			n, err := filestorage.NewTransferNamespace(id)
			if err != nil {
				t.Fatal(err)
			}
			permit, err := files.AcquireGate(t.Context(), filestorage.PrivateGate, id)
			if err != nil {
				t.Fatal(err)
			}
			defer permit.Close()
			writeCtx, cancel := filestorage.GateContext(t.Context(), permit)
			defer cancel()
			if _, err := files.PutTransfer(writeCtx, n, os.Getenv("DAYNIGHT_MCPTRANSFER_RECOVERY_OBJECT"), strings.NewReader("orphan")); err != nil {
				t.Fatal(err)
			}
			fmt.Println("published")
			if _, err := io.Copy(io.Discard, os.Stdin); err != nil {
				t.Fatal(err)
			}
		case "restart":
			db, err := postgres.Open(t.Context(), os.Getenv("DAYNIGHT_MCPTRANSFER_RECOVERY_DATABASE"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			restarted, err := mcptransfer.New(db, files, files, 1<<30, 0)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				if err := restarted.Close(ctx); err != nil {
					t.Error(err)
				}
			}()
			sweepDone := make(chan struct{}, 1)
			restarted.SetLogger(slog.New(slog.NewJSONHandler(transferRecoverySweepLog{completed: sweepDone}, nil)))
			if err := restarted.Start(nil); err != nil {
				t.Fatal(err)
			}
			select {
			case <-sweepDone:
			case <-time.After(10 * time.Second):
				t.Fatal("startup sweep did not finish")
			}
			var state string
			var reserved int64
			if err := db.Pool.QueryRow(t.Context(), `SELECT state,reserved_bytes FROM private_transfers WHERE id=$1`, id).Scan(&state, &reserved); err != nil {
				t.Fatal(err)
			}
			if state != "closed" || reserved != 0 {
				t.Fatalf("startup sweep left %s with %d bytes", state, reserved)
			}
			fmt.Println("recovered")
		default:
			t.Fatalf("unknown recovery helper mode %q", mode)
		}
		return
	}

	redisURL := os.Getenv("DAYNIGHT_TEST_REDIS_URL")
	if redisURL == "" {
		t.Fatal("DAYNIGHT_TEST_REDIS_URL is required for transfer crash recovery")
	}
	values := processAPIEnvironment(t)
	db, err := postgres.Open(t.Context(), values["DAYNIGHT_DATABASE_URL"])
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	user, team, project, task, credential := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	hash := sha256.Sum256([]byte(credential))
	for _, query := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,$1::uuid::text,now(),now())`, []any{user}},
		{`INSERT INTO teams(id,name) VALUES($1,'transfer recovery')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, user}},
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'transfer recovery','https://example.test/recovery')`, []any{project}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
		{`INSERT INTO tasks(id,project_id,title) VALUES($1,$2,'transfer recovery')`, []any{task, project}},
		{`INSERT INTO personal_access_tokens(id,user_id,token_hash,name,created_at) VALUES($1,$2,$3,'test',now())`, []any{credential, user, hash[:]}},
	} {
		if _, err := db.Pool.Exec(t.Context(), query.sql, query.args...); err != nil {
			t.Fatal(err)
		}
	}
	files := transferRecoveryStorage(t, values["DAYNIGHT_STORAGE_ROOT"], redisURL)
	lifecycle, err := mcptransfer.New(db, files, files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := lifecycle.Close(ctx); err != nil {
			t.Error(err)
		}
	}()
	actor := transfer.Actor{Principal: model.Principal{Kind: model.PATCredential, UserID: user, CredentialID: credential}, AuthorityKind: "pat", AuthorityID: credential}
	binding := transfer.Binding{ID: uuid.NewString(), Direction: "upload", ProjectID: project, TaskID: task, Path: "file", ContentType: "text/plain", Parameters: []byte(`{"length":3}`)}
	r, created, err := lifecycle.OpenRecord(t.Context(), actor, binding)
	if err != nil || !created {
		t.Fatalf("open: %+v created=%v error=%v", r, created, err)
	}
	if _, err := lifecycle.Reserve(t.Context(), actor, r.ID, 6); err != nil {
		t.Fatal(err)
	}
	objectID := uuid.NewString()
	ctx, cancel := context.WithTimeout(t.Context(), time.Minute)
	defer cancel()
	command := func(mode string) *exec.Cmd {
		cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestMCPTransferCrossProcessCrashRecovery$")
		cmd.Env = append(os.Environ(),
			"DAYNIGHT_MCPTRANSFER_RECOVERY_HELPER="+mode,
			"DAYNIGHT_MCPTRANSFER_RECOVERY_ROOT="+values["DAYNIGHT_STORAGE_ROOT"],
			"DAYNIGHT_MCPTRANSFER_RECOVERY_DATABASE="+values["DAYNIGHT_DATABASE_URL"],
			"DAYNIGHT_MCPTRANSFER_RECOVERY_REDIS="+redisURL,
			"DAYNIGHT_MCPTRANSFER_RECOVERY_ID="+r.ID,
			"DAYNIGHT_MCPTRANSFER_RECOVERY_OBJECT="+objectID,
		)
		return cmd
	}
	writer := command("writer")
	stdin, err := writer.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	defer stdin.Close()
	logs := &persistenceProcessLog{}
	writer.Stdout, writer.Stderr = logs, logs
	if err := writer.Start(); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() { finished <- writer.Wait() }()
	waited := false
	defer func() {
		if !waited {
			_ = writer.Process.Kill()
			select {
			case <-finished:
			case <-time.After(5 * time.Second):
				t.Error("writer did not exit after kill")
			}
		}
	}()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for !strings.Contains(logs.String(), "published\n") {
		select {
		case err := <-finished:
			waited = true
			t.Fatalf("writer exited before publishing: %v; %s", err, logs.String())
		case <-ctx.Done():
			t.Fatalf("child did not publish in time: %s", logs.String())
		case <-ticker.C:
		}
	}
	if _, err := lifecycle.RequestCleanup(t.Context(), actor, r.ID); err != nil {
		t.Fatal(err)
	}
	if err := lifecycle.Maintain(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cleanup did not wait for the live writer's Redis gate: %v", err)
	}
	pending, err := lifecycle.LookupBound(t.Context(), actor, r.ID)
	if err != nil || pending.State != "cleanup_pending" || pending.ReservedBytes != 6 {
		t.Fatalf("held gate: %+v %v", pending, err)
	}
	n, err := filestorage.NewTransferNamespace(r.ID)
	if err != nil {
		t.Fatal(err)
	}
	object, err := files.OpenTransfer(t.Context(), n, objectID)
	if err != nil {
		t.Fatalf("orphan missing while writer lives: %v", err)
	}
	if err := object.Body.Close(); err != nil {
		t.Fatal(err)
	}
	if err := writer.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-finished:
		waited = true
		if err == nil {
			t.Fatal("writer unexpectedly exited normally")
		}
	case <-ctx.Done():
		t.Fatal("writer did not exit after kill")
	}
	if err := lifecycle.Maintain(ctx); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("cleanup did not wait for the dead writer's unexpired Redis gate: %v", err)
	}
	if err := lifecycle.Close(ctx); err != nil {
		t.Fatal(err)
	}
	// The killed writer could not release its key. Observe its natural expiry
	// through the same gate operation before testing the restart sweep.
	permit, err := files.AcquireGate(ctx, filestorage.PrivateGate, r.ID)
	if err != nil {
		t.Fatalf("dead writer's Redis gate did not expire: %v", err)
	}
	if err := permit.Close(); err != nil {
		t.Fatal(err)
	}
	output, err := command("restart").CombinedOutput()
	if err != nil || !strings.Contains(string(output), "recovered") {
		t.Fatalf("restart process did not recover orphan: %v\n%s", err, output)
	}
	if object, err := files.OpenTransfer(ctx, n, objectID); err == nil {
		object.Body.Close()
		t.Fatal("orphan remains after restart")
	} else if !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("checking the removed orphan failed: %v", err)
	}
}

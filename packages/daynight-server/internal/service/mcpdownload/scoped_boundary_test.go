package mcpdownload

import (
	"context"
	"errors"
	"io"
	"sync/atomic"
	"testing"
	"time"

	attachmentcore "github.com/codetreker/daynight/packages/daynight-server/internal/core/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/attachment"
	"github.com/codetreker/daynight/packages/daynight-server/internal/service/mcptransfer"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
)

type publicationBarrier struct {
	filestorage.TransferStorage
	entered, release chan struct{}
}

type countedOpen struct {
	filestorage.Storage
	opens atomic.Int32
}

func (s *countedOpen) Open(ctx context.Context, bucket, path string) (filestorage.Object, error) {
	s.opens.Add(1)
	return s.Storage.Open(ctx, bucket, path)
}

func TestScopedDownloadWithSingleDatabaseConnection(t *testing.T) {
	f := newAcceptanceFixture(t)
	f.put(t, []byte("private bytes"))
	if _, err := f.db.Pool.Exec(t.Context(), `UPDATE personal_access_tokens SET business_scopes=ARRAY['attachment:read'],scope_version=1 WHERE id=$1`, f.actor.Principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	config := f.db.Pool.Config()
	config.MaxConns, config.MinConns = 1, 0
	pool, err := pgxpool.NewWithConfig(ctx, config)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	db := &postgres.Store{Pool: pool}
	lifecycle, err := mcptransfer.NewScoped(db, f.files, f.files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer lifecycle.Close(context.Background())
	service := New(attachment.NewAttachments(db, db, f.files), lifecycle, f.files)
	in := f.input
	in.Action = "inspect"
	result, err := service.Read(ctx, f.actor, in)
	if err != nil || result["contentIncluded"] != false {
		t.Fatalf("inspect: %v, %v", result, err)
	}
	if pool.Stat().AcquiredConns() != 0 {
		t.Fatal("inspect retained database connection")
	}
}

func TestScopedDownloadRechecksAfterTargetGate(t *testing.T) {
	f := newAcceptanceFixture(t)
	f.put(t, []byte("private bytes"))
	if _, err := f.db.Pool.Exec(t.Context(), `UPDATE personal_access_tokens SET business_scopes=ARRAY['attachment:read'],scope_version=1 WHERE id=$1`, f.actor.Principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	lifecycle, err := mcptransfer.NewScoped(f.db, f.files, f.files, 1<<30, 0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := lifecycle.Close(ctx); err != nil {
			t.Error(err)
		}
	})
	address, err := attachmentcore.NewAddress(f.input.ProjectID, f.input.TaskID, f.input.Path)
	if err != nil {
		t.Fatal(err)
	}
	gate, err := f.files.AcquireGate(t.Context(), filestorage.TargetGate, address.StoragePath)
	if err != nil {
		t.Fatal(err)
	}
	defer gate.Close()
	entered := make(chan struct{})
	files := &countedOpen{Storage: signalGate{Storage: f.files, entered: entered}}
	service := New(attachment.NewAttachments(f.db, f.db, files), lifecycle, f.files)
	in := f.input
	in.Action = "inspect"
	type result struct {
		data map[string]any
		err  error
	}
	results := make(chan result, 1)
	go func() { data, err := service.Read(t.Context(), f.actor, in); results <- result{data, err} }()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("open did not reach target gate")
	}
	if _, err := f.db.Pool.Exec(t.Context(), `UPDATE personal_access_tokens SET business_scopes=ARRAY['attachment:upload'],scope_version=2 WHERE id=$1`, f.actor.Principal.CredentialID); err != nil {
		t.Fatal(err)
	}
	if err := gate.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case got := <-results:
		var fault *model.Fault
		if !errors.As(got.err, &fault) || fault.Code != "insufficient_scope" || got.data != nil || files.opens.Load() != 0 {
			t.Fatalf("result=%v err=%v file opens=%d", got.data, got.err, files.opens.Load())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("open remained blocked")
	}
}

func (b publicationBarrier) PutTransfer(ctx context.Context, ns filestorage.TransferNamespace, id string, source io.Reader) (filestorage.FileInfo, error) {
	info, err := b.TransferStorage.PutTransfer(ctx, ns, id, source)
	if err != nil {
		return info, err
	}
	close(b.entered)
	select {
	case <-b.release:
		return info, nil
	case <-ctx.Done():
		return info, ctx.Err()
	}
}

func TestScopedDownloadRechecksAfterFileIO(t *testing.T) {
	for _, boundary := range []string{"touch", "publish"} {
		t.Run(boundary, func(t *testing.T) {
			f := newAcceptanceFixture(t)
			f.put(t, []byte("private bytes"))
			if _, err := f.db.Pool.Exec(t.Context(), `UPDATE personal_access_tokens SET business_scopes=ARRAY['attachment:read'],scope_version=1 WHERE id=$1`, f.actor.Principal.CredentialID); err != nil {
				t.Fatal(err)
			}
			lifecycle, err := mcptransfer.NewScoped(f.db, f.files, f.files, 1<<30, 0)
			if err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() {
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				if err := lifecycle.Close(ctx); err != nil {
					t.Error(err)
				}
			})
			entered, release := make(chan struct{}), make(chan struct{})
			in := f.input
			in.Action, in.TransferID = "open", uuid.NewString()
			service := New(f.attachments, lifecycle, f.files)
			if boundary == "touch" {
				if _, err := service.Read(t.Context(), f.actor, in); err != nil {
					t.Fatal(err)
				}
				in.Action, in.Offset, in.Format = "chunk", "0", "base64"
				service = New(f.attachments, lifecycle, blockingRange{TransferStorage: f.files, entered: entered, release: release})
			} else {
				service = New(f.attachments, lifecycle, publicationBarrier{TransferStorage: f.files, entered: entered, release: release})
			}
			type result struct {
				data map[string]any
				err  error
			}
			results := make(chan result, 1)
			go func() { data, err := service.Read(t.Context(), f.actor, in); results <- result{data, err} }()
			select {
			case <-entered:
			case <-time.After(5 * time.Second):
				t.Fatal("file operation did not reach barrier")
			}
			if _, err := f.db.Pool.Exec(t.Context(), `UPDATE personal_access_tokens SET business_scopes=ARRAY['attachment:upload'],scope_version=2 WHERE id=$1`, f.actor.Principal.CredentialID); err != nil {
				close(release)
				t.Fatal(err)
			}
			close(release)
			select {
			case got := <-results:
				var fault *model.Fault
				if !errors.As(got.err, &fault) || fault.Code != "insufficient_scope" || got.data != nil {
					t.Fatalf("returned data after narrowing: %#v, %v", got.data, got.err)
				}
			case <-time.After(5 * time.Second):
				t.Fatal("operation did not complete")
			}
			var state string
			var outstanding int64
			if err := f.db.Pool.QueryRow(t.Context(), `SELECT state,outstanding_bytes FROM private_transfers WHERE id=$1`, in.TransferID).Scan(&state, &outstanding); err != nil {
				t.Fatal(err)
			}
			if boundary == "publish" && (state != "preparing" || outstanding != int64(len("private bytes"))) {
				t.Fatalf("publication committed on refusal: state=%s outstanding=%d", state, outstanding)
			}
			if boundary == "touch" && state != "readable" {
				t.Fatalf("readable snapshot changed: %s", state)
			}
		})
	}
}

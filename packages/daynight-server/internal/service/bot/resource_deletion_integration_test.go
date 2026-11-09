package bot_test

import (
	"context"
	"errors"
	"io/fs"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage/local"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	botservice "github.com/codetreker/daynight/packages/daynight-server/internal/service/bot"
	"github.com/google/uuid"
)

func TestBotResourceDeletionClosesAdmissionAndJoinsTheExactLease(t *testing.T) {
	f := newBoundBot(t)
	ctx := t.Context()
	files, e := local.New(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = files.Close() })
	id := f.bound.Session.SessionID
	namespace, e := sessionresource.NewNamespace("", f.p.UserID, id)
	if e != nil {
		t.Fatal(e)
	}
	path, e := namespace.BlobPath(uuid.NewString())
	if e != nil {
		t.Fatal(e)
	}
	if _, e = files.Put(ctx, sessionresource.Bucket, path, strings.NewReader("original private bytes")); e != nil {
		t.Fatal(e)
	}
	lease := uuid.NewString()
	gate, e := files.AcquireGate(ctx, filestorage.MediaLeaseGate, "session-resource-lease/"+lease)
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = gate.Close() })
	_, e = f.db.WriteSession(ctx, func(scope store.SessionScope) error {
		dao := scope.SessionDAO().(store.SessionResourceDAO)
		if _, e := dao.SessionResourceUsage(ctx, id); e != nil {
			return e
		}
		return dao.AcquireSessionResourceLease(ctx, store.SessionResourceLease{SessionID: id, ID: lease, OwnerID: f.p.UserID, Kind: "read"})
	})
	if e != nil {
		t.Fatal(e)
	}
	d := botservice.NewDeletions(f.db, files, f.engine)
	request := store.DeleteBot{Version: f.bound.Bot.Version, DeletionID: uuid.NewString()}
	if _, e = d.DeleteBot(ctx, f.p, f.bound.Bot.ID, request); e != nil {
		t.Fatal(e)
	}
	done := make(chan error, 1)
	go func() {
		_, e := d.CompleteBotDeletion(ctx, f.p, f.bound.Bot.WorkerID, f.bound.Bot.ID, receiptFor(f, request.DeletionID))
		done <- e
	}()
	deadline := time.Now().Add(5 * time.Second)
	for {
		var deleting bool
		e = f.db.Pool.QueryRow(ctx, `SELECT deleting FROM session_resource_state WHERE session_id=$1`, id).Scan(&deleting)
		if e == nil && deleting {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("deletion admission barrier was not committed", e)
		}
		select {
		case e := <-done:
			t.Fatal("cleanup ended before exact reader joined", e)
		case <-time.After(10 * time.Millisecond):
		}
	}
	select {
	case e := <-done:
		t.Fatal("lease age was treated as a stop proof", e)
	default:
	}
	object, e := files.Open(ctx, sessionresource.Bucket, path)
	if e != nil {
		t.Fatal("live reader's original swept early", e)
	}
	_ = object.Body.Close()
	if e = gate.Close(); e != nil {
		t.Fatal(e)
	}
	select {
	case e := <-done:
		if e != nil {
			t.Fatal(e)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("cleanup did not continue after exact lease owner exited")
	}
	if _, e = files.Open(ctx, sessionresource.Bucket, path); !errors.Is(e, fs.ErrNotExist) {
		t.Fatal("final resource sweep missing", e)
	}
	var count int
	if e = f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_sessions WHERE id=$1`, id).Scan(&count); e != nil || count != 0 {
		t.Fatal("rows removed before barrier or retained after final sweep", count, e)
	}
}

type unknownResourceWriter struct{ store.SessionWriter }

func (w unknownResourceWriter) WriteSession(ctx context.Context, fn func(store.SessionScope) error) (store.Completion, error) {
	completion, e := w.SessionWriter.WriteSession(ctx, fn)
	if e == nil {
		completion.Outcome = store.TransactionUnknown
	}
	return completion, e
}
func TestBotResourceDeletionUnknownAdmissionDoesNotSweep(t *testing.T) {
	f := newBoundBot(t)
	ctx := t.Context()
	files, e := local.New(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { _ = files.Close() })
	namespace, e := sessionresource.NewNamespace("", f.p.UserID, f.bound.Session.SessionID)
	if e != nil {
		t.Fatal(e)
	}
	path, _ := namespace.BlobPath(uuid.NewString())
	if _, e = files.Put(ctx, sessionresource.Bucket, path, strings.NewReader("private")); e != nil {
		t.Fatal(e)
	}
	request := store.DeleteBot{Version: f.bound.Bot.Version, DeletionID: uuid.NewString()}
	d := botservice.NewDeletions(f.db, files, f.engine)
	if _, e = d.DeleteBot(ctx, f.p, f.bound.Bot.ID, request); e != nil {
		t.Fatal(e)
	}
	unknown := botservice.NewDeletions(unknownResourceWriter{f.db}, files, f.engine)
	if _, e = unknown.CompleteBotDeletion(ctx, f.p, f.bound.Bot.WorkerID, f.bound.Bot.ID, receiptFor(f, request.DeletionID)); e == nil {
		t.Fatal("unknown write reported completed")
	}
	object, e := files.Open(ctx, sessionresource.Bucket, path)
	if e != nil {
		t.Fatal("unknown transaction swept original", e)
	}
	_ = object.Body.Close()
	var count int
	if e = f.db.Pool.QueryRow(ctx, `SELECT count(*) FROM task_sessions WHERE id=$1`, f.bound.Session.SessionID).Scan(&count); e != nil || count != 1 {
		t.Fatal("unknown cleanup removed Session", count, e)
	}
}

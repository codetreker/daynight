package session

import (
	"bytes"
	"context"
	"errors"
	"io"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/filestorage"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionresource"
	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

type mediaHandleDAO struct {
	*imageRuleDAO
	mediaWrites, touches, sessionWrites, releases int
}

func (d *mediaHandleDAO) SaveSessionMediaRequest(ctx context.Context, row store.SessionMediaRequest) error {
	d.mediaWrites++
	return d.imageRuleDAO.SaveSessionMediaRequest(ctx, row)
}
func (d *mediaHandleDAO) TouchSession(context.Context, string, time.Time) error {
	d.touches++
	return nil
}
func (d *mediaHandleDAO) SaveSession(context.Context, store.SessionRecord) error {
	d.sessionWrites++
	return nil
}
func (d *mediaHandleDAO) ReleaseSessionResourceLease(ctx context.Context, id, lease string) error {
	d.releases++
	return d.imageRuleDAO.ReleaseSessionResourceLease(ctx, id, lease)
}

type mediaHandleStorage struct {
	filestorage.Storage
	outside  func()
	putError error
	afterPut func()
}

func (s mediaHandleStorage) Open(ctx context.Context, b, p string) (filestorage.Object, error) {
	s.outside()
	return s.Storage.Open(ctx, b, p)
}
func (s mediaHandleStorage) Put(ctx context.Context, b, p string, r io.Reader) (filestorage.FileInfo, error) {
	s.outside()
	if s.putError != nil {
		return filestorage.FileInfo{}, s.putError
	}
	info, err := s.Storage.Put(ctx, b, p, r)
	if err == nil && s.afterPut != nil {
		s.afterPut()
	}
	return info, err
}
func (s mediaHandleStorage) AcquireGate(ctx context.Context, d filestorage.GateDomain, key string) (io.Closer, error) {
	s.outside()
	return s.Storage.AcquireGate(ctx, d, key)
}

func TestHandleRejectsMalformedReadResponseBeforeControllerAccess(t *testing.T) {
	f, _, message := readMediaFixture(t, "read_capture")
	message.MediaResult = []byte(`{"data":"*"}`)
	calls := 0
	f.s.controllerRun = func(context.Context, sp.ControllerFence, func(*Access) error) error {
		calls++
		t.Error("malformed payload entered controller access")
		return nil
	}
	out, err := f.s.Handle(t.Context(), message)
	if err == nil || out != nil || calls != 0 || len(f.d.leases) != 0 {
		t.Fatal("malformed read response started controller work", out, err, calls)
	}
}

func TestHandleReadResponseRequiresDurablePublicationAndFinalAdmission(t *testing.T) {
	for _, kind := range []string{"durable receipt", "publication failure", "deletion raced publication", "cancelled after publication"} {
		t.Run(kind, func(t *testing.T) {
			f, row, message := readMediaFixture(t, "read_capture")
			dao := &mediaHandleDAO{imageRuleDAO: f.d}
			ctx, cancel := context.WithCancel(t.Context())
			defer cancel()
			inTransaction := false
			checkOutside := func() {
				t.Helper()
				if inTransaction {
					t.Fatal("media I/O ran inside controller transaction")
				}
			}
			cause := errors.New("durable publication failed")
			files := mediaHandleStorage{Storage: f.files, outside: checkOutside}
			switch kind {
			case "publication failure":
				files.putError = cause
			case "deletion raced publication":
				files.afterPut = func() { f.d.usage.DeleteEpoch++ }
			case "cancelled after publication":
				files.afterPut = cancel
			}
			relay := &Execution{Engine: NewEngine(files)}
			completedScopes := 0
			relay.controllerRun = func(ctx context.Context, fence sp.ControllerFence, work func(*Access) error) error {
				if err := ctx.Err(); err != nil {
					return err
				}
				if fence != f.r.Snapshot.ControllerFence {
					return conflict()
				}
				if inTransaction {
					t.Fatal("controller transaction was nested")
				}
				inTransaction = true
				defer func() { inTransaction = false }()
				op := &Operation{}
				defer op.Close()
				err := work(&Access{tx: &operationTx{dao: dao, op: op}, record: f.r, write: true})
				if err == nil {
					completedScopes++
					op.Finish(store.TransactionCommitted)
				}
				return err
			}
			out, err := relay.Handle(ctx, message)
			if out != nil {
				t.Fatal("image response unexpectedly returned a transport acknowledgement", out)
			}
			saved := f.d.media[row.RequestID]
			if kind == "durable receipt" {
				if err != nil || !saved.Complete || bytes.Contains(saved.Result, []byte(`"data"`)) || dao.mediaWrites != 1 || dao.touches != 1 || dao.sessionWrites != 1 {
					t.Fatal("durable receipt did not pass through Handle completion", err, dao, saved)
				}
				namespace, _ := sessionresource.NewNamespace("", f.p.UserID, row.SessionID)
				path, _ := namespace.ChunkPath(f.spec.UploadID, 0)
				original, e := f.files.Open(t.Context(), sessionresource.Bucket, path)
				if e != nil {
					t.Fatal("completed receipt has no durable original", e)
				}
				raw, e := io.ReadAll(original.Body)
				e = errors.Join(e, original.Body.Close())
				if e != nil || string(raw) != "shared original" {
					t.Fatal("completed receipt published different original", string(raw), e)
				}
			} else {
				if err == nil || saved.Complete || dao.mediaWrites != 0 || dao.touches != 0 || dao.sessionWrites != 0 {
					t.Fatal("failed publication entered receipt completion", kind, err, dao, saved)
				}
				if kind == "publication failure" && !errors.Is(err, cause) {
					t.Fatal("Handle hid storage cause", err)
				}
				if kind == "cancelled after publication" && !errors.Is(err, context.Canceled) {
					t.Fatal("Handle hid cancellation", err)
				}
			}
			if dao.releases != 1 || len(f.d.leases) != 0 || f.d.uploads[f.spec.UploadID].StorageReleased || !bytes.Equal(saved.Body, row.Body) || completedScopes == 0 {
				t.Fatal("Handle leaked its owner, changed identity or returned reservation", dao.releases, len(f.d.leases), completedScopes)
			}
		})
	}
}

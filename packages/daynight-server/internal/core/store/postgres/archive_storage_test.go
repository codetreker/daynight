package postgres

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strings"
	"testing"
	"time"

	transfer "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestArchiveCleanupRequiresExpiration(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	pool := isolatedStore(t).Pool
	at := time.Date(2026, 11, 1, 0, 0, 0, 0, time.UTC)
	_, err := pool.Exec(ctx, `INSERT INTO session_archive_retention(session_id,cleaned_at) VALUES($1,$2)`, queryID(902), at)
	var constraint *pgconn.PgError
	if !errors.As(err, &constraint) || constraint.Code != "23514" {
		t.Fatalf("cleanup without expiration accepted: %v", err)
	}
}

func TestArchiveUploadVersionMigrationAndInventory(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	bootstrapBaseline(t, pool)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 116 })
	if index < 1 {
		t.Fatal("archive upload version migration missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	session, owner, execution := uuid.NewString(), uuid.NewString(), uuid.NewString()
	oldID := uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO task_sessions(id,owner_user_id,registration_id,registration,snapshot,scope,test_execution_id) VALUES($1,$2,$1,'{}','{}','test',$3)`, session, owner, execution); err != nil {
		t.Fatal(err)
	}
	hash := strings.Repeat("a", 64)
	if _, err := pool.Exec(ctx, `INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path) VALUES($1,$2,'history',$3,8,8,'complete','legacy')`, session, oldID, hash); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations[:index+1]); err != nil {
		t.Fatal(err)
	}
	var version int
	var proof []byte
	var successor *string
	var terminal []byte
	if err := pool.QueryRow(ctx, `SELECT upload_version,prefix_proof,successor_file_id::text,terminal_error FROM session_archive_files WHERE session_id=$1 AND file_id=$2`, session, oldID).Scan(&version, &proof, &successor, &terminal); err != nil || version != 1 || proof != nil || successor != nil || terminal != nil {
		t.Fatalf("legacy row changed: version=%d proof=%x successor=%v terminal=%s err=%v", version, proof, successor, terminal, err)
	}
	// The historical migration retains the legacy identity without changing bytes.
}

func TestArchiveSingleStagingMigrationRejectsOldV2AndPreservesV1(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	bootstrapBaseline(t, pool)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 122 })
	if index < 1 {
		t.Fatal("single staging migration missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	session, owner, execution := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := pool.Exec(ctx, `INSERT INTO task_sessions(id,owner_user_id,registration_id,registration,snapshot,scope,test_execution_id) VALUES($1,$2,$1,'{}','{}','test',$3)`, session, owner, execution); err != nil {
		t.Fatal(err)
	}
	oldID, newID := uuid.NewString(), uuid.NewString()
	hash := strings.Repeat("a", 64)
	if _, err := pool.Exec(ctx, `INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,upload_version,prefix_proof) VALUES($1,$2,'history',$4,8,4,'receiving','legacy',1,NULL),($1,$3,'timeline',$4,8,8,'complete','numbered',2,decode(repeat('01',32),'hex'))`, session, oldID, newID, hash); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err == nil {
		t.Fatal("migration accepted historical v2")
	}
	var exists bool
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='session_archive_files' AND column_name='prefix_proof')`).Scan(&exists); err != nil || !exists {
		t.Fatalf("failed migration altered schema: %v", err)
	}
	if _, err := pool.Exec(ctx, `DELETE FROM session_archive_files WHERE session_id=$1 AND file_id=$2`, session, newID); err != nil {
		t.Fatal(err)
	}
	if err := migrate(ctx, pool, schemaMigrations); err != nil {
		t.Fatal(err)
	}
	var version int
	var offset int64
	var state, path string
	if err := pool.QueryRow(ctx, `SELECT upload_version,accepted_offset,state,object_path FROM session_archive_files WHERE session_id=$1 AND file_id=$2`, session, oldID).Scan(&version, &offset, &state, &path); err != nil || version != 1 || offset != 4 || state != "receiving" || path != "legacy" {
		t.Fatalf("legacy row changed: version=%d offset=%d state=%s path=%s error=%v", version, offset, state, path, err)
	}
	if err := pool.QueryRow(ctx, `SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='session_archive_files' AND column_name='prefix_proof')`).Scan(&exists); err != nil || exists {
		t.Fatalf("old proof retained: %v", err)
	}

}

func TestBackupInventoryRejectsInvalidBundleFilePointers(t *testing.T) {
	database := isolatedStore(t)
	ctx := t.Context()
	id, other, owner, execution := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	history, timeline, foreign, missing := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := database.Pool.Exec(ctx, `INSERT INTO task_sessions(id,owner_user_id,registration_id,registration,snapshot,scope,test_execution_id) VALUES($1,$3,$1,'{}','{}','test',$4),($2,$3,$2,'{}','{}','test',$5)`, id, other, owner, execution, uuid.NewString()); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `INSERT INTO session_archive_bundles(session_id,prepare_id,phase,revision,identity,history_id,timeline_id) VALUES($1,$2,'settling',1,'{}',$3,$4)`, id, uuid.NewString(), history, timeline); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path) VALUES($1,$3,'history',$6,1,1,'complete','history'),($1,$4,'timeline',$6,1,1,'complete','timeline'),($2,$5,'history',$6,1,1,'complete','foreign')`, id, other, history, timeline, foreign, strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	for _, version := range []int{1, 2} {
		if _, err := database.Pool.Exec(ctx, `UPDATE session_archive_files SET upload_version=$2 WHERE session_id=$1`, id, version); err != nil {
			t.Fatal(err)
		}
		for _, tc := range []struct {
			name, history, timeline string
			valid                   bool
		}{
			{"both current", history, timeline, true},
			{"history missing", missing, timeline, false},
			{"history other session", foreign, timeline, false},
			{"history wrong purpose", timeline, timeline, false},
			{"timeline missing", history, missing, false},
			{"timeline wrong purpose", history, history, false},
		} {
			t.Run(fmt.Sprintf("v%d/%s", version, tc.name), func(t *testing.T) {
				if _, err := database.Pool.Exec(ctx, `UPDATE session_archive_bundles SET history_id=$2,timeline_id=$3 WHERE session_id=$1`, id, tc.history, tc.timeline); err != nil {
					t.Fatal(err)
				}
				err := database.VerifyStorageInventory(ctx, func(store.StorageInventory) error { return nil })
				if (err == nil) != tc.valid {
					t.Fatalf("valid=%t error=%v", tc.valid, err)
				}
			})
		}
	}
}

func TestBackupInventoryCurrentTimelineIdentityAcrossVersions(t *testing.T) {
	database := isolatedStore(t)
	ctx := t.Context()
	session, owner, execution := uuid.NewString(), uuid.NewString(), uuid.NewString()
	history, timeline := uuid.NewString(), uuid.NewString()
	if _, err := database.Pool.Exec(ctx, `INSERT INTO task_sessions(id,owner_user_id,registration_id,registration,snapshot,scope,test_execution_id) VALUES($1,$2,$1,'{}','{}','test',$3)`, session, owner, execution); err != nil {
		t.Fatal(err)
	}
	if _, err := database.Pool.Exec(ctx, `INSERT INTO session_archive_bundles(session_id,prepare_id,phase,revision,identity,history_id,timeline_id) VALUES($1,$2,'committed',2,'{}',$3,$4)`, session, uuid.NewString(), history, timeline); err != nil {
		t.Fatal(err)
	}
	historyHash, timelineHash := strings.Repeat("a", 64), strings.Repeat("b", 64)
	if _, err := database.Pool.Exec(ctx, `INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,timeline_revision,upload_version) VALUES($1,$2,'history',$4,10,10,'complete','history',2,2),($1,$3,'timeline',$5,12,12,'complete','timeline/current',2,1)`, session, history, timeline, historyHash, timelineHash); err != nil {
		t.Fatal(err)
	}
	for _, version := range []int{1, 2} {
		t.Run(fmt.Sprintf("timeline v%d", version), func(t *testing.T) {
			if _, err := database.Pool.Exec(ctx, `UPDATE session_archive_files SET upload_version=$3 WHERE session_id=$1 AND file_id=$2`, session, timeline, version); err != nil {
				t.Fatal(err)
			}
			seen := false
			if err := database.VerifyStorageInventory(ctx, func(v store.StorageInventory) error {
				if v.SessionID != session {
					return nil
				}
				seen = true
				got := v.ArchiveTimeline
				if got == nil || got.FileID != timeline || got.State != "complete" || got.Path != "timeline/current" || got.SHA256 != timelineHash || got.UploadVersion != version || got.ByteLength != 12 || got.AcceptedOffset != 12 || got.TimelineRevision != 2 {
					t.Fatalf("current timeline identity: %+v", got)
				}
				return nil
			}); err != nil {
				t.Fatal(err)
			}
			if !seen {
				t.Fatal("missing owning Session")
			}
		})
	}
	if _, err := database.Pool.Exec(ctx, `UPDATE session_archive_bundles SET timeline_id=NULL WHERE session_id=$1`, session); err != nil {
		t.Fatal(err)
	}
	if err := database.VerifyStorageInventory(ctx, func(v store.StorageInventory) error {
		if v.SessionID == session && v.ArchiveTimeline != nil {
			t.Fatalf("unexpected timeline: %+v", v.ArchiveTimeline)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestUploadChunkReceiptsAtomicWithReservationAndState(t *testing.T) {
	parallelRootDatabaseTest(t)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	db := isolatedStore(t)
	r := transferRecord(uuid.NewString(), time.Now().UTC())
	_, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var e error
		r, _, e = transfer.Create(ctx, d, r)
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var e error
		r, e = transfer.Reserve(ctx, d, r.ID, 10, 100)
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	chunk := model.UploadChunk{TransferID: r.ID, ChunkID: uuid.NewString(), ObjectID: uuid.NewString(), Offset: 0, Size: 10, SHA256: strings.Repeat("a", 64)}
	rollback := errors.New("force receipt rollback")
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		if e := d.InsertUploadChunk(ctx, chunk); e != nil {
			return e
		}
		if _, e := transfer.ConsumeReservation(ctx, d, r.ID, chunk.Size, r.Version); e != nil {
			return e
		}
		return rollback
	})
	if !errors.Is(err, rollback) {
		t.Fatalf("rollback: %v (cause: %v; database: %v)", err, errors.Unwrap(err), errors.Unwrap(errors.Unwrap(err)))
	}
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		current, e := d.Get(ctx, r.ID)
		if e != nil {
			return e
		}
		if current.Version != r.Version || current.OutstandingBytes != 10 {
			t.Fatalf("reservation changed after rollback: %+v", current)
		}
		if _, e = d.UploadChunk(ctx, r.ID, chunk.ChunkID); !errors.Is(e, model.ErrNotFound) {
			t.Fatalf("receipt survived rollback: %v", e)
		}
		if e = d.InsertUploadChunk(ctx, chunk); e != nil {
			return e
		}
		current, e = transfer.ConsumeReservation(ctx, d, r.ID, chunk.Size, current.Version)
		if e != nil {
			return e
		}
		current.Data = []byte(`{"nextOffset":"10"}`)
		r, e = transfer.Update(ctx, d, current, current.Version)
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	if r.OutstandingBytes != 0 || r.ReservedBytes != 10 {
		t.Fatalf("wrong accounting: %+v", r)
	}
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		current, e := d.Get(ctx, r.ID)
		if e != nil {
			return e
		}
		var progress struct {
			NextOffset string `json:"nextOffset"`
		}
		if err := json.Unmarshal(current.Data, &progress); err != nil {
			return err
		}
		if progress.NextOffset != "10" || current.Version != r.Version || current.ReservedBytes != 10 || current.OutstandingBytes != 0 {
			t.Fatalf("persisted chunk progress: %+v", current)
		}
		byID, e := d.UploadChunk(ctx, r.ID, chunk.ChunkID)
		if e != nil || byID != chunk {
			t.Fatalf("receipt by ID: %+v, %v", byID, e)
		}
		byOffset, e := d.UploadChunkAt(ctx, r.ID, 0)
		if e != nil || byOffset != chunk {
			t.Fatalf("receipt by offset: %+v, %v", byOffset, e)
		}
		_, e = d.UploadChunkAt(ctx, r.ID, 10)
		if !errors.Is(e, model.ErrNotFound) {
			t.Fatalf("unexpected next receipt: %v", e)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	for _, duplicate := range []model.UploadChunk{
		chunk,
		{TransferID: r.ID, ChunkID: uuid.NewString(), ObjectID: uuid.NewString(), Offset: 0, Size: 10, SHA256: chunk.SHA256},
		{TransferID: r.ID, ChunkID: uuid.NewString(), ObjectID: chunk.ObjectID, Offset: 10, Size: 10, SHA256: chunk.SHA256},
	} {
		_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error { return d.InsertUploadChunk(ctx, duplicate) })
		var fault *model.Fault
		if !errors.As(err, &fault) || fault.Code != "transfer_conflict" {
			t.Fatalf("duplicate receipt: %v", err)
		}
	}
	for _, bad := range []model.UploadChunk{
		{TransferID: r.ID, ChunkID: uuid.NewString(), ObjectID: uuid.NewString(), Size: 0, SHA256: chunk.SHA256},
		{TransferID: r.ID, ChunkID: uuid.NewString(), ObjectID: uuid.NewString(), Offset: math.MaxInt64, Size: 1, SHA256: chunk.SHA256},
		{TransferID: r.ID, ChunkID: uuid.NewString(), ObjectID: uuid.NewString(), Size: 1, SHA256: strings.Repeat("A", 64)},
	} {
		_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error { return d.InsertUploadChunk(ctx, bad) })
		if err == nil {
			t.Fatalf("database accepted invalid receipt: %+v", bad)
		}
	}
	retainUntil := time.Now().UTC().Add(time.Hour)
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		current, e := d.Get(ctx, r.ID)
		if e != nil {
			return e
		}
		current.State = "cleanup_pending"
		current, e = transfer.Update(ctx, d, current, current.Version)
		if e != nil {
			return e
		}
		_, e = transfer.Close(ctx, d, r.ID, current.Version, retainUntil)
		return e
	})
	if err != nil {
		t.Fatal(err)
	}
	_, err = db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		if _, e := d.UploadChunk(ctx, r.ID, chunk.ChunkID); e != nil {
			return e
		}
		pruned, e := transfer.Prune(ctx, d, retainUntil.Add(time.Second), 100)
		if e != nil || pruned != 1 {
			t.Fatalf("prune: %d, %v", pruned, e)
		}
		if _, e = d.UploadChunk(ctx, r.ID, chunk.ChunkID); !errors.Is(e, model.ErrNotFound) {
			t.Fatalf("receipt survived pruning: %v", e)
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

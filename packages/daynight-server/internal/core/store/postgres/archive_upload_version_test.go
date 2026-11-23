package postgres

import (
	"bytes"
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestArchiveUploadVersionMigrationAndInventory(t *testing.T) {
	ctx := t.Context()
	pool := emptyPool(t)
	index := slices.IndexFunc(schemaMigrations, func(m migration) bool { return m.version == 116 })
	if index < 1 {
		t.Fatal("archive upload version migration missing")
	}
	if err := migrate(ctx, pool, schemaMigrations[:index]); err != nil {
		t.Fatal(err)
	}
	session, owner, execution := uuid.NewString(), uuid.NewString(), uuid.NewString()
	oldID, newID, retiredID, prepare := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
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
	if _, err := pool.Exec(ctx, `INSERT INTO session_archive_bundles(session_id,prepare_id,phase,revision,identity,ledger,history_id) VALUES($1,$2,'settling',7,'{}','{"historyId":"current"}',$3)`, session, prepare, newID); err != nil {
		t.Fatal(err)
	}
	proof = bytes.Repeat([]byte{7}, 32)
	if _, err := pool.Exec(ctx, `INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,resource,timeline_revision,upload_version,prefix_proof) VALUES($1,$2,'history',$3,9,0,'receiving','new','{"source":"fixed"}',7,2,$4)`, session, newID, hash, proof); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,upload_version,prefix_proof,successor_file_id,terminal_error) VALUES($1,$2,'timeline',$3,9,9,'failed','retired',2,$4,$5,'{"code":"staging_corrupt"}')`, session, retiredID, hash, proof, newID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO session_archive_chunks(session_id,file_id,chunk_offset,byte_length,sha256,object_path) VALUES($1,$2,0,8,$3,'legacy/chunk'),($1,$4,0,9,$3,'must-not-require')`, session, oldID, hash, retiredID); err != nil {
		t.Fatal(err)
	}
	database := &Store{Pool: pool}
	if err := database.VerifyStorageInventory(ctx, func(v store.StorageInventory) error {
		if v.ArchiveBundle == nil || v.ArchiveBundle.HistoryID != newID || v.ArchiveBundle.Phase != "settling" || v.ArchiveBundle.Revision != 7 || len(v.ArchiveFilesV2) != 2 || len(v.Objects) != 1 || v.Objects[0].Path != "legacy/chunk" {
			t.Fatalf("inventory omitted or mixed versions: %+v", v)
		}
		for _, f := range v.ArchiveFilesV2 {
			if f.UploadVersion != 2 || !bytes.Equal(f.PrefixProof, proof) {
				t.Fatalf("incorrect v2 row: %+v", f)
			}
			if f.FileID == retiredID && (f.SuccessorFileID != newID || string(f.TerminalError) == "") {
				t.Fatalf("terminal receipt omitted: %+v", f)
			}
			if f.FileID == newID && (f.AcceptedOffset != 0 || f.TimelineRevision != 7 || string(f.Resource) == "") {
				t.Fatalf("receiving identity omitted: %+v", f)
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
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
	if _, err := database.Pool.Exec(ctx, `INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,timeline_revision,upload_version,prefix_proof) VALUES($1,$2,'history',$4,10,10,'complete','history',2,2,decode(repeat('00',32),'hex')),($1,$3,'timeline',$5,12,12,'complete','timeline/current',2,1,NULL)`, session, history, timeline, historyHash, timelineHash); err != nil {
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

package postgres

import (
	"reflect"
	"strings"
	"testing"
	"time"

	transfercore "github.com/codetreker/daynight/packages/daynight-server/internal/core/mcptransfer"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/sessionarchive"
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestOfflineStorageTransitionPreservesV1ActiveHistoryCheckpoint(t *testing.T) {
	db := isolatedStore(t)
	ctx := t.Context()
	id, project, owner, task := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	completed, replacement := uuid.NewString(), uuid.NewString()
	namespace, err := sessionarchive.NewNamespace(sessionarchive.Projects, project, id)
	if err != nil {
		t.Fatal(err)
	}
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$1,$4,$1,'{}','{}')`, id, project, task, owner)
	exec(`INSERT INTO session_archive_bundles(session_id,prepare_id,phase,revision,identity,ledger,history_id) VALUES($1,$1,'active',2,$2,$3,$4)`, id, `{"controllerId":"`+uuid.NewString()+`"}`, `{"HistoryID":"`+completed+`","SourceThrough":"7","Entries":[],"Resources":[]}`, replacement)
	for _, row := range []struct {
		file, state      string
		offset, revision int64
	}{{completed, "complete", 7, 1}, {replacement, "receiving", 3, 2}} {
		exec(`INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,upload_version,timeline_revision,staging_released) VALUES($1,$2,'history',$3,7,$4,$5,$6,1,$7,$8)`, id, row.file, strings.Repeat("a", 64), row.offset, row.state, namespace.Directory()+"/files/"+row.file, row.revision, row.state == "complete")
	}
	exec(`INSERT INTO session_archive_chunks(session_id,file_id,chunk_offset,byte_length,sha256,object_path) VALUES($1,$2,0,3,$3,$4)`, id, replacement, strings.Repeat("b", 64), namespace.Directory()+"/files/"+replacement+"/chunks/0")
	readRetained := func() (bundle, receipt []byte) {
		t.Helper()
		if err := db.Pool.QueryRow(ctx, `SELECT to_jsonb(b)-'history_id' FROM session_archive_bundles b WHERE session_id=$1`, id).Scan(&bundle); err != nil {
			t.Fatal(err)
		}
		if err := db.Pool.QueryRow(ctx, `SELECT to_jsonb(f) FROM session_archive_files f WHERE session_id=$1 AND file_id=$2`, id, completed).Scan(&receipt); err != nil {
			t.Fatal(err)
		}
		return
	}
	bundleBefore, receiptBefore := readRetained()
	state, err := db.ReadOfflineStorageState(ctx)
	if err != nil || len(state.ArchiveFiles) != 1 || state.ArchiveFiles[0].File.UploadVersion != 1 || state.ArchiveFiles[0].File.AcceptedOffset != 3 || state.ArchiveFiles[0].Bundle.Phase != "active" || state.ArchiveFiles[0].Bundle.Revision != 2 || state.ArchiveFiles[0].Bundle.HistoryID != replacement {
		t.Fatal(state, err)
	}
	if err := sessioncore.ValidateOfflineStorageState(state); err != nil {
		t.Fatal("valid persisted v1 active registration rejected", err)
	}
	completion, err := db.ApplyOfflineStorageTransition(ctx, state, nil, nil, nil)
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatal(completion, err)
	}
	bundleAfter, receiptAfter := readRetained()
	if !reflect.DeepEqual(bundleBefore, bundleAfter) || !reflect.DeepEqual(receiptBefore, receiptAfter) {
		t.Fatal("transition changed active phase, identity, revision, completed ledger or receipt")
	}
	var history *string
	var receiving, chunks int
	if err := db.Pool.QueryRow(ctx, `SELECT history_id::text,(SELECT count(*) FROM session_archive_files WHERE session_id=$1 AND file_id=$2),(SELECT count(*) FROM session_archive_chunks WHERE session_id=$1 AND file_id=$2) FROM session_archive_bundles WHERE session_id=$1`, id, replacement).Scan(&history, &receiving, &chunks); err != nil || history != nil || receiving != 0 || chunks != 0 {
		t.Fatal("revoked current registration or chunks survived", history, receiving, chunks, err)
	}
	after, err := db.ReadOfflineStorageState(ctx)
	if err != nil || !reflect.DeepEqual(after, store.OfflineStorageState{}) {
		t.Fatal(after, err)
	}
}

func TestOfflineStorageTransitionPreservesTerminalReceiptsAndRejectsChangedCut(t *testing.T) {
	db := isolatedStore(t)
	ctx := t.Context()
	id, project, owner, task := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	old, replacement, resource, predecessor := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$1,$4,$1,'{}','{}')`, id, project, task, owner)
	exec(`INSERT INTO session_archive_bundles(session_id,prepare_id,phase,revision,identity,ledger,history_id) VALUES($1,$1,'settling',7,'{}',$2,$3)`, id, `{"HistoryID":"`+old+`"}`, replacement)
	for _, row := range []struct{ file, purpose, state string }{{old, "history", "complete"}, {replacement, "history", "receiving"}, {resource, "resource", "complete"}} {
		exec(`INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,upload_version,timeline_revision) VALUES($1,$2::uuid,$3,$4,7,$5,$6,$2::text,2,7)`, id, row.file, row.purpose, strings.Repeat("a", 64), map[string]int{"complete": 7, "receiving": 0}[row.state], row.state)
	}
	exec(`INSERT INTO session_archive_chunks(session_id,file_id,chunk_offset,byte_length,sha256,object_path) VALUES($1,$2,0,7,$3,'discard')`, id, replacement, strings.Repeat("a", 64))
	exec(`INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,upload_version,timeline_revision,successor_file_id,terminal_error) VALUES($1,$2::uuid,'history',$3,7,3,'failed',$2::text,2,7,$4,'{"code":"staging_corrupt","message":"corrupt"}')`, id, predecessor, strings.Repeat("a", 64), replacement)
	uploadID, blobID := uuid.NewString(), uuid.NewString()
	exec(`INSERT INTO session_image_uploads(session_id,upload_id,actor_id,image_id,blob_id,spec,receipt,expires_at) VALUES($1,$2,$3,$2,$4,$5,$6,now()+interval '1 hour')`, id, uploadID, owner, blobID, `{"uploadId":"`+uploadID+`"}`, `{"uploadId":"`+uploadID+`","state":"receiving","acceptedOffset":"1048576"}`)
	var ticket model.PrivateTransfer
	_, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		var err error
		ticket, _, err = transfercore.Create(ctx, d, transferRecord(owner, time.Now().UTC().Truncate(time.Microsecond)))
		if err == nil {
			ticket, err = transfercore.Reserve(ctx, d, ticket.ID, 1024, 4096)
		}
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	state, err := db.ReadOfflineStorageState(ctx)
	if err != nil || len(state.ArchiveFiles) != 1 || len(state.Uploads) != 1 || len(state.Transfers) != 1 {
		t.Fatal(state, err)
	}
	upload, err := sessioncore.ReleaseOfflineImageUpload(state.Uploads[0].Upload)
	if err != nil {
		t.Fatal(err)
	}
	closed, err := transfercore.CloseOfflineTransfer(state.Transfers[0], time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	revocations, err := sessioncore.PlanOfflineArchiveRevocations(state)
	if err != nil || len(revocations) != 1 {
		t.Fatal(revocations, err)
	}
	exec(`UPDATE session_archive_files SET byte_length=8 WHERE session_id=$1 AND file_id=$2`, id, replacement)
	completion, err := db.ApplyOfflineStorageTransition(ctx, state, []store.SessionUploadRecord{upload}, []model.PrivateTransfer{closed}, revocations)
	if err == nil || completion.Outcome != store.TransactionNotCommitted {
		t.Fatal("changed cut accepted", completion, err)
	}
	exec(`UPDATE session_archive_files SET byte_length=7 WHERE session_id=$1 AND file_id=$2`, id, replacement)
	exec(`UPDATE session_archive_files SET terminal_error='{"code":"staging_corrupt","message":"changed"}' WHERE session_id=$1 AND file_id=$2`, id, predecessor)
	completion, err = db.ApplyOfflineStorageTransition(ctx, state, []store.SessionUploadRecord{upload}, []model.PrivateTransfer{closed}, revocations)
	if err == nil || completion.Outcome != store.TransactionNotCommitted {
		t.Fatal("changed predecessor accepted", completion, err)
	}
	exec(`UPDATE session_archive_files SET terminal_error='{"code":"staging_corrupt","message":"corrupt"}' WHERE session_id=$1 AND file_id=$2`, id, predecessor)
	completion, err = db.ApplyOfflineStorageTransition(ctx, state, []store.SessionUploadRecord{upload}, []model.PrivateTransfer{closed}, revocations)
	if err != nil || completion.Outcome != store.TransactionCommitted {
		t.Fatal(completion, err)
	}
	after, err := db.ReadOfflineStorageState(ctx)
	if err != nil || !reflect.DeepEqual(after, store.OfflineStorageState{}) {
		t.Fatal(after, err)
	}
	var revision int64
	var history *string
	var ledger []byte
	if err = db.Pool.QueryRow(ctx, `SELECT revision,history_id::text,ledger FROM session_archive_bundles WHERE session_id=$1`, id).Scan(&revision, &history, &ledger); err != nil || revision != 7 || history != nil || !strings.Contains(string(ledger), old) {
		t.Fatal(revision, history, string(ledger), err)
	}
	var completed, chunks int
	if err = db.Pool.QueryRow(ctx, `SELECT (SELECT count(*) FROM session_archive_files WHERE session_id=$1 AND state='complete'),(SELECT count(*) FROM session_archive_chunks WHERE session_id=$1)`, id).Scan(&completed, &chunks); err != nil || completed != 2 || chunks != 0 {
		t.Fatal(completed, chunks, err)
	}
	var reserved int64
	if err = db.Pool.QueryRow(ctx, `SELECT reserved_bytes FROM private_transfer_ledger WHERE singleton`).Scan(&reserved); err != nil || reserved != 0 {
		t.Fatal(reserved, err)
	}
	var terminal []byte
	var successor string
	if err = db.Pool.QueryRow(ctx, `SELECT terminal_error,successor_file_id::text FROM session_archive_files WHERE session_id=$1 AND file_id=$2`, id, predecessor).Scan(&terminal, &successor); err != nil || successor != replacement || !strings.Contains(string(terminal), "offlineSuccessorRevocation") || !strings.Contains(string(terminal), "staging_corrupt") {
		t.Fatal(string(terminal), successor, err)
	}
}

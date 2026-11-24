package postgres

import (
	"context"
	"errors"
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

func offlineFailureFixture(t *testing.T) (*Store, store.OfflineStorageState, []store.SessionUploadRecord, []model.PrivateTransfer, []store.OfflineArchiveRevocation) {
	t.Helper()
	db := isolatedStore(t)
	ctx := t.Context()
	id, owner, project, file, previous, upload := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	exec := func(query string, args ...any) {
		t.Helper()
		if _, err := db.Pool.Exec(ctx, query, args...); err != nil {
			t.Fatal(err)
		}
	}
	exec(`INSERT INTO task_sessions(id,project_id,task_id,claim_id,owner_user_id,registration_id,registration,snapshot) VALUES($1,$2,$3,$1,$4,$1,'{}','{}')`, id, project, uuid.NewString(), owner)
	exec(`INSERT INTO session_archive_bundles(session_id,prepare_id,phase,revision,identity,history_id) VALUES($1,$1,'settling',2,'{}',$2)`, id, file)
	exec(`INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,upload_version,timeline_revision) VALUES($1,$2,'history',$3,7,0,'receiving','target',2,2)`, id, file, strings.Repeat("a", 64))
	exec(`INSERT INTO session_archive_files(session_id,file_id,purpose,sha256,byte_length,accepted_offset,state,object_path,upload_version,timeline_revision,successor_file_id,terminal_error) VALUES($1,$2,'history',$3,7,3,'failed','previous',2,2,$4,'{"code":"staging_corrupt","message":"corrupt"}')`, id, previous, strings.Repeat("a", 64), file)
	exec(`INSERT INTO session_archive_chunks(session_id,file_id,chunk_offset,byte_length,sha256,object_path) VALUES($1,$2,0,7,$3,'chunk')`, id, file, strings.Repeat("a", 64))
	exec(`INSERT INTO session_image_uploads(session_id,upload_id,actor_id,image_id,blob_id,spec,receipt,expires_at) VALUES($1,$2,$3,$2,$4,$5,'{"state":"receiving","acceptedOffset":"7"}',now()+interval '1 hour')`, id, upload, owner, uuid.NewString(), `{"uploadId":"`+upload+`"}`)
	exec(`INSERT INTO session_image_chunks(session_id,upload_id,chunk_offset,byte_length,sha256,blob_path) VALUES($1,$2,0,7,$3,'image-chunk')`, id, upload, strings.Repeat("a", 64))
	_, err := db.WritePrivateTransfer(ctx, func(d store.PrivateTransferDAO) error {
		record, _, err := transfercore.Create(ctx, d, transferRecord(owner, time.Now().UTC().Truncate(time.Microsecond)))
		if err != nil {
			return err
		}
		_, err = transfercore.Reserve(ctx, d, record.ID, 1024, 4096)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	state, err := db.ReadOfflineStorageState(ctx)
	if err != nil {
		t.Fatal(err)
	}
	released, err := sessioncore.ReleaseOfflineImageUpload(state.Uploads[0].Upload)
	if err != nil {
		t.Fatal(err)
	}
	closed, err := transfercore.CloseOfflineTransfer(state.Transfers[0], time.Now().UTC())
	if err != nil {
		t.Fatal(err)
	}
	revocations, err := sessioncore.PlanOfflineArchiveRevocations(state)
	if err != nil {
		t.Fatal(err)
	}
	return db, state, []store.SessionUploadRecord{released}, []model.PrivateTransfer{closed}, revocations
}

func TestOfflineReaderRejectsDamagedRestoreWithoutRepairingMetadata(t *testing.T) {
	db, expected, _, _, _ := offlineFailureFixture(t)
	cases := []struct {
		name string
		sql  []string
	}{
		{"missing archive table", []string{`ALTER TABLE session_archive_files RENAME TO damaged_archive_files`}},
		{"null archive length", []string{`ALTER TABLE session_archive_files ALTER COLUMN byte_length DROP NOT NULL`, `UPDATE session_archive_files SET byte_length=NULL WHERE state='receiving'`}},
		{"missing bundle table", []string{`ALTER TABLE session_archive_bundles RENAME TO damaged_archive_bundles`}},
		{"missing archive chunks", []string{`ALTER TABLE session_archive_chunks RENAME TO damaged_archive_chunks`}},
		{"null predecessor length", []string{`ALTER TABLE session_archive_files ALTER COLUMN byte_length DROP NOT NULL`, `UPDATE session_archive_files SET byte_length=NULL WHERE state='failed'`}},
		{"missing image uploads", []string{`ALTER TABLE session_image_uploads RENAME TO damaged_image_uploads`}},
		{"null image actor", []string{`ALTER TABLE session_image_uploads ALTER COLUMN actor_id DROP NOT NULL`, `UPDATE session_image_uploads SET actor_id=NULL`}},
		{"unreadable image spec", []string{`UPDATE session_image_uploads SET spec='"invalid"'`}},
		{"unreadable image receipt", []string{`UPDATE session_image_uploads SET receipt='{"state":"receiving","acceptedOffset":7}'`}},
		{"missing image chunks", []string{`ALTER TABLE session_image_chunks RENAME TO damaged_image_chunks`}},
		{"missing private tickets", []string{`ALTER TABLE private_transfers RENAME TO damaged_private_transfers`}},
		{"null private ticket owner", []string{`ALTER TABLE private_transfers ALTER COLUMN user_id DROP NOT NULL`, `UPDATE private_transfers SET user_id=NULL`}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			tx, err := db.Pool.Begin(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.WithoutCancel(t.Context()))
			for _, query := range test.sql {
				if _, err := tx.Exec(t.Context(), query); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := readOfflineStorageState(t.Context(), tx); err == nil {
				t.Fatal("damaged restore accepted")
			}
			if err := tx.Rollback(t.Context()); err != nil {
				t.Fatal(err)
			}
			after, err := db.ReadOfflineStorageState(t.Context())
			if err != nil || !reflect.DeepEqual(after, expected) {
				t.Fatal("reader changed original metadata", after, err)
			}
		})
	}
	t.Run("missing bundle remains an observed fact", func(t *testing.T) {
		tx, err := db.Pool.Begin(t.Context())
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(context.WithoutCancel(t.Context()))
		if _, err := tx.Exec(t.Context(), `DELETE FROM session_archive_bundles`); err != nil {
			t.Fatal(err)
		}
		actual, err := readOfflineStorageState(t.Context(), tx)
		if err != nil || len(actual.ArchiveFiles) != 1 || actual.ArchiveFiles[0].Bundle != nil {
			t.Fatal(actual, err)
		}
	})
}

func TestOfflineCancellationRefusesReadsAndWrites(t *testing.T) {
	db, expected, uploads, tickets, revocations := offlineFailureFixture(t)
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := db.ReadOfflineStorageState(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	completion, err := db.ApplyOfflineStorageTransition(ctx, expected, uploads, tickets, revocations)
	if !errors.Is(err, context.Canceled) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatal(completion, err)
	}
	after, err := db.ReadOfflineStorageState(t.Context())
	if err != nil || !reflect.DeepEqual(after, expected) {
		t.Fatal("cancelled operation changed metadata", after, err)
	}
}

func TestOfflineTransitionIdentityRefusalsRollBackEarlierChanges(t *testing.T) {
	db, expected, uploads, tickets, revocations := offlineFailureFixture(t)
	cases := []struct {
		name   string
		change func([]store.SessionUploadRecord, []model.PrivateTransfer, []store.OfflineArchiveRevocation)
	}{
		{"image offset changed", func(u []store.SessionUploadRecord, _ []model.PrivateTransfer, _ []store.OfflineArchiveRevocation) {
			u[0].Receipt.AcceptedOffset = "0"
		}},
		{"ticket operation changed", func(_ []store.SessionUploadRecord, t []model.PrivateTransfer, _ []store.OfflineArchiveRevocation) {
			t[0].Data = []byte(`{"operationId":"changed"}`)
		}},
		{"missing ticket cleanup barrier", func(_ []store.SessionUploadRecord, t []model.PrivateTransfer, _ []store.OfflineArchiveRevocation) {
			t[0].CleanupFromState = nil
		}},
		{"revocation binds another predecessor", func(_ []store.SessionUploadRecord, _ []model.PrivateTransfer, r []store.OfflineArchiveRevocation) {
			r[0].PredecessorFileID = uuid.NewString()
		}},
		{"unreadable revocation proof", func(_ []store.SessionUploadRecord, _ []model.PrivateTransfer, r []store.OfflineArchiveRevocation) {
			r[0].TerminalError = []byte(`{`)
		}},
	}
	for _, test := range cases {
		t.Run(test.name, func(t *testing.T) {
			u, ts, r := append([]store.SessionUploadRecord(nil), uploads...), append([]model.PrivateTransfer(nil), tickets...), append([]store.OfflineArchiveRevocation(nil), revocations...)
			test.change(u, ts, r)
			completion, err := db.ApplyOfflineStorageTransition(t.Context(), expected, u, ts, r)
			if err == nil || completion.Outcome != store.TransactionNotCommitted {
				t.Fatal("invalid transition committed", completion, err)
			}
			after, err := db.ReadOfflineStorageState(t.Context())
			if err != nil || !reflect.DeepEqual(after, expected) {
				t.Fatal("refused transition changed earlier archive or image state", after, err)
			}
		})
	}
	t.Run("missing revocation plan", func(t *testing.T) {
		completion, err := db.ApplyOfflineStorageTransition(t.Context(), expected, uploads, tickets, nil)
		if err == nil || completion.Outcome != store.TransactionNotCommitted {
			t.Fatal(completion, err)
		}
	})
	t.Run("ledger underflow", func(t *testing.T) {
		if _, err := db.Pool.Exec(t.Context(), `UPDATE private_transfer_ledger SET reserved_bytes=0,outstanding_bytes=0`); err != nil {
			t.Fatal(err)
		}
		defer db.Pool.Exec(context.WithoutCancel(t.Context()), `UPDATE private_transfer_ledger SET reserved_bytes=1024,outstanding_bytes=1024`)
		completion, err := db.ApplyOfflineStorageTransition(t.Context(), expected, uploads, tickets, revocations)
		if err == nil || completion.Outcome != store.TransactionNotCommitted {
			t.Fatal(completion, err)
		}
		after, err := db.ReadOfflineStorageState(t.Context())
		if err != nil || !reflect.DeepEqual(after, expected) {
			t.Fatal("underflow closed tickets or revoked archives", after, err)
		}
	})
}

func TestOfflineStorageMigrationInventory(t *testing.T) {
	db := isolatedStore(t)
	if !t.Run("all attachment owners", func(t *testing.T) {
		ctx := t.Context()
		project, task := uuid.NewString(), uuid.NewString()
		for _, path := range []string{"Report.md", "report.md", "nested/中文.txt"} {
			if _, err := db.Pool.Exec(ctx, `INSERT INTO task_attachments(project_id,task_id,path,content_type,size_bytes) VALUES($1,$2,$3,'text/plain',7)`, project, task, path); err != nil {
				t.Fatal(err)
			}
		}
		// Owners need not be visible or even materialized for retained metadata.
		read, err := OpenOfflineStorageMigration(ctx, db.Pool.Config().ConnString())
		if err != nil {
			t.Fatal(err)
		}
		t.Cleanup(read.Close)
		var paths []string
		if err = read.VerifyOfflineAttachments(ctx, func(a model.Attachment) error {
			if a.ProjectID != project || a.TaskID != task || a.SizeBytes != 7 {
				t.Fatal("attachment identity changed", a)
			}
			paths = append(paths, a.Path)
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		if len(paths) != 3 || paths[0] != "Report.md" || paths[2] != "report.md" {
			t.Fatal(paths)
		}
		failure := errors.New("verification refused")
		if err = read.VerifyOfflineAttachments(ctx, func(model.Attachment) error { return failure }); !errors.Is(err, failure) {
			t.Fatal("callback failure lost", err)
		}
		read.Close()
		if err = read.VerifyOfflineAttachments(ctx, func(model.Attachment) error { return nil }); err == nil {
			t.Fatal("closed reader accepted")
		}
	}) {
		return
	}
	t.Run("candidate schema required", func(t *testing.T) {
		if _, err := OpenOfflineStorageMigration(t.Context(), "postgres://bad%host/db"); err == nil {
			t.Fatal("invalid URL accepted")
		}
		if _, err := db.Pool.Exec(t.Context(), `DELETE FROM schema_migrations WHERE version=(SELECT max(version) FROM schema_migrations)`); err != nil {
			t.Fatal(err)
		}
		if read, err := OpenOfflineStorageMigration(t.Context(), db.Pool.Config().ConnString()); err == nil {
			read.Close()
			t.Fatal("incomplete schema accepted")
		}
	})
}

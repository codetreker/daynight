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
	sessioncore "github.com/codetreker/daynight/packages/daynight-server/internal/core/session"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

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

package session_test

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"testing"
	"time"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pgsession "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/session"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestUploadSettlementRejectsCorruptPersistedJSONWithoutPartialInventory(t *testing.T) {
	for _, field := range []string{"spec", "receipt"} {
		t.Run(field, func(t *testing.T) {
			db, id, actor := imageLedgerSession(t)
			now := time.Now().UTC().Truncate(time.Microsecond)
			ids := []string{uuid.NewString(), uuid.NewString()}
			sort.Strings(ids)
			sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
				for _, uploadID := range ids {
					upload := store.SessionUploadRecord{SessionID: id, ActorID: actor.UserID, BlobID: uuid.NewString(), Spec: sp.ImageUploadSpec{UploadID: uploadID, ImageID: uuid.NewString(), ByteLength: "8", SHA256: archiveHashOf("original")}, ExpiresAt: now, Receipt: sp.ImageUploadReceipt{State: "receiving", AcceptedOffset: "0"}}
					if err := base.(store.SessionResourceDAO).SaveSessionUpload(t.Context(), upload); err != nil {
						return err
					}
				}
				return nil
			})
			// These values are valid JSONB but cannot be decoded into the stored
			// model. Keep the second row selected after a valid first result.
			if field == "spec" {
				mustQueryExec(t, db, `UPDATE session_image_uploads SET spec='[]'::jsonb WHERE session_id=$1 AND upload_id=$2`, id, ids[1])
			} else {
				mustQueryExec(t, db, `UPDATE session_image_uploads SET receipt='{"state":"receiving","acceptedOffset":17}'::jsonb WHERE session_id=$1 AND upload_id=$2`, id, ids[1])
			}
			sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
				rows, err := base.(store.SessionResourceSettlementDAO).ListSessionUploadsForSettlement(t.Context(), id, now)
				var invalid *json.UnmarshalTypeError
				if !errors.As(err, &invalid) || rows != nil {
					t.Fatal("corrupt persisted upload became a partial successful inventory", rows, err)
				}
				// Decoding failure must remain observable without deleting or
				// repairing the original persistence record.
				_, err = base.(store.SessionResourceDAO).SessionUpload(t.Context(), id, ids[1])
				if !errors.As(err, &invalid) {
					t.Fatal("inventory silently repaired corrupt persisted JSON", err)
				}
				return nil
			})
		})
	}
}

func TestUploadSettlementPreservesClosedTransactionAndCancellationErrors(t *testing.T) {
	db, id, _ := imageLedgerSession(t)
	for _, kind := range []string{"closed transaction", "cancelled context"} {
		t.Run(kind, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
			defer cancel()
			tx, err := db.Pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(context.Background())
			want := error(context.Canceled)
			if kind == "closed transaction" {
				if err = tx.Rollback(ctx); err != nil {
					t.Fatal(err)
				}
				want = pgx.ErrTxClosed
			} else {
				cancel()
			}
			dao := pgsession.New(tx).(store.SessionResourceSettlementDAO)
			rows, err := dao.ListSessionUploadsForSettlement(ctx, id, time.Now())
			if !errors.Is(err, want) || rows != nil {
				t.Fatal("failed settlement query supplied a successful inventory or hid its cause", rows, err)
			}
		})
	}
}

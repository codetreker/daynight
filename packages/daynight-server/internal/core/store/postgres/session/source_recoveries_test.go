package session_test

import (
	"bytes"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/google/uuid"
)

func TestSourceRecoveryLedgerPersistsAndDetectsMissingRecord(t *testing.T) {
	db := isolatedStore(t)
	_, session := prepareArchiveSession(t, db)
	original := store.SessionSourceRecovery{SessionID: session, RecoveryID: uuid.NewString(), Digest: bytes.Repeat([]byte{7}, 32), VerifiedThrough: 4}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		dao := base.(store.SessionSourceRecoveryDAO)
		n, err := dao.SessionSourceRecoveryCount(t.Context(), session)
		if err != nil || n != 0 {
			t.Fatal(n, err)
		}
		return dao.SaveSessionSourceRecovery(t.Context(), original)
	})
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		source := base.(store.SessionSourceDAO)
		if err := source.PruneSessionSourceHashes(t.Context(), session, uuid.NewString(), 9000); err != nil {
			return err
		}
		dao := base.(store.SessionSourceRecoveryDAO)
		got, err := dao.SessionSourceRecovery(t.Context(), session, original.RecoveryID)
		if err != nil || got.VerifiedThrough != 4 || !bytes.Equal(got.Digest, original.Digest) {
			t.Fatal(got, err)
		}
		count, err := dao.SessionSourceRecoveryCount(t.Context(), session)
		if err != nil || count != 1 {
			t.Fatal(count, err)
		}
		return nil
	})
	if _, err := db.Pool.Exec(t.Context(), `DELETE FROM session_source_recoveries WHERE session_id=$1`, session); err != nil {
		t.Fatal(err)
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		_, err := base.(store.SessionSourceRecoveryDAO).SessionSourceRecoveryCount(t.Context(), session)
		var f *model.Fault
		if !errors.As(err, &f) || f.Code != "source_corrupt" {
			t.Fatal("missing recovery treated as new", err)
		}
		return nil
	})
}

func TestSourceRecoveryLedgerCapacityAndRollback(t *testing.T) {
	db := isolatedStore(t)
	_, session := prepareArchiveSession(t, db)
	cause := errors.New("abort recovery transaction")
	proposed := store.SessionSourceRecovery{SessionID: session, RecoveryID: uuid.NewString(), Digest: bytes.Repeat([]byte{3}, 32), VerifiedThrough: 1}
	completion, err := db.WriteSession(t.Context(), func(scope store.SessionScope) error {
		if e := scope.SessionDAO().(store.SessionSourceRecoveryDAO).SaveSessionSourceRecovery(t.Context(), proposed); e != nil {
			return e
		}
		return cause
	})
	if !errors.Is(err, cause) || completion.Outcome != store.TransactionNotCommitted {
		t.Fatal(completion, err)
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		dao := base.(store.SessionSourceRecoveryDAO)
		n, e := dao.SessionSourceRecoveryCount(t.Context(), session)
		if e != nil || n != 0 {
			t.Fatal(n, e)
		}
		_, e = dao.SessionSourceRecovery(t.Context(), session, proposed.RecoveryID)
		if !errors.Is(e, model.ErrNotFound) {
			t.Fatal(e)
		}
		return nil
	})
	if _, err = db.Pool.Exec(t.Context(), `INSERT INTO session_source_recoveries SELECT $1,gen_random_uuid(),decode(repeat('ab',32),'hex'),1 FROM generate_series(1,4096)`, session); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Pool.Exec(t.Context(), `UPDATE task_sessions SET source_recovery_count=4096 WHERE id=$1`, session); err != nil {
		t.Fatal(err)
	}
	sessionDAOTransaction(t, db, func(base store.SessionDAO) error {
		dao := base.(store.SessionSourceRecoveryDAO)
		n, e := dao.SessionSourceRecoveryCount(t.Context(), session)
		if e != nil || n != 4096 {
			t.Fatal(n, e)
		}
		e = dao.SaveSessionSourceRecovery(t.Context(), proposed)
		var f *model.Fault
		if !errors.As(e, &f) || f.Code != "quota_exceeded" {
			t.Fatal("full ledger admitted recovery", e)
		}
		n, e = dao.SessionSourceRecoveryCount(t.Context(), session)
		if e != nil || n != 4096 {
			t.Fatal("full ledger evicted a record", n, e)
		}
		return nil
	})
}

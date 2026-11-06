package pg

import (
	"context"
	"errors"
	"net"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestQueryErrorPreservesDatabaseFactsAndCause(t *testing.T) {
	cause := &pgconn.PgError{Code: "23505"}
	err := QueryError("insert", cause)
	isDatabase, state := store.DatabaseErrorFacts(err)
	if !isDatabase || state != "23505" || !errors.Is(err, cause) {
		t.Fatalf("database facts = %v, %q, error = %v", isDatabase, state, err)
	}
}

func TestQueryErrorPreservesMissingRow(t *testing.T) {
	err := QueryError("read", pgx.ErrNoRows)
	if !errors.Is(err, model.ErrNotFound) || !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("missing row error = %v", err)
	}
	if isDatabase, _ := store.DatabaseErrorFacts(err); isDatabase {
		t.Fatalf("missing row classified as database failure: %v", err)
	}
	if err := AuthQueryError("read", nil); err != nil {
		t.Fatalf("successful authentication query: %v", err)
	}
}

func TestConfirmedCleanupRetainsCauseAndDoesNotMaskDriverFailure(t *testing.T) {
	closed := ConfirmedClosedCleanup(pgconn.ErrConnClosed)
	if closed.Error() != pgconn.ErrConnClosed.Error() {
		t.Fatalf("confirmed cleanup changed the retained cause: %v", closed)
	}
	cause := errors.Join(context.DeadlineExceeded, closed)
	err := QueryError("snapshot", cause)
	if failed, _ := store.DatabaseErrorFacts(err); failed || !errors.Is(err, context.DeadlineExceeded) || !errors.Is(err, pgconn.ErrConnClosed) {
		t.Fatalf("confirmed cleanup was misclassified or lost causes: %v", err)
	}
	driver := &pgconn.PgError{Code: "23505"}
	fault := &model.Fault{Code: "not_found", Cause: driver}
	err = QueryError("snapshot", errors.Join(fault, closed))
	if failed, state := store.DatabaseErrorFacts(err); !failed || state != driver.Code || !errors.Is(err, driver) || !errors.Is(err, pgconn.ErrConnClosed) {
		t.Fatalf("confirmed cleanup hid a separate database failure: %v", err)
	}
}

func TestQueryErrorRetainsDriverCodeInsideNetworkFailure(t *testing.T) {
	driver := &pgconn.PgError{Code: "23505"}
	err := QueryError("query", &net.OpError{Op: "read", Err: driver})
	if failed, state := store.DatabaseErrorFacts(err); !failed || state != driver.Code || !errors.Is(err, driver) {
		t.Fatalf("nested driver facts lost: %v", err)
	}
}

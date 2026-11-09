package pg

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	taskproperties "github.com/codetreker/daynight/packages/daynight-server/internal/core/model/taskproperty"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func TestQueryErrorClassifiesFailuresAndPreservesCauses(t *testing.T) {
	validation := &taskproperties.ValidationError{Rule: "invalid property", Cause: errors.New("invalid value")}
	fault := &model.Fault{Code: "not_found", Message: "not found", Cause: model.ErrNotFound}
	connection := &net.OpError{Op: "read", Net: "tcp", Err: io.ErrUnexpectedEOF}
	driver := &pgconn.PgError{Code: "23505", Message: "private"}
	for _, tc := range []struct {
		name    string
		cause   error
		failure bool
		state   string
	}{
		{"missing row", pgx.ErrNoRows, false, ""},
		{"not found", model.ErrNotFound, false, ""},
		{"validation", fmt.Errorf("decode: %w", validation), false, ""},
		{"validation at end of input", &taskproperties.ValidationError{Rule: "invalid property", Cause: io.EOF}, false, ""},
		{"fault", fault, false, ""},
		{"fault with connection failure", errors.Join(fault, connection), true, ""},
		{"fault caused by connection failure", &model.Fault{Code: "not_found", Cause: connection}, true, ""},
		{"validation with database failure", errors.Join(validation, driver), true, "23505"},
		{"connection closed", pgconn.ErrConnClosed, true, ""},
		{"opaque driver failure", errors.New("connection interrupted"), true, ""},
		{"cancellation", context.Canceled, false, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			err := QueryError("query", tc.cause)
			failure, state := store.DatabaseErrorFacts(err)
			if failure != tc.failure || state != tc.state || !errors.Is(err, tc.cause) {
				t.Fatalf("facts=(%v,%q), cause retained=%v", failure, state, errors.Is(err, tc.cause))
			}
			if tc.cause == pgx.ErrNoRows && !errors.Is(err, model.ErrNotFound) {
				t.Fatal("missing row lost neutral marker")
			}
		})
	}
}

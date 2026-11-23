package usercandidate

import (
	"context"
	"errors"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

type failedQuery struct {
	pgx.Tx
	rows pgx.Rows
	err  error
}

func (tx failedQuery) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return tx.rows, tx.err
}

type failedRows struct {
	pgx.Rows
	scanErr error
	readErr error
	closed  bool
}

func (rows *failedRows) Next() bool        { return rows.scanErr != nil }
func (rows *failedRows) Scan(...any) error { return rows.scanErr }
func (rows *failedRows) Err() error        { return rows.readErr }
func (rows *failedRows) Close()            { rows.closed = true }

func TestSearchFailuresRetainCausesAndCloseRows(t *testing.T) {
	cause := errors.New("directory unavailable")
	for _, stage := range []string{"query", "scan", "read"} {
		t.Run(stage, func(t *testing.T) {
			rows := &failedRows{}
			tx := failedQuery{rows: rows}
			switch stage {
			case "query":
				tx.err = cause
			case "scan":
				rows.scanErr = cause
			case "read":
				rows.readErr = cause
			}
			page, err := NewReader(tx).MemberCandidates(t.Context(), store.UserCandidateQuery{Query: "a", Limit: 20})
			if !errors.Is(err, cause) || page.Items != nil || page.HasMore || (stage != "query" && !rows.closed) {
				t.Fatalf("page=%+v err=%v rowsClosed=%t", page, err, rows.closed)
			}
		})
	}
}

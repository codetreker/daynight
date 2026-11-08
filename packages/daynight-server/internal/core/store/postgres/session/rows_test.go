package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

type failedRows struct {
	pgx.Rows
	scanError, errorAfterRows error
	next                      bool
	closed                    bool
}

func (r *failedRows) Next() bool        { next := r.next; r.next = false; return next }
func (r *failedRows) Scan(...any) error { return r.scanError }
func (r *failedRows) Err() error        { return r.errorAfterRows }
func (r *failedRows) Close()            { r.closed = true }

type rowsTx struct {
	pgx.Tx
	rows pgx.Rows
}

func (tx rowsTx) Query(context.Context, string, ...any) (pgx.Rows, error) { return tx.rows, nil }

func TestSessionQueriesPreserveScanAndIterationFailures(t *testing.T) {
	cause := errors.New("session row stream failed")
	for _, stage := range []string{"scan", "iteration"} {
		for name, run := range map[string]func(*DAO) error{
			"task properties": func(dao *DAO) error {
				_, err := dao.sessionTaskProperties(t.Context(), "task", store.SessionTask{})
				return err
			},
			"bot sessions": func(dao *DAO) error { _, err := dao.LockBotSessions(t.Context(), "bot"); return err },
			"test sessions": func(dao *DAO) error {
				_, err := dao.ListTestSessions(t.Context(), "owner", time.Now(), 1, false, time.Now(), nil, "")
				return err
			},
			"terminal history": func(dao *DAO) error {
				_, err := dao.TerminalHistory(t.Context(), "project", "task", nil, nil, 1)
				return err
			},
			"accepted operations": func(dao *DAO) error { _, err := dao.AcceptedSessionOperations(t.Context(), "session"); return err },
			"stopping operations": func(dao *DAO) error { _, err := dao.StoppingTestOperations(t.Context(), "session"); return err },
			"unreconciled operations": func(dao *DAO) error {
				_, err := dao.UnreconciledSessionOperations(t.Context(), "session", 1)
				return err
			},
			"queued terminal operation": func(dao *DAO) error { _, err := dao.QueuedTerminalOperation(t.Context(), "session"); return err },
		} {
			t.Run(stage+"/"+name, func(t *testing.T) {
				rows := &failedRows{}
				if stage == "scan" {
					rows.next = true
					rows.scanError = cause
				} else {
					rows.errorAfterRows = cause
				}
				err := run(&DAO{tx: rowsTx{rows: rows}})
				if !errors.Is(err, cause) {
					t.Fatalf("row stream lost cause: %v", err)
				}
				if !rows.closed {
					t.Fatal("row stream was not closed")
				}
			})
		}
	}
}

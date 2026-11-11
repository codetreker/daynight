package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

type scanRow func(...any) error

func (row scanRow) Scan(dest ...any) error { return row(dest...) }

type rowTx struct {
	pgx.Tx
	query func(string, ...any) pgx.Row
}

func (tx rowTx) QueryRow(_ context.Context, sql string, args ...any) pgx.Row {
	return tx.query(sql, args...)
}

func TestOAuthSessionCredentialRechecksExpiryAfterLock(t *testing.T) {
	cause := errors.New("database clock unavailable")
	for _, clockError := range []bool{false, true} {
		t.Run(map[bool]string{false: "expired after lock", true: "clock query failure"}[clockError], func(t *testing.T) {
			calls := 0
			tx := rowTx{query: func(sql string, args ...any) pgx.Row {
				calls++
				if calls == 1 {
					return scanRow(func(dest ...any) error {
						expiry := time.Now().Add(time.Hour)
						*dest[0].(**time.Time) = &expiry
						return nil
					})
				}
				if sql != `SELECT $1::timestamptz > clock_timestamp()` || len(args) != 1 {
					t.Fatalf("expiry was not checked against database clock: %q %v", sql, args)
				}
				return scanRow(func(dest ...any) error {
					if clockError {
						return cause
					}
					*dest[0].(*bool) = false
					return nil
				})
			}}
			err := New(tx).LockCredential(t.Context(), model.Principal{Kind: model.OAuthCredential}, time.Now())
			want := model.ErrNotFound
			if clockError {
				want = cause
			}
			if !errors.Is(err, want) || calls != 2 {
				t.Fatalf("post-lock expiry: calls=%d error=%v", calls, err)
			}
		})
	}
}

type retirementRow struct {
	err   error
	value bool
}

func (r retirementRow) Scan(dest ...any) error {
	if r.err != nil {
		return r.err
	}
	*dest[0].(*bool) = r.value
	return nil
}

type retirementRowTx struct {
	pgx.Tx
	rows []retirementRow
	next int
}

func (tx *retirementRowTx) QueryRow(_ context.Context, _ string, _ ...any) pgx.Row {
	r := tx.rows[tx.next]
	tx.next++
	return r
}

func TestSessionProjectLifecycleReadFailures(t *testing.T) {
	ctx := t.Context()
	cause := errors.New("lifecycle query failed")
	for _, tc := range []struct {
		name   string
		first  error
		second retirementRow
		want   error
	}{
		{"live read failure", cause, retirementRow{}, cause},
		{"missing and lifecycle read failure", pgx.ErrNoRows, retirementRow{err: cause}, cause},
		{"deleted", pgx.ErrNoRows, retirementRow{value: true}, store.ErrSessionProjectNotFound},
		{"unavailable but live", pgx.ErrNoRows, retirementRow{value: false}, model.ErrNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dao := &DAO{tx: &retirementRowTx{rows: []retirementRow{{err: tc.first}, tc.second}}}
			_, err := dao.ProjectAccess(ctx, "user", "project")
			if !errors.Is(err, tc.want) {
				t.Fatalf("Project access: %v", err)
			}
		})
	}
	for _, tc := range []struct {
		name string
		row  retirementRow
		want error
	}{
		{"failure", retirementRow{err: cause}, cause}, {"deleted", retirementRow{}, model.ErrNotFound}, {"live", retirementRow{value: true}, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dao := &DAO{tx: &retirementRowTx{rows: []retirementRow{tc.row}}}
			if err := dao.ensureLiveProject(ctx, "project"); !errors.Is(err, tc.want) {
				t.Fatalf("live project: %v", err)
			}
		})
	}
}

type failedQueryTx struct {
	pgx.Tx
	err error
}

func (tx failedQueryTx) Query(context.Context, string, ...any) (pgx.Rows, error) {
	return nil, tx.err
}

func TestSessionTaskPropertiesPreservesQueryFailure(t *testing.T) {
	want := errors.New("query failed")
	dao := &DAO{tx: failedQueryTx{err: want}}
	_, err := dao.sessionTaskProperties(context.Background(), "task", store.SessionTask{})
	if !errors.Is(err, want) {
		t.Fatalf("task property query failure lost: %v", err)
	}
}

type failedRows struct {
	pgx.Rows
	scanError, errorAfterRows error
	next                      bool
	closed                    bool
}

func (r *failedRows) Next() bool { next := r.next; r.next = false; return next }

func (r *failedRows) Scan(...any) error { return r.scanError }

func (r *failedRows) Err() error { return r.errorAfterRows }

func (r *failedRows) Close() { r.closed = true }

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

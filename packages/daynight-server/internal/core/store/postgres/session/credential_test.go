package session

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
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

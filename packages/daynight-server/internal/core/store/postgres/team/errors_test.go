package team

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/jackc/pgx/v5"
)

type failedTeamRows struct {
	pgx.Rows
	scanFailure      error
	iterationFailure error
	visited          bool
}

func (rows *failedTeamRows) Close() {}
func (rows *failedTeamRows) Next() bool {
	if rows.visited || rows.scanFailure == nil {
		return false
	}
	rows.visited = true
	return true
}
func (rows *failedTeamRows) Scan(...any) error { return rows.scanFailure }
func (rows *failedTeamRows) Err() error        { return rows.iterationFailure }

type teamRowsTx struct {
	pgx.Tx
	rows pgx.Rows
}

func (tx teamRowsTx) Query(context.Context, string, ...any) (pgx.Rows, error) { return tx.rows, nil }

func TestTeamListRowFailuresPreserveCauses(t *testing.T) {
	cause := errors.New("Team rows failed")
	for _, phase := range []string{"scan", "iteration"} {
		t.Run(phase, func(t *testing.T) {
			operations := map[string]func(store.TeamReader) error{
				"Teams": func(reader store.TeamReader) error {
					_, err := reader.Teams(t.Context(), "user", store.Page{Limit: 2})
					return err
				},
				"bounded Teams": func(reader store.TeamReader) error {
					_, err := reader.TeamsBounded(t.Context(), "user", store.Page{Limit: 2}, 10)
					return err
				},
				"members": func(reader store.TeamReader) error { _, err := reader.TeamMembers(t.Context(), "team"); return err },
				"member page": func(reader store.TeamReader) error {
					_, err := reader.TeamMembersPage(t.Context(), "team", store.Page{Limit: 2})
					return err
				},
				"invitations": func(reader store.TeamReader) error {
					_, err := reader.TeamInvitations(t.Context(), "team", time.Now())
					return err
				},
				"invitation page": func(reader store.TeamReader) error {
					_, err := reader.TeamInvitationPage(t.Context(), "team", time.Now(), store.Page{Limit: 2})
					return err
				},
			}
			for name, operation := range operations {
				t.Run(name, func(t *testing.T) {
					rows := &failedTeamRows{}
					if phase == "scan" {
						rows.scanFailure = cause
					} else {
						rows.iterationFailure = cause
					}
					if err := operation(NewReader(teamRowsTx{rows: rows})); !errors.Is(err, cause) {
						t.Fatalf("row cause lost: %v", err)
					}
				})
			}
		})
	}
}

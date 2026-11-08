package project_test

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/project"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

type failedRow struct{ cause error }

func (r failedRow) Scan(...any) error { return r.cause }

type failedRows struct {
	pgx.Rows
	cause   error
	scan    bool
	visited bool
}

func (r *failedRows) Close() {}
func (r *failedRows) Next() bool {
	if r.scan && !r.visited {
		r.visited = true
		return true
	}
	return false
}
func (r *failedRows) Scan(...any) error { return r.cause }
func (r *failedRows) Err() error {
	if r.scan {
		return nil
	}
	return r.cause
}

type failingTx struct {
	pgx.Tx
	fragment string
	cause    error
	rowMode  string
}

func (tx failingTx) matches(sql string) bool {
	return tx.fragment == "" || strings.Contains(sql, tx.fragment)
}
func (tx failingTx) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	if tx.matches(sql) {
		return pgconn.CommandTag{}, tx.cause
	}
	return tx.Tx.Exec(ctx, sql, args...)
}
func (tx failingTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	if tx.matches(sql) {
		return failedRow{tx.cause}
	}
	return tx.Tx.QueryRow(ctx, sql, args...)
}
func (tx failingTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	if tx.matches(sql) {
		if tx.rowMode != "" {
			return &failedRows{cause: tx.cause, scan: tx.rowMode == "scan"}, nil
		}
		return nil, tx.cause
	}
	return tx.Tx.Query(ctx, sql, args...)
}

func TestDAOFailuresPreserveCauseAndPhase(t *testing.T) {
	cause := errors.New("connection interrupted")
	cases := []struct {
		name, phase string
		run         func(pgx.Tx) error
	}{
		{"project", "read project", func(tx pgx.Tx) error { _, err := project.NewReader(tx).Project(t.Context(), "project"); return err }},
		{"projects", "list projects", func(tx pgx.Tx) error {
			_, err := project.NewReader(tx).Projects(t.Context(), store.Page{Limit: 2})
			return err
		}},
		{"settings", "update project settings", func(tx pgx.Tx) error {
			_, err := project.NewWriter(tx, "project").UpdateProjectSettings(t.Context(), 15)
			return err
		}},
		{"cache", "invalidate deleted task cache", func(tx pgx.Tx) error { return project.NewWriter(tx, "project").InvalidateTaskCache(t.Context()) }},
		{"member", "read project member", func(tx pgx.Tx) error {
			_, err := project.NewReader(tx).DirectProjectMember(t.Context(), "user", "project")
			return err
		}},
		{"personal team", "read personal Team", func(tx pgx.Tx) error {
			_, err := project.NewCreation(tx, "user").CreationPersonalTeam(t.Context(), true)
			return err
		}},
		{"creation team", "lock creation Team", func(tx pgx.Tx) error {
			_, err := project.NewCreation(tx, "user").LockCreationTeam(t.Context(), "team")
			return err
		}},
		{"creation membership", "read creation Team membership", func(tx pgx.Tx) error {
			_, err := project.NewCreation(tx, "user").CreationTeamMember(t.Context(), "team")
			return err
		}},
		{"insert project", "insert project", func(tx pgx.Tx) error {
			_, _, err := project.NewCreation(tx, "user").InsertProject(t.Context(), "project", "Project", "host:repo", "team")
			return err
		}},
		{"participants", "list project participants", func(tx pgx.Tx) error {
			_, err := project.NewReader(tx).ProjectParticipants(t.Context(), "project")
			return err
		}},
		{"role", "update member role", func(tx pgx.Tx) error {
			_, err := project.NewWriter(tx, "project").SetMemberRole(t.Context(), "user", model.ProjectAdmin)
			return err
		}},
		{"remove member", "remove project member", func(tx pgx.Tx) error { return project.NewWriter(tx, "project").RemoveMember(t.Context(), "user") }},
		{"invited member", "add invited member", func(tx pgx.Tx) error {
			_, err := project.NewWriter(tx, "project").AddInvitedMember(t.Context(), "user")
			return err
		}},
		{"invitation", "inspect invitation", func(tx pgx.Tx) error { _, err := project.NewReader(tx).Invitation(t.Context(), nil); return err }},
		{"locked invitation", "lock invitation", func(tx pgx.Tx) error {
			_, err := project.NewWriter(tx, "project").LockInvitation(t.Context(), nil)
			return err
		}},
		{"create invitation", "clean expired invitations", func(tx pgx.Tx) error {
			return project.NewWriter(tx, "project").CreateInvitation(t.Context(), model.ProjectInvitation{})
		}},
		{"invitations", "list invitations", func(tx pgx.Tx) error {
			_, err := project.NewReader(tx).Invitations(t.Context(), "project", time.Now())
			return err
		}},
		{"revoke", "revoke invitation", func(tx pgx.Tx) error {
			return project.NewWriter(tx, "project").RevokeInvitation(t.Context(), "invite", time.Now())
		}},
		{"consume", "consume invitation", func(tx pgx.Tx) error {
			return project.NewWriter(tx, "project").ConsumeInvitation(t.Context(), "invite", "user", time.Now())
		}},
		{"direct grant", "lock direct grant", func(tx pgx.Tx) error {
			_, err := project.NewWriter(tx, "project").DirectGrant(t.Context(), "user")
			return err
		}},
		{"create grant", "create project grant", func(tx pgx.Tx) error {
			_, err := project.NewWriter(tx, "project").CreateGrant(t.Context(), "user", model.ProjectAdmin)
			return err
		}},
		{"scoped projects", "list accessible projects", func(tx pgx.Tx) error {
			_, err := project.NewReader(tx).ScopedProjects(t.Context(), principal("user"), store.ProjectScope{Kind: store.ProjectScopeAll}, store.Page{Limit: 2})
			return err
		}},
		{"transfer team", "read transfer Team", func(tx pgx.Tx) error { _, err := project.NewReader(tx).TransferTeam(t.Context(), "team"); return err }},
		{"transfer role", "read transfer role", func(tx pgx.Tx) error {
			_, err := project.NewReader(tx).TransferRole(t.Context(), "user", "project", "team")
			return err
		}},
		{"ownership", "lock transfer ownership", func(tx pgx.Tx) error {
			_, err := project.NewWriter(tx, "project").LockTransferOwnership(t.Context())
			return err
		}},
		{"lock teams", "read transfer Team", func(tx pgx.Tx) error {
			_, _, err := project.NewWriter(tx, "project").LockTransferTeams(t.Context(), "source", "target")
			return err
		}},
		{"move ownership", "update project ownership", func(tx pgx.Tx) error {
			_, err := project.NewWriter(tx, "project").MoveOwnership(t.Context(), "team")
			return err
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.run(failingTx{cause: cause})
			var failure *store.Error
			if !errors.Is(err, cause) || !errors.As(err, &failure) || failure.Phase != tc.phase || !failure.DatabaseFailure {
				t.Fatalf("failure = %#v, error = %v", failure, err)
			}
		})
	}
	for _, mode := range []string{"scan", "iteration"} {
		for _, tc := range cases {
			switch tc.name {
			case "projects", "participants", "invitations", "scoped projects":
				t.Run(tc.name+"/"+mode, func(t *testing.T) { err := tc.run(failingTx{cause: cause, rowMode: mode}); checkError(t, err, cause) })
			}
		}
	}
}

func TestDAOLateFailuresPreserveOperationResultContract(t *testing.T) {
	f := newFixture(t)
	ctx := t.Context()
	cause := errors.New("connection lost after write")
	for _, tc := range []struct{ name, fragment, phase string }{
		{"ownership insert", "INSERT INTO project_ownership", "insert project ownership"},
		{"administrator insert", "INSERT INTO project_grants", "insert project administrator"},
		{"project readback", "WHERE p.id = $1", "read project"},
		{"access readback", "WHERE p.id=$1", "read project access"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			wrapped := failingTx{Tx: f.tx, fragment: tc.fragment, cause: cause}
			result, access, err := project.NewCreation(wrapped, f.owner).InsertProject(ctx, uuid.NewString(), "New Project", "host:new", f.team)
			var failure *store.Error
			if !errors.Is(err, cause) || !errors.As(err, &failure) || failure.Phase != tc.phase || access.ProjectID != "" {
				t.Fatalf("result = %+v, access = %+v, failure = %+v, %v", result, access, failure, err)
			}
			if tc.name != "access readback" && result.ID != "" {
				t.Fatalf("partial project = %+v", result)
			}
		})
	}
	wrapped := failingTx{Tx: f.tx, fragment: "SELECT count(*)", cause: cause}
	_, err := project.NewCreation(wrapped, f.owner).CreationPersonalTeam(ctx, true)
	checkError(t, err, cause)
	wrapped = failingTx{Tx: f.tx, fragment: "INSERT INTO project_invitations", cause: cause}
	err = project.NewWriter(wrapped, f.project).CreateInvitation(ctx, model.ProjectInvitation{})
	checkError(t, err, cause)
	wrapped = failingTx{Tx: f.tx, fragment: "UPDATE projects", cause: cause}
	_, err = project.NewWriter(wrapped, f.project).MoveOwnership(ctx, f.personal)
	var failure *store.Error
	if !errors.Is(err, cause) || !errors.As(err, &failure) || failure.Phase != "update transferred project" {
		t.Fatalf("move second write = %+v, %v", failure, err)
	}
}

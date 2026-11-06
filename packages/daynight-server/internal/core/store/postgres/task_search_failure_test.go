package postgres

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/tasksearch"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/task"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
)

func TestTaskSearchProjectAccessUsesSnapshot(t *testing.T) {
	db := searchTestStore(t)
	ctx := context.Background()
	project, owner, team, stranger := uuid.NewString(), uuid.NewString(), uuid.NewString(), uuid.NewString()
	for _, statement := range []struct {
		sql  string
		args []any
	}{
		{`INSERT INTO projects(id,name,repo_url) VALUES($1,'search','example')`, []any{project}},
		{`INSERT INTO users(id,uniauth_id,created_at,updated_at) VALUES($1,'owner',now(),now())`, []any{owner}},
		{`INSERT INTO teams(id,name) VALUES($1,'owners')`, []any{team}},
		{`INSERT INTO team_members(team_id,user_id,role) VALUES($1,$2,'admin')`, []any{team, owner}},
		{`INSERT INTO project_ownership(project_id,team_id) VALUES($1,$2)`, []any{project, team}},
	} {
		if _, err := db.Pool.Exec(ctx, statement.sql, statement.args...); err != nil {
			t.Fatal(err)
		}
	}
	err := NewTaskSearch(db.Pool).ReadTaskSearch(ctx, func(s store.TaskSearchSnapshot) error {
		access, err := s.ProjectAccess(ctx, model.Principal{UserID: owner}, project)
		if err != nil {
			return err
		}
		if access.UserID != owner || access.ProjectID != project || access.Role != model.ProjectAdmin {
			t.Fatalf("access %+v", access)
		}
		if _, err := s.ProjectAccess(ctx, model.Principal{UserID: stranger}, project); err == nil {
			t.Fatal("ungranted user was authorized")
		}
		if _, err := db.Pool.Exec(ctx, `DELETE FROM team_members WHERE team_id=$1 AND user_id=$2`, team, owner); err != nil {
			return err
		}
		_, err = s.ProjectAccess(ctx, model.Principal{UserID: owner}, project)
		return err
	})
	if err != nil {
		t.Fatalf("access changed inside snapshot: %v", err)
	}
	err = NewTaskSearch(db.Pool).ReadTaskSearch(ctx, func(s store.TaskSearchSnapshot) error {
		_, err := s.ProjectAccess(ctx, model.Principal{UserID: owner}, project)
		return err
	})
	if err == nil {
		t.Fatal("revoked user retained access in new snapshot")
	}
}

func TestTaskSearchRejectsInvalidDAOInputs(t *testing.T) {
	valid := &tasksearch.Node{Kind: tasksearch.Leaf, Atom: tasksearch.Atom{Field: tasksearch.AnyField, Term: "word"}}
	invalid := []*tasksearch.Node{nil, {Kind: tasksearch.Leaf}, {Kind: tasksearch.Leaf, Atom: tasksearch.Atom{Field: tasksearch.Field(255), Term: "word"}}, {Kind: tasksearch.Kind(255)}, {Kind: tasksearch.And, Left: nil, Right: valid}, {Kind: tasksearch.Or, Left: valid, Right: nil}}
	db := searchTestStore(t)
	err := NewTaskSearch(db.Pool).ReadTaskSearch(context.Background(), func(s store.TaskSearchSnapshot) error {
		for _, node := range invalid {
			if _, err := s.Matches(context.Background(), uuid.NewString(), store.TaskSearchQuery{Expression: node, Limit: 1}); err == nil {
				t.Fatalf("accepted invalid expression: %+v", node)
			}
		}
		for _, input := range []store.TaskSearchQuery{{Expression: valid, Limit: 0}, {Expression: valid, Limit: 101}, {Expression: valid, Limit: 1, AssignedTo: model.TaskAssignmentFilter{Mode: "invalid"}}} {
			if _, err := s.Matches(context.Background(), uuid.NewString(), input); err == nil {
				t.Errorf("accepted invalid query %+v", input)
			}
		}
		if _, err := s.Titles(context.Background(), uuid.NewString(), []string{uuid.NewString()}); err == nil {
			t.Error("missing representative title accepted")
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

var injectedReadFailure = errors.New("injected read failure")

type faultQueryTx struct {
	pgx.Tx
	failAt, calls   int
	scan, iteration bool
}

func (tx *faultQueryTx) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	tx.calls++
	if tx.calls == tx.failAt && !tx.scan && !tx.iteration {
		return nil, injectedReadFailure
	}
	rows, err := tx.Tx.Query(ctx, sql, args...)
	if err != nil || tx.calls != tx.failAt {
		return rows, err
	}
	return &faultQueryRows{Rows: rows, scan: tx.scan, iteration: tx.iteration}, nil
}

type faultQueryRows struct {
	pgx.Rows
	scan, iteration bool
}

func (r *faultQueryRows) Scan(dest ...any) error {
	if r.scan {
		return injectedReadFailure
	}
	return r.Rows.Scan(dest...)
}
func (r *faultQueryRows) Err() error {
	if r.iteration {
		return injectedReadFailure
	}
	return r.Rows.Err()
}

func TestTaskSearchReadFailuresDoNotBecomeResults(t *testing.T) {
	db := searchTestStore(t)
	ctx := context.Background()
	project, a, b := uuid.NewString(), uuid.NewString(), uuid.NewString()
	if _, err := db.Pool.Exec(ctx, `INSERT INTO projects(id,name,repo_url) VALUES($1,'search','example')`, project); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO tasks(id,project_id,title) VALUES($1,$3,'a'),($2,$3,'b')`, a, b, project); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Pool.Exec(ctx, `INSERT INTO task_dependencies(project_id,task_id,depends_on_task_id) VALUES($1,$2,$3)`, project, b, a); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name                    string
		failAt                  int
		scan, iteration, titles bool
	}{
		{"nodes query", 1, false, false, false}, {"nodes scan", 1, true, false, false}, {"nodes iteration", 1, false, true, false},
		{"edges query", 2, false, false, false}, {"edges scan", 2, true, false, false}, {"edges iteration", 2, false, true, false},
		{"titles query", 1, false, false, true}, {"titles scan", 1, true, false, true}, {"titles iteration", 1, false, true, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := ReadOnlySnapshot(ctx, db.Pool, func(tx pgx.Tx) error {
				s := task.NewSearchSnapshot(&faultQueryTx{Tx: tx, failAt: test.failAt, scan: test.scan, iteration: test.iteration})
				var err error
				if test.titles {
					_, err = s.Titles(ctx, project, []string{a})
				} else {
					_, err = s.ContextGraph(ctx, project, []string{a})
				}
				if !errors.Is(err, injectedReadFailure) {
					t.Fatalf("lost cause: %v", err)
				}
				var wrapped *store.Error
				if !errors.As(err, &wrapped) || strings.Contains(err.Error(), injectedReadFailure.Error()) {
					t.Fatalf("unsafe or unwrapped error: %v", err)
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
		})
	}
	for _, read := range []func(store.TaskSearchSnapshot) error{
		func(s store.TaskSearchSnapshot) error { _, err := s.Fence(ctx, uuid.NewString()); return err },
		func(s store.TaskSearchSnapshot) error {
			_, err := s.ContextSize(ctx, "not-a-uuid", []string{a})
			return err
		},
	} {
		err := NewTaskSearch(db.Pool).ReadTaskSearch(ctx, read)
		if err == nil {
			t.Fatal("database failure became success")
		}
		var failure *store.Error
		if !errors.As(err, &failure) {
			t.Fatalf("missing store failure: %v", err)
		}
	}
}

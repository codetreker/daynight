package postgres

import (
	"context"
	"errors"
	"sort"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/jackc/pgx/v5"
)

var errProjectGoalLockSetChanged = errors.New("project Goal lock set changed")

const goalLifecycleEdges = `WITH goals AS (SELECT id FROM tasks WHERE project_id=$1 AND type='goal'),
 edges AS (
  SELECT d.project_id,d.task_id FROM goals g JOIN task_dependencies d ON d.project_id=$1 AND d.task_id=g.id AND d.dependency_type='goal'
  UNION
  SELECT d.project_id,d.task_id FROM goals g JOIN task_dependencies d ON d.depends_on_task_id=g.id AND d.dependency_type='goal'
 )`

// goalLifecycleProjects is called before Project locks and again after the Team
// graph lock. Only the downstream Project of an incident edge needs a lock.
func goalLifecycleProjects(ctx context.Context, tx pgx.Tx, projectID string) ([]string, error) {
	rows, err := tx.Query(ctx, goalLifecycleEdges+` SELECT DISTINCT project_id::text FROM edges`, projectID)
	if err != nil {
		return nil, pg.QueryError("read affected Goal projects", err)
	}
	defer rows.Close()
	ids := map[string]bool{projectID: true}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, pg.QueryError("read affected Goal projects", err)
		}
		ids[id] = true
	}
	if err := rows.Err(); err != nil {
		return nil, pg.QueryError("read affected Goal projects", err)
	}
	projects := make([]string, 0, len(ids))
	for id := range ids {
		projects = append(projects, id)
	}
	sort.Strings(projects)
	return projects, nil
}

func lockGoalLifecycleProjects(ctx context.Context, tx pgx.Tx, source string, deleting bool) error {
	projects, err := goalLifecycleProjects(ctx, tx, source)
	if err != nil {
		return err
	}
	locked := make(map[string]bool, len(projects))
	for _, id := range projects {
		var found string
		// The source must still be live; retain locks for deleted downstream
		// projects until the graph is rechecked and cleanup completes.
		query := `SELECT id::text FROM projects WHERE id=$1 FOR UPDATE`
		if id == source {
			query = `SELECT id::text FROM projects WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`
		}
		if err := tx.QueryRow(ctx, query, id).Scan(&found); err != nil {
			return pg.QueryError("lock Goal lifecycle project", err)
		}
		locked[found] = true
	}
	if err := pg.LockGoalDependencyTeam(ctx, tx, source); err != nil {
		return err
	}
	current, err := goalLifecycleProjects(ctx, tx, source)
	if err != nil {
		return err
	}
	for _, id := range current {
		if !locked[id] {
			return errProjectGoalLockSetChanged
		}
	}
	return lockGoalLifecycleTasks(ctx, tx, source, deleting)
}

// Thread writers lock their Task before the Project ownership row. Acquire
// every Goal cleanup may touch before a lifecycle callback locks ownership.
// Deletion also locks every source Task, including historical rows, in the same
// UUID order as the affected downstream Goals. The sorted candidate subquery
// drives one primary-key row lock per ID; a hash join could lock in table order.
func lockGoalLifecycleTasks(ctx context.Context, tx pgx.Tx, source string, deleting bool) error {
	rows, err := tx.Query(ctx, goalLifecycleEdges+`
 , candidates AS (
  SELECT t.id FROM edges e JOIN tasks t ON t.id=e.task_id AND t.project_id=e.project_id
  JOIN projects p ON p.id=t.project_id
  WHERE t.type='goal' AND t.deleted_at IS NULL AND p.deleted_at IS NULL
  UNION
  SELECT id FROM tasks WHERE $2::boolean AND project_id=$1
 )
 SELECT locked.id FROM (SELECT id FROM candidates ORDER BY id OFFSET 0) candidate
 CROSS JOIN LATERAL (SELECT id FROM tasks WHERE id=candidate.id FOR UPDATE) locked`, source, deleting)
	if err != nil {
		return pg.QueryError("lock Goal lifecycle Tasks", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return pg.QueryError("lock Goal lifecycle Tasks", err)
		}
	}
	if err := rows.Err(); err != nil {
		return pg.QueryError("lock Goal lifecycle Tasks", err)
	}
	return nil
}

// Retry only a pre-callback lock-set miss whose rollback is confirmed. A
// callback, failed cleanup or commit attempt must never be replayed.
func (s *Store) writeGoalProjectLifecycle(ctx context.Context, projectID, label string, deleting bool, op func(pgx.Tx) error) (store.Completion, error) {
	for {
		tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
		if err != nil {
			return store.Completion{Outcome: store.TransactionNotCommitted}, pg.QueryError("begin "+label, err)
		}
		err = transact(ctx, tx, func(tx pgx.Tx) error {
			if err := lockGoalLifecycleProjects(ctx, tx, projectID, deleting); err != nil {
				return err
			}
			return op(tx)
		})
		var failure *store.TransactionError
		if errors.Is(err, errProjectGoalLockSetChanged) && errors.As(err, &failure) && failure.Outcome == store.TransactionNotCommitted && !failure.CommitAttempted && !failure.CleanupFailed {
			if contextErr := ctx.Err(); contextErr != nil {
				failure.Cause = errors.Join(failure.Cause, contextErr)
			} else {
				continue
			}
		}
		return teamCompletion(label, err)
	}
}

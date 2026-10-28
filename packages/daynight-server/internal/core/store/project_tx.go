package store

import (
	"context"
	"slices"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core"
	"github.com/codetreker/daynight/packages/daynight-server/internal/taskproperties"
	"github.com/jackc/pgx/v5"
)

type ProjectTx struct {
	tx        pgx.Tx
	projectID string
}

type TaskWrite struct {
	RequiredPlatform  *core.TaskPlatform
	AllowAgents       bool
	Title             string
	Description       string
	Properties        core.TaskProperties
	Status            core.TaskStatus
	DependsOn         []string
	ExternalDependsOn []string
}

type DependencyReplacement struct {
	TaskID    string
	DependsOn []string
}

func (s *Store) WriteProject(ctx context.Context, projectID string, operation func(*ProjectTx) error) error {
	tx, err := s.Pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.ReadCommitted})
	if err != nil {
		return queryError("begin project write", err)
	}
	err = transact(ctx, tx, func(tx pgx.Tx) error {
		var id string
		if err := tx.QueryRow(ctx, `SELECT id::text FROM projects WHERE id = $1 FOR UPDATE`, projectID).Scan(&id); err != nil {
			return queryError("lock project", err)
		}
		return operation(&ProjectTx{tx: tx, projectID: projectID})
	})
	if err != nil {
		return queryError("project write", err)
	}
	return nil
}

func (tx *ProjectTx) Task(ctx context.Context, id string) (core.Task, error) {
	return readTask(ctx, tx.tx, tx.projectID, id)
}

func (tx *ProjectTx) TasksByID(ctx context.Context, ids []string) ([]core.Task, error) {
	return tx.tasks(ctx, `t.id = ANY($2::uuid[])`, ids, "read prerequisites")
}

func (tx *ProjectTx) tasks(ctx context.Context, condition string, value any, phase string) ([]core.Task, error) {
	rows, err := tx.tx.Query(ctx, `SELECT `+taskProjection+` FROM tasks t
		WHERE t.project_id = $1 AND t.deleted_at IS NULL AND `+condition+` ORDER BY t.id`, tx.projectID, value)
	if err != nil {
		return nil, queryError(phase, err)
	}
	tasks, err := collectTasks(rows)
	if err != nil {
		return nil, queryError(phase, err)
	}
	return tasks, nil
}

func (tx *ProjectTx) ActiveDependentIDs(ctx context.Context, id string) ([]string, error) {
	rows, err := tx.tx.Query(ctx, `SELECT t.id::text FROM task_dependencies d
		JOIN tasks t ON t.project_id = d.project_id AND t.id = d.task_id
		WHERE d.project_id = $1 AND d.depends_on_task_id = $2
		AND t.deleted_at IS NULL AND t.status IN ('in_progress', 'done') ORDER BY t.id`, tx.projectID, id)
	if err != nil {
		return nil, queryError("read active dependents", err)
	}
	defer rows.Close()
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, queryError("read active dependents", err)
	}
	return ids, nil
}

func (tx *ProjectTx) Reachable(ctx context.Context, from, to string, replacement DependencyReplacement) (bool, error) {
	var reachable bool
	err := tx.tx.QueryRow(ctx, `WITH RECURSIVE edges(task_id, depends_on_task_id) AS (
		SELECT d.task_id, d.depends_on_task_id FROM task_dependencies d
		JOIN tasks t ON t.project_id = d.project_id AND t.id = d.task_id
		WHERE d.project_id = $1 AND t.deleted_at IS NULL AND d.task_id <> $4::uuid
		UNION SELECT $4::uuid, unnest($5::uuid[])
	), visited(id) AS (
		SELECT $2::uuid
		UNION SELECT e.depends_on_task_id FROM edges e JOIN visited v ON e.task_id = v.id
	) SELECT EXISTS(SELECT 1 FROM visited WHERE id = $3::uuid)`,
		tx.projectID, from, to, replacement.TaskID, replacement.DependsOn).Scan(&reachable)
	if err != nil {
		return false, queryError("candidate reachability", err)
	}
	return reachable, nil
}

func (tx *ProjectTx) CreateTask(ctx context.Context, id string, values TaskWrite) (core.Task, error) {
	_, err := tx.tx.Exec(ctx, `INSERT INTO tasks (id, project_id, title, description, status, properties, allow_agents, required_platform)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, id, tx.projectID, values.Title, values.Description, values.Status, taskproperties.Encode(values.Properties), values.AllowAgents, values.RequiredPlatform)
	if err != nil {
		return core.Task{}, queryError("create task", err)
	}
	if err := tx.insertDependencies(ctx, id, values.DependsOn, values.ExternalDependsOn); err != nil {
		return core.Task{}, err
	}
	return tx.Task(ctx, id)
}

func (tx *ProjectTx) UpdateTask(ctx context.Context, id string, values TaskWrite) (core.Task, error) {
	result, err := tx.tx.Exec(ctx, `UPDATE tasks SET title = $3, description = $4, status = $5, properties = $6, allow_agents = $7, required_platform = $8,
		started_at = CASE
			WHEN status <> $5 AND $5 = 'in_progress' THEN statement_timestamp()
			WHEN status <> $5 AND $5 = 'todo' THEN NULL
			WHEN status = 'todo' AND $5 = 'done' THEN NULL
			ELSE started_at END,
		completed_at = CASE
			WHEN status <> $5 AND $5 = 'done' THEN statement_timestamp()
			WHEN status <> $5 AND $5 IN ('todo', 'in_progress') THEN NULL
			ELSE completed_at END,
		version = version + 1, updated_at = statement_timestamp() WHERE project_id = $1 AND id = $2`,
		tx.projectID, id, values.Title, values.Description, values.Status, taskproperties.Encode(values.Properties), values.AllowAgents, values.RequiredPlatform)
	if err != nil {
		return core.Task{}, queryError("update task", err)
	}
	if result.RowsAffected() == 0 {
		return core.Task{}, queryError("update task", core.ErrNotFound)
	}
	var activeClaim *string
	if worker := values.Properties.Worker; values.Status == core.TaskInProgress && worker != nil && worker.State == core.WorkerActive && worker.AgentControlMode == core.AgentControlModeWeb {
		activeClaim = &worker.ClaimID
	}
	if err := tx.freezeTaskSessions(ctx, id, activeClaim); err != nil {
		return core.Task{}, err
	}
	if _, err := tx.tx.Exec(ctx, `DELETE FROM task_dependencies WHERE project_id = $1 AND task_id = $2`, tx.projectID, id); err != nil {
		return core.Task{}, queryError("replace dependencies", err)
	}
	if err := tx.insertDependencies(ctx, id, values.DependsOn, values.ExternalDependsOn); err != nil {
		return core.Task{}, err
	}
	return tx.Task(ctx, id)
}

func (tx *ProjectTx) insertDependencies(ctx context.Context, id string, dependencies, externalDependencies []string) error {
	for _, dependency := range dependencies {
		if _, err := tx.tx.Exec(ctx, `INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id, external)
			VALUES ($1, $2, $3, $4)`, tx.projectID, id, dependency, slices.Contains(externalDependencies, dependency)); err != nil {
			return queryError("insert dependency", err)
		}
	}
	return nil
}

func (tx *ProjectTx) ObservedAt(ctx context.Context) (time.Time, error) {
	var observed time.Time
	if err := tx.tx.QueryRow(ctx, "SELECT statement_timestamp()").Scan(&observed); err != nil {
		return time.Time{}, queryError("read project clock", err)
	}
	return observed.UTC(), nil
}

func (tx *ProjectTx) DependentIDs(ctx context.Context, id string) ([]string, error) {
	rows, err := tx.tx.Query(ctx, `SELECT t.id::text FROM task_dependencies d
		JOIN tasks t ON t.project_id = d.project_id AND t.id = d.task_id
		WHERE d.project_id = $1 AND d.depends_on_task_id = $2
		AND t.deleted_at IS NULL ORDER BY t.id`, tx.projectID, id)
	if err != nil {
		return nil, queryError("read dependents", err)
	}
	defer rows.Close()
	ids, err := pgx.CollectRows(rows, pgx.RowTo[string])
	if err != nil {
		return nil, queryError("read dependents", err)
	}
	return ids, nil
}

func (tx *ProjectTx) DeleteTask(ctx context.Context, id string, removeDepends bool) error {
	if removeDepends {
		if _, err := tx.tx.Exec(ctx, `WITH removed AS (
			DELETE FROM task_dependencies WHERE project_id = $1 AND depends_on_task_id = $2
			RETURNING task_id
		) UPDATE tasks SET version = version + 1, updated_at = statement_timestamp()
		WHERE project_id = $1 AND id IN (SELECT task_id FROM removed)`, tx.projectID, id); err != nil {
			return queryError("remove dependent relationships", err)
		}
	}
	result, err := tx.tx.Exec(ctx, `UPDATE tasks SET deleted_at = statement_timestamp(),
		updated_at = statement_timestamp(), version = version + 1
		WHERE project_id = $1 AND id = $2 AND deleted_at IS NULL`, tx.projectID, id)
	if err != nil {
		return queryError("delete task", err)
	}
	if result.RowsAffected() == 0 {
		return queryError("delete task", core.ErrNotFound)
	}
	if err := tx.freezeTaskSessions(ctx, id, nil); err != nil {
		return err
	}
	if _, err := tx.tx.Exec(ctx, `UPDATE projects SET task_cache_epoch = gen_random_uuid() WHERE id = $1`, tx.projectID); err != nil {
		return queryError("invalidate deleted task cache", err)
	}
	return nil
}

// Claim transitions and relay freezing share the task transaction. Stream
// writes lock the task before the session, so no command can cross this fence.
func (tx *ProjectTx) freezeTaskSessions(ctx context.Context, taskID string, activeClaim *string) error {
	_, err := tx.tx.Exec(ctx, `WITH frozen AS (
		UPDATE task_sessions SET draining_until=statement_timestamp()+interval '60 seconds',
 draining_timeline_seq=(snapshot->>'lastTimelineSeq')::bigint,
		snapshot=(snapshot - 'cleanupInteractionIds') || jsonb_build_object('lifecycle','draining',
		 'sessionRevision',((snapshot->>'sessionRevision')::bigint+1)::text,
		 'lastEventSeq',((snapshot->>'lastEventSeq')::bigint+1)::text,
		 'operations',jsonb_build_object('canSend',false,'canCancel',false,'canRespond',false))
		WHERE project_id=$1 AND task_id=$2 AND snapshot->>'lifecycle'='active'
		AND ($3::uuid IS NULL OR claim_id<>$3::uuid) RETURNING id,snapshot
	) INSERT INTO session_events(session_id,event_seq,event)
	SELECT id,(snapshot->>'lastEventSeq')::bigint,jsonb_build_object(
	 'protocol','daynight.session.v1','sessionId',id::text,'claimId',snapshot->>'claimId',
	 'executionGeneration',snapshot->>'executionGeneration','connectionEpoch',snapshot->>'connectionEpoch',
	 'eventSeq',snapshot->>'lastEventSeq','historyEpoch',snapshot->>'historyEpoch','kind','snapshot','payload',snapshot)
	FROM frozen`, tx.projectID, taskID, activeClaim)
	if err != nil {
		return queryError("freeze task sessions", err)
	}
	// Inputs that never crossed the offered boundary are safely rejected. Already
	// offered inputs retain their real receipts and drain through the controller.
	_, err = tx.tx.Exec(ctx, `WITH rejected AS (
	 UPDATE session_operations o SET receipt=receipt || jsonb_build_object('state','rejected',
	 'error',jsonb_build_object('code','claim_ended','message','The claim ended before this operation was offered.'))
	 WHERE receipt->>'state'='accepted' AND session_id IN
	 (SELECT id FROM task_sessions WHERE project_id=$1 AND task_id=$2 AND snapshot->>'lifecycle'='draining')
	 RETURNING session_id,operation_id,receipt
	), numbered AS (
	 SELECT session_id,receipt,row_number() OVER(PARTITION BY session_id ORDER BY operation_id) AS offset FROM rejected
	), appended AS (
	 INSERT INTO session_events(session_id,event_seq,event)
	 SELECT n.session_id,(s.snapshot->>'lastEventSeq')::bigint+n.offset,jsonb_build_object(
	 'protocol','daynight.session.v1','sessionId',n.session_id::text,'claimId',n.receipt->>'claimId',
	 'executionGeneration',n.receipt->>'executionGeneration','connectionEpoch',s.snapshot->>'connectionEpoch',
	 'eventSeq',((s.snapshot->>'lastEventSeq')::bigint+n.offset)::text,'historyEpoch',s.snapshot->>'historyEpoch',
	 'kind','operation','payload',n.receipt)
	 FROM numbered n JOIN task_sessions s ON s.id=n.session_id RETURNING session_id
	), counts AS (SELECT session_id,count(*) AS total FROM appended GROUP BY session_id)
	 UPDATE task_sessions s SET snapshot=jsonb_set(snapshot,'{lastEventSeq}',to_jsonb(((snapshot->>'lastEventSeq')::bigint+c.total)::text))
	 FROM counts c WHERE s.id=c.session_id`, tx.projectID, taskID)
	if err != nil {
		return queryError("reject undispatched session operations", err)
	}
	return nil
}

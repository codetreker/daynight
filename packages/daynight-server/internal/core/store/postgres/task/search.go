package task

import (
	"context"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/tag"
	"github.com/jackc/pgx/v5"
)

type searchSnapshot struct{ tx pgx.Tx }

func NewSearchSnapshot(tx pgx.Tx) store.TaskSearchSnapshot { return &searchSnapshot{tx: tx} }

var _ store.TaskSearchSnapshot = (*searchSnapshot)(nil)

func (s *searchSnapshot) ProjectAccess(ctx context.Context, principal model.Principal, projectID string) (model.ProjectAccess, error) {
	return pg.ReadProjectAccess(ctx, s.tx, principal.UserID, projectID)
}

func (s *searchSnapshot) ResolveTags(ctx context.Context, projectID string, ids []string) ([]model.Tag, error) {
	return tag.NewReader(s.tx).ResolveTags(ctx, projectID, ids)
}

func searchError(phase string, err error) error {
	return pg.QueryError(phase, err)
}

func (s *searchSnapshot) Fence(ctx context.Context, projectID string) (store.TaskSearchFence, error) {
	var fence store.TaskSearchFence
	err := s.tx.QueryRow(ctx, `SELECT p.task_cache_epoch::text, count(t.id)::text,
 COALESCE(sum(t.version::numeric), 0)::text FROM projects p
 LEFT JOIN tasks t ON t.project_id=p.id WHERE p.id=$1 GROUP BY p.task_cache_epoch`, projectID).
		Scan(&fence.Epoch, &fence.Count, &fence.VersionSum)
	if err != nil {
		return store.TaskSearchFence{}, searchError("read task search fence", err)
	}
	return fence, nil
}

// Keep live-task lookup dependent on the neighbor: without this barrier stale
// statistics can place a full project scan outside the recursive traversal.
const searchClosure = `WITH RECURSIVE chain(id) AS (
 SELECT id FROM task_resource_rows WHERE project_id=$1 AND id=ANY($2::uuid[]) AND type='task' AND effective_deleted_at IS NULL
 UNION
 SELECT neighbor.id FROM chain member
 CROSS JOIN LATERAL (
  SELECT depends_on_task_id AS id FROM task_dependencies WHERE project_id=$1 AND task_id=member.id AND NOT external
  UNION
  SELECT task_id AS id FROM task_dependencies WHERE project_id=$1 AND depends_on_task_id=member.id AND NOT external
 ) neighbor
 JOIN LATERAL (SELECT id FROM task_resource_rows WHERE project_id=$1 AND id=neighbor.id AND type='task' AND effective_deleted_at IS NULL OFFSET 0) live ON true
) `

func (s *searchSnapshot) ContextGraph(ctx context.Context, projectID string, ids []string) (store.TaskSearchGraph, error) {
	graph := store.TaskSearchGraph{Nodes: []store.TaskSearchNode{}, Edges: []store.TaskSearchEdge{}}
	rows, err := s.tx.Query(ctx, searchClosure+`SELECT t.id::text, t.created_at FROM chain JOIN tasks t ON t.id=chain.id AND t.project_id=$1`, projectID, ids)
	if err != nil {
		return graph, searchError("read task search context nodes", err)
	}
	for rows.Next() {
		var node store.TaskSearchNode
		if err := rows.Scan(&node.ID, &node.CreatedAt); err != nil {
			rows.Close()
			return graph, searchError("read task search context nodes", err)
		}
		node.CreatedAt = node.CreatedAt.UTC()
		graph.Nodes = append(graph.Nodes, node)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return graph, searchError("read task search context nodes", err)
	}
	rows, err = s.tx.Query(ctx, searchClosure+`SELECT d.task_id::text, d.depends_on_task_id::text
 FROM task_dependencies d JOIN chain a ON a.id=d.task_id JOIN chain b ON b.id=d.depends_on_task_id
 WHERE d.project_id=$1 AND NOT d.external`, projectID, ids)
	if err != nil {
		return graph, searchError("read task search context edges", err)
	}
	defer rows.Close()
	for rows.Next() {
		var edge store.TaskSearchEdge
		if err := rows.Scan(&edge.TaskID, &edge.DependsOnID); err != nil {
			return graph, searchError("read task search context edges", err)
		}
		graph.Edges = append(graph.Edges, edge)
	}
	if err := rows.Err(); err != nil {
		return graph, searchError("read task search context edges", err)
	}
	return graph, nil
}

func (s *searchSnapshot) Titles(ctx context.Context, projectID string, ids []string) (map[string]string, error) {
	rows, err := s.tx.Query(ctx, `SELECT id::text,title FROM task_resource_rows WHERE project_id=$1 AND type='goal' AND effective_deleted_at IS NULL AND id=ANY($2::uuid[])`, projectID, ids)
	if err != nil {
		return nil, searchError("read task search titles", err)
	}
	defer rows.Close()
	titles := make(map[string]string, len(ids))
	for rows.Next() {
		var id string
		var title string
		if err := rows.Scan(&id, &title); err != nil {
			return nil, searchError("read task search titles", err)
		}
		titles[id] = title
	}
	if err := rows.Err(); err != nil {
		return nil, searchError("read task search titles", err)
	}

	return titles, nil
}

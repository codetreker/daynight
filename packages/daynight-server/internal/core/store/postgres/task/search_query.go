package task

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/tasksearch/query"
)

type atomKey struct {
	field query.Field
	term  string
}
type sqlCompiler struct {
	atoms              map[atomKey]int
	ordered            []atomKey
	title, description bool
}

func (c *sqlCompiler) collect(n *query.Node) error {
	if n == nil {
		return fmt.Errorf("missing search expression")
	}
	switch n.Kind {
	case query.Leaf:
		if n.Atom.Term == "" || n.Atom.Field > query.DescriptionField {
			return fmt.Errorf("invalid search atom")
		}
		key := atomKey{n.Atom.Field, n.Atom.Term}
		if _, ok := c.atoms[key]; !ok {
			c.atoms[key] = len(c.ordered)
			c.ordered = append(c.ordered, key)
		}
		c.title = c.title || n.Atom.Field != query.DescriptionField
		c.description = c.description || n.Atom.Field != query.TitleField
		return nil
	case query.And, query.Or:
		if err := c.collect(n.Left); err != nil {
			return err
		}
		return c.collect(n.Right)
	default:
		return fmt.Errorf("invalid search expression")
	}
}

// expression returns truth and positive title evidence, both over materialized hits.
func (c *sqlCompiler) expression(n *query.Node) (string, string) {
	if n.Kind == query.Leaf {
		index := c.atoms[atomKey{n.Atom.Field, n.Atom.Term}]
		t, d := fmt.Sprintf("h.t%d", index), fmt.Sprintf("h.d%d", index)
		match := t
		if n.Atom.Field == query.DescriptionField {
			match = d
		} else if n.Atom.Field == query.AnyField {
			match = "(" + t + " OR " + d + ")"
		}
		if n.Negated {
			return "(NOT " + match + ")", "false"
		}
		if n.Atom.Field == query.DescriptionField {
			return match, "false"
		}
		return match, t
	}
	lm, lp := c.expression(n.Left)
	rm, rp := c.expression(n.Right)
	if n.Kind == query.And {
		match := "(" + lm + " AND " + rm + ")"
		return match, "(" + match + " AND (" + lp + " OR " + rp + "))"
	}
	return "(" + lm + " OR " + rm + ")", "(" + lp + " OR " + rp + ")"
}

func (s *searchSnapshot) Matches(ctx context.Context, projectID string, input store.TaskSearchQuery) (store.TaskSearchPage, error) {
	c := sqlCompiler{atoms: make(map[atomKey]int)}
	if err := c.collect(input.Expression); err != nil {
		return store.TaskSearchPage{}, err
	}
	if input.Limit < 1 || input.Limit > 100 {
		return store.TaskSearchPage{}, fmt.Errorf("invalid task search limit")
	}
	var afterPriority, afterTime, afterID any
	if input.After != nil {
		afterPriority, afterTime, afterID = input.After.TitlePriority, input.After.UpdatedAt, input.After.ID
	}
	var assignee any
	if input.AssignedTo.Mode == model.TaskAssignmentUser {
		assignee = input.AssignedTo.UserID
	}
	if input.AssignedTo.Mode != model.TaskAssignmentAll && input.AssignedTo.Mode != model.TaskAssignmentUnassigned && input.AssignedTo.Mode != model.TaskAssignmentUser {
		return store.TaskSearchPage{}, fmt.Errorf("invalid task search assignee")
	}
	args := []any{projectID, input.Status, input.Ready, input.AllowAgents, input.CompatiblePlatform, string(input.AssignedTo.Mode), assignee, afterPriority, afterTime, afterID, input.Limit + 1}
	folded := []string{"t.id", "t.updated_at"}
	if c.title {
		folded = append(folded, `lower(t.title COLLATE "C") AS title_folded`)
	}
	if c.description {
		folded = append(folded, `lower(t.description COLLATE "C") AS description_folded`)
	}
	hits := []string{"f.id", "f.updated_at"}
	for i, atom := range c.ordered {
		titleHit, descriptionHit := "false", "false"
		// PostgreSQL text cannot contain NUL, so no stored field can contain it.
		if !strings.ContainsRune(atom.term, '\x00') {
			args = append(args, atom.term)
			placeholder := fmt.Sprintf("$%d", len(args))
			titleHit = fmt.Sprintf("(strpos(f.title_folded, %s)>0)", placeholder)
			descriptionHit = fmt.Sprintf("(strpos(f.description_folded, %s)>0)", placeholder)
		}
		if atom.field != query.DescriptionField {
			hits = append(hits, fmt.Sprintf("%s AS t%d", titleHit, i))
		}
		if atom.field != query.TitleField {
			hits = append(hits, fmt.Sprintf("%s AS d%d", descriptionHit, i))
		}
	}
	match, priority := c.expression(input.Expression)
	sql := `WITH folded AS MATERIALIZED (SELECT ` + strings.Join(folded, ", ") + ` FROM tasks t
 WHERE t.project_id=$1 AND t.deleted_at IS NULL AND ($2::text IS NULL OR t.status=$2)
 AND ($3::boolean IS NULL OR (t.status='todo' AND NOT EXISTS (
 SELECT 1 FROM task_dependencies d WHERE d.project_id=t.project_id AND d.task_id=t.id
 AND NOT EXISTS (SELECT 1 FROM tasks p WHERE p.project_id=d.project_id AND p.id=d.depends_on_task_id AND p.status='done')))=$3)
 AND ($4::boolean IS NULL OR t.allow_agents=$4)
 AND ($5::text IS NULL OR t.required_platform IS NULL OR t.required_platform=$5)
 AND ($6::text='' OR ($6='unassigned' AND t.assigned_to IS NULL) OR ($6='user' AND t.assigned_to=$7::uuid))),
 atom_hits AS MATERIALIZED (SELECT ` + strings.Join(hits, ", ") + ` FROM folded f),
 matched AS MATERIALIZED (SELECT h.id,h.updated_at,` + priority + ` AS title_priority FROM atom_hits h WHERE ` + match + `),
 total AS (SELECT count(*) AS total FROM matched),
 page AS (SELECT * FROM matched WHERE $8::boolean IS NULL OR title_priority < $8 OR
 (title_priority=$8 AND (updated_at < $9::timestamptz OR (updated_at=$9 AND id > $10::uuid)))
 ORDER BY title_priority DESC,updated_at DESC,id ASC LIMIT $11)
 SELECT total.total,t.id::text,t.title,t.description,t.status,t.assigned_to::text,p.updated_at,p.title_priority
 FROM total LEFT JOIN page p ON true LEFT JOIN tasks t ON t.id=p.id AND t.project_id=$1
 ORDER BY p.title_priority DESC,p.updated_at DESC,p.id ASC`
	rows, err := s.tx.Query(ctx, sql, args...)
	if err != nil {
		return store.TaskSearchPage{}, searchError("query task search", err)
	}
	defer rows.Close()
	result := store.TaskSearchPage{Items: []store.TaskSearchRow{}}
	for rows.Next() {
		var id, title, description, status *string
		var assigned *string
		var updated *time.Time
		var titlePriority *bool
		if err := rows.Scan(&result.Total, &id, &title, &description, &status, &assigned, &updated, &titlePriority); err != nil {
			return store.TaskSearchPage{}, searchError("read task search", err)
		}
		if id == nil {
			continue
		}
		if title == nil || description == nil || status == nil || updated == nil || titlePriority == nil {
			return store.TaskSearchPage{}, fmt.Errorf("incomplete task search row")
		}
		row := store.TaskSearchRow{ID: *id, Title: *title, Description: *description, Status: model.TaskStatus(*status), AssignedTo: assigned, UpdatedAt: updated.UTC(), TitlePriority: *titlePriority}
		if !row.Status.Valid() {
			return store.TaskSearchPage{}, fmt.Errorf("invalid task search status")
		}
		result.Items = append(result.Items, row)
	}
	if err := rows.Err(); err != nil {
		return store.TaskSearchPage{}, searchError("read task search", err)
	}
	if len(result.Items) > input.Limit {
		result.HasMore = true
		result.Items = result.Items[:input.Limit]
	}
	return result, nil
}

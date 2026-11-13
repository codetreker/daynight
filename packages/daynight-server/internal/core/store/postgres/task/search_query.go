package task

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/tasksearch"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
	pg "github.com/codetreker/daynight/packages/daynight-server/internal/core/store/postgres/internal"
)

type atomKey struct {
	field tasksearch.Field
	term  string
}
type sqlCompiler struct {
	atoms                  map[atomKey]int
	ordered                []atomKey
	id, title, description bool
}

func (c *sqlCompiler) collect(n *tasksearch.Node) error {
	if n == nil {
		return fmt.Errorf("missing search expression")
	}
	switch n.Kind {
	case tasksearch.Leaf:
		if n.Atom.Term == "" || !n.Atom.Field.Valid() {
			return fmt.Errorf("invalid search atom")
		}
		key := atomKey{n.Atom.Field, n.Atom.Term}
		if _, ok := c.atoms[key]; !ok {
			c.atoms[key] = len(c.ordered)
			c.ordered = append(c.ordered, key)
		}
		c.id = c.id || n.Atom.Field.Includes(tasksearch.IDField)
		c.title = c.title || n.Atom.Field.Includes(tasksearch.TitleField)
		c.description = c.description || n.Atom.Field.Includes(tasksearch.DescriptionField)
		return nil
	case tasksearch.And, tasksearch.Or:
		if err := c.collect(n.Left); err != nil {
			return err
		}
		return c.collect(n.Right)
	default:
		return fmt.Errorf("invalid search expression")
	}
}

type sqlEvidence struct{ matches, titlePriority, exactIDPriority string }

// expression reduces truth and positive ranking evidence over materialized hits.
func (c *sqlCompiler) expression(n *tasksearch.Node) sqlEvidence {
	if n.Kind == tasksearch.Leaf {
		i := c.atoms[atomKey{n.Atom.Field, n.Atom.Term}]
		match := fmt.Sprintf("(h.i%d OR h.t%d OR h.d%d)", i, i, i)
		if n.Negated {
			return sqlEvidence{"(NOT " + match + ")", "false", "false"}
		}
		return sqlEvidence{match, fmt.Sprintf("h.t%d", i), fmt.Sprintf("h.e%d", i)}
	}
	l, r := c.expression(n.Left), c.expression(n.Right)
	if n.Kind == tasksearch.And {
		m := "(" + l.matches + " AND " + r.matches + ")"
		return sqlEvidence{m, "(" + m + " AND (" + l.titlePriority + " OR " + r.titlePriority + "))", "(" + m + " AND (" + l.exactIDPriority + " OR " + r.exactIDPriority + "))"}
	}
	return sqlEvidence{"(" + l.matches + " OR " + r.matches + ")", "(" + l.titlePriority + " OR " + r.titlePriority + ")", "(" + l.exactIDPriority + " OR " + r.exactIDPriority + ")"}
}

func (s *searchSnapshot) Matches(ctx context.Context, projectID string, input store.TaskSearchQuery) (store.TaskSearchPage, error) {
	result := store.TaskSearchPage{Items: []store.TaskSearchRow{}}
	c := sqlCompiler{atoms: make(map[atomKey]int)}
	if err := c.collect(input.Expression); err != nil {
		return store.TaskSearchPage{}, err
	}
	if input.Limit < 1 || input.Limit > 100 {
		return store.TaskSearchPage{}, fmt.Errorf("invalid task search limit")
	}
	var afterExact, afterPriority, afterTime, afterID any
	if input.After != nil {
		afterExact, afterPriority, afterTime, afterID = input.After.ExactIDPriority, input.After.TitlePriority, input.After.UpdatedAt, input.After.ID
	}
	var assignee any
	if input.AssignedTo.Mode == model.TaskAssignmentUser {
		assignee = input.AssignedTo.UserID
	}
	if input.AssignedTo.Mode != model.TaskAssignmentAll && input.AssignedTo.Mode != model.TaskAssignmentUnassigned && input.AssignedTo.Mode != model.TaskAssignmentUser {
		return store.TaskSearchPage{}, fmt.Errorf("invalid task search assignee")
	}
	args := []any{projectID, input.Status, input.Ready, input.AllowAgents, input.CompatiblePlatform, string(input.AssignedTo.Mode), assignee, afterExact, afterPriority, afterTime, afterID, input.Limit + 1}
	resourceFilter, err := taskResourceFilter(input.Type, input.Parent, &args)
	if err != nil {
		return store.TaskSearchPage{}, searchError("query task search", err)
	}
	tagFilter, err := taskTagFilter(input.TagFilter, &args)
	if err != nil {
		return store.TaskSearchPage{}, searchError("query task search", err)
	}
	folded := []string{"t.id", "t.updated_at"}
	if c.id {
		folded = append(folded, `t.id::text AS id_text`)
	}
	if c.title {
		folded = append(folded, `lower(t.title COLLATE "C") AS title_folded`)
	}
	if c.description {
		folded = append(folded, `lower(t.description COLLATE "C") AS description_folded`)
	}
	hits := []string{"f.id", "f.updated_at"}

	for i, atom := range c.ordered {
		idHit, exactHit, titleHit, descriptionHit := "false", "false", "false", "false"
		if !strings.ContainsRune(atom.term, '\x00') {
			args = append(args, atom.term)
			placeholder := fmt.Sprintf("$%d", len(args))
			if atom.field.Includes(tasksearch.IDField) {
				idHit = fmt.Sprintf("(strpos(f.id_text, %s)>0)", placeholder)
				exactHit = fmt.Sprintf("(f.id_text=%s)", placeholder)
			}
			if atom.field.Includes(tasksearch.TitleField) {
				titleHit = fmt.Sprintf("(strpos(f.title_folded, %s)>0)", placeholder)
			}
			if atom.field.Includes(tasksearch.DescriptionField) {
				descriptionHit = fmt.Sprintf("(strpos(f.description_folded, %s)>0)", placeholder)
			}
		}
		hits = append(hits, fmt.Sprintf("%s AS i%d", idHit, i), fmt.Sprintf("%s AS e%d", exactHit, i), fmt.Sprintf("%s AS t%d", titleHit, i), fmt.Sprintf("%s AS d%d", descriptionHit, i))
	}
	expr := c.expression(input.Expression)
	sql := `WITH folded AS MATERIALIZED (SELECT ` + strings.Join(folded, ", ") + ` FROM task_resource_rows t
 WHERE t.project_id=$1 AND t.effective_deleted_at IS NULL AND ($2::text IS NULL OR t.status=$2)
 AND ($3::boolean IS NULL OR ` + pg.TaskReady + `=$3)
 AND ($4::boolean IS NULL OR t.allow_agents=$4)
 AND ($5::text IS NULL OR t.required_platform IS NULL OR t.required_platform=$5)
 AND ($6::text='' OR ($6='unassigned' AND t.assigned_to IS NULL) OR ($6='user' AND t.assigned_to=$7::uuid))` + resourceFilter + tagFilter + `),
 atom_hits AS MATERIALIZED (SELECT ` + strings.Join(hits, ", ") + ` FROM folded f),
 matched AS MATERIALIZED (SELECT h.id,h.updated_at,` + expr.exactIDPriority + ` AS exact_id_priority,` + expr.titlePriority + ` AS title_priority FROM atom_hits h WHERE ` + expr.matches + `),
 total AS (SELECT count(*) AS total FROM matched),
 page AS (SELECT * FROM matched WHERE $8::boolean IS NULL OR exact_id_priority < $8 OR
 (exact_id_priority=$8 AND (title_priority < $9::boolean OR (title_priority=$9 AND (updated_at < $10::timestamptz OR (updated_at=$10 AND id > $11::uuid)))))
 ORDER BY exact_id_priority DESC,title_priority DESC,updated_at DESC,id ASC LIMIT $12)
 SELECT total.total,t.id::text,t.type,t.parent_id::text,t.title,t.description,t.status,t.assigned_to::text,t.cancelled_at,p.updated_at,p.exact_id_priority,p.title_priority
 FROM total LEFT JOIN page p ON true LEFT JOIN tasks t ON t.id=p.id AND t.project_id=$1
 ORDER BY p.exact_id_priority DESC,p.title_priority DESC,p.updated_at DESC,p.id ASC`
	rows, err := s.tx.Query(ctx, sql, args...)
	if err != nil {
		return store.TaskSearchPage{}, searchError("query task search", err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, taskType, parentID, title, description, status *string
		var assigned *string
		var updated, cancelled *time.Time
		var exactPriority, titlePriority *bool
		if err := rows.Scan(&result.Total, &id, &taskType, &parentID, &title, &description, &status, &assigned, &cancelled, &updated, &exactPriority, &titlePriority); err != nil {
			return store.TaskSearchPage{}, searchError("read task search", err)
		}
		if id == nil {
			continue
		}
		if len(result.Items) == input.Limit {
			result.HasMore = true
			break
		}
		result.Items = append(result.Items, store.TaskSearchRow{ID: *id, Type: model.TaskType(*taskType), ParentID: parentID, Title: *title, Description: *description, Status: model.TaskStatus(*status), AssignedTo: assigned, CancelledAt: pg.UTCTime(cancelled), UpdatedAt: updated.UTC(), ExactIDPriority: *exactPriority, TitlePriority: *titlePriority})
	}
	if err := rows.Err(); err != nil {
		return store.TaskSearchPage{}, searchError("read task search", err)
	}
	rows.Close()
	ids := make([]string, len(result.Items))
	for i := range result.Items {
		ids[i] = result.Items[i].ID
	}
	tags, err := pg.LoadTaskTagsBatch(ctx, s.tx, projectID, ids)
	if err != nil {
		return store.TaskSearchPage{}, err
	}
	for i := range result.Items {
		result.Items[i].Tags = tags[result.Items[i].ID]
	}
	return result, nil
}

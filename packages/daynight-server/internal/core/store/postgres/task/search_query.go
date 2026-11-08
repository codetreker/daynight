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
	atoms              map[atomKey]int
	ordered            []atomKey
	title, description bool
}

func (c *sqlCompiler) collect(n *tasksearch.Node) error {
	if n == nil {
		return fmt.Errorf("missing search expression")
	}
	switch n.Kind {
	case tasksearch.Leaf:
		if n.Atom.Term == "" || n.Atom.Field > tasksearch.DescriptionField {
			return fmt.Errorf("invalid search atom")
		}
		key := atomKey{n.Atom.Field, n.Atom.Term}
		if _, ok := c.atoms[key]; !ok {
			c.atoms[key] = len(c.ordered)
			c.ordered = append(c.ordered, key)
		}
		c.title = c.title || n.Atom.Field != tasksearch.DescriptionField
		c.description = c.description || n.Atom.Field != tasksearch.TitleField
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

// expression returns truth and positive title evidence, both over materialized hits.
func (c *sqlCompiler) expression(n *tasksearch.Node) (string, string) {
	if n.Kind == tasksearch.Leaf {
		index := c.atoms[atomKey{n.Atom.Field, n.Atom.Term}]
		t, d := fmt.Sprintf("h.t%d", index), fmt.Sprintf("h.d%d", index)
		match := t
		if n.Atom.Field == tasksearch.DescriptionField {
			match = d
		} else if n.Atom.Field == tasksearch.AnyField {
			match = "(" + t + " OR " + d + ")"
		}
		if n.Negated {
			return "(NOT " + match + ")", "false"
		}
		if n.Atom.Field == tasksearch.DescriptionField {
			return match, "false"
		}
		return match, t
	}
	lm, lp := c.expression(n.Left)
	rm, rp := c.expression(n.Right)
	if n.Kind == tasksearch.And {
		match := "(" + lm + " AND " + rm + ")"
		return match, "(" + match + " AND (" + lp + " OR " + rp + "))"
	}
	return "(" + lm + " OR " + rm + ")", "(" + lp + " OR " + rp + ")"
}

func (s *searchSnapshot) Matches(ctx context.Context, projectID string, input store.TaskSearchQuery) (store.TaskSearchPage, error) {
	result := store.TaskSearchPage{Items: []store.TaskSearchRow{}}
	total, more, err := s.MatchesEach(ctx, projectID, input, func(_ int64, row store.TaskSearchRow) (bool, error) {
		result.Items = append(result.Items, row)
		return true, nil
	})
	if err != nil {
		return store.TaskSearchPage{}, err
	}
	result.Total, result.HasMore = total, more
	return result, nil
}

func (s *searchSnapshot) MatchesEach(ctx context.Context, projectID string, input store.TaskSearchQuery, accept func(int64, store.TaskSearchRow) (bool, error)) (int64, bool, error) {
	c := sqlCompiler{atoms: make(map[atomKey]int)}
	if err := c.collect(input.Expression); err != nil {
		return 0, false, err
	}
	if input.Limit < 1 || input.Limit > 100 {
		return 0, false, fmt.Errorf("invalid task search limit")
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
		return 0, false, fmt.Errorf("invalid task search assignee")
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
	var titleHits, positions, snippets []string
	for i, atom := range c.ordered {
		titleHit, descriptionHit, descriptionPosition := "false", "false", "0"
		// PostgreSQL text cannot contain NUL, so no stored field can contain it.
		if !strings.ContainsRune(atom.term, '\x00') {
			args = append(args, atom.term)
			placeholder := fmt.Sprintf("$%d", len(args))
			titleHit = fmt.Sprintf("(strpos(f.title_folded, %s)>0)", placeholder)
			descriptionPosition = fmt.Sprintf("strpos(f.description_folded, %s)", placeholder)
			descriptionHit = "(" + descriptionPosition + ">0)"
		}
		if atom.field != tasksearch.DescriptionField {
			hits = append(hits, fmt.Sprintf("%s AS t%d", titleHit, i))
		}
		if atom.field != tasksearch.TitleField {
			hits = append(hits, fmt.Sprintf("%s AS d%d", descriptionHit, i))
			hits = append(hits, fmt.Sprintf("%s AS p%d", descriptionPosition, i))
			positions = append(positions, fmt.Sprintf("h.p%d", i))
		} else {
			positions = append(positions, "0")
		}
		if atom.field != tasksearch.DescriptionField {
			titleHits = append(titleHits, fmt.Sprintf("h.t%d", i))
		} else {
			titleHits = append(titleHits, "false")
		}
		pos := fmt.Sprintf("p.positions[%d]", i+1)
		start := "GREATEST(1, LEAST(" + pos + "-80, GREATEST(char_length(t.description)-159, 1)))"
		snippets = append(snippets, "CASE WHEN p.page_index > $11 - 1 OR "+pos+"=0 THEN NULL ELSE "+
			"(CASE WHEN "+start+">1 THEN '…' ELSE '' END) || substring(t.description FROM "+start+" FOR 160) || "+
			"(CASE WHEN "+start+"+159<char_length(t.description) THEN '…' ELSE '' END) END")
	}
	match, priority := c.expression(input.Expression)
	sql := `WITH folded AS MATERIALIZED (SELECT ` + strings.Join(folded, ", ") + ` FROM tasks t
 WHERE t.project_id=$1 AND t.deleted_at IS NULL AND ($2::text IS NULL OR t.status=$2)
 AND ($3::boolean IS NULL OR ` + pg.TaskReady + `=$3)
 AND ($4::boolean IS NULL OR t.allow_agents=$4)
 AND ($5::text IS NULL OR t.required_platform IS NULL OR t.required_platform=$5)
 AND ($6::text='' OR ($6='unassigned' AND t.assigned_to IS NULL) OR ($6='user' AND t.assigned_to=$7::uuid))),
 atom_hits AS MATERIALIZED (SELECT ` + strings.Join(hits, ", ") + ` FROM folded f),
 matched AS MATERIALIZED (SELECT h.id,h.updated_at,` + priority + ` AS title_priority,
 ARRAY[` + strings.Join(titleHits, ",") + `] AS title_hits, ARRAY[` + strings.Join(positions, ",") + `] AS positions FROM atom_hits h WHERE ` + match + `),
 total AS (SELECT count(*) AS total FROM matched),
 page AS (SELECT *, row_number() OVER (ORDER BY title_priority DESC,updated_at DESC,id ASC) AS page_index FROM matched WHERE $8::boolean IS NULL OR title_priority < $8 OR
 (title_priority=$8 AND (updated_at < $9::timestamptz OR (updated_at=$9 AND id > $10::uuid)))
 ORDER BY title_priority DESC,updated_at DESC,id ASC LIMIT $11)
 SELECT total.total,t.id::text,
 CASE WHEN p.page_index > $11 - 1 OR octet_length(t.title)>2097152 THEN NULL ELSE t.title END,
 t.status,t.assigned_to::text,t.cancelled_at,p.updated_at,p.title_priority,
 octet_length(t.title)>2097152,p.title_hits,p.positions,ARRAY[` + strings.Join(snippets, ",") + `]
 FROM total LEFT JOIN page p ON true LEFT JOIN tasks t ON t.id=p.id AND t.project_id=$1
 ORDER BY p.title_priority DESC,p.updated_at DESC,p.id ASC`
	rows, err := s.tx.Query(ctx, sql, args...)
	if err != nil {
		return 0, false, searchError("query task search", err)
	}
	defer rows.Close()
	var total int64
	count := 0
	for rows.Next() {
		var id, title, status *string
		var assigned *string
		var updated, cancelled *time.Time
		var titlePriority, titleOversized *bool
		var titleHits []bool
		var positions []int32
		var snippets []*string
		if err := rows.Scan(&total, &id, &title, &status, &assigned, &cancelled, &updated, &titlePriority, &titleOversized, &titleHits, &positions, &snippets); err != nil {
			return 0, false, searchError("read task search", err)
		}
		if id == nil {
			continue
		}
		if count == input.Limit {
			return total, true, nil
		}
		if status == nil || updated == nil || titlePriority == nil || titleOversized == nil || (!*titleOversized && (title == nil || len(titleHits) != len(c.ordered) || len(positions) != len(c.ordered) || len(snippets) != len(c.ordered))) {
			return 0, false, fmt.Errorf("incomplete task search row")
		}
		row := store.TaskSearchRow{ID: *id, Status: model.TaskStatus(*status), AssignedTo: assigned, CancelledAt: pg.UTCTime(cancelled), UpdatedAt: updated.UTC(), TitlePriority: *titlePriority, TitleOversized: *titleOversized}
		if !row.TitleOversized {
			row.Title = *title
			row.Hits = make([]store.TaskSearchHit, len(c.ordered))
			for i, atom := range c.ordered {
				row.Hits[i] = store.TaskSearchHit{Atom: tasksearch.Atom{Field: atom.field, Term: atom.term}, Title: titleHits[i], Description: positions[i] > 0, Snippet: snippets[i]}
			}
		}
		if !row.Status.Valid() {
			return 0, false, fmt.Errorf("invalid task search status")
		}
		accepted, err := accept(total, row)
		if err != nil {
			return 0, false, err
		}
		if !accepted {
			return total, true, nil
		}
		count++
	}
	if err := rows.Err(); err != nil {
		return 0, false, searchError("read task search", err)
	}
	return total, false, nil
}

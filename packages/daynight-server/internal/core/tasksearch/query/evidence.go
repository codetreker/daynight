package query

import (
	"context"
	"errors"
	"strings"
	"unicode/utf8"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/tasksearch"
)

// Text contains the original task fields, including its canonical ID.
type Text struct{ ID, Title, Description string }

// Hit contains one atom's projected field matches.
type Hit struct{ ID, Title, Description bool }

// Evidence describes positive hits on branches that satisfy the expression.
type Evidence struct {
	Matches, ID, ExactID, Title, Description bool
	DescriptionTerms                         []string
}

// Evaluate applies an NNF expression to complete, original task text.
func Evaluate(root *tasksearch.Node, text Text) Evidence {
	evidence, _ := EvaluateContext(context.Background(), root, text)
	return evidence
}

// EvaluateContext observes cancellation during folding and substring scans.
func EvaluateContext(ctx context.Context, root *tasksearch.Node, text Text) (Evidence, error) {
	needTitle, needDescription := fields(root)
	var err error
	if needTitle {
		text.Title, err = foldASCIIContext(ctx, text.Title)
		if err != nil {
			return Evidence{}, err
		}
	}
	if needDescription {
		text.Description, err = foldASCIIContext(ctx, text.Description)
		if err != nil {
			return Evidence{}, err
		}
	}
	return evaluate(ctx, root, text.ID, func(atom tasksearch.Atom) (Hit, error) {
		hit := Hit{ID: atom.Field.Includes(tasksearch.IDField) && strings.Contains(text.ID, atom.Term)}
		if atom.Field.Includes(tasksearch.TitleField) {
			i, err := index(ctx, text.Title, atom.Term)
			if err != nil {
				return Hit{}, err
			}
			hit.Title = i >= 0
		}
		if atom.Field.Includes(tasksearch.DescriptionField) {
			i, err := index(ctx, text.Description, atom.Term)
			if err != nil {
				return Hit{}, err
			}
			hit.Description = i >= 0
		}
		return hit, nil
	})
}

func fields(n *tasksearch.Node) (bool, bool) {
	if n.Kind == tasksearch.Leaf {
		return n.Atom.Field.Includes(tasksearch.TitleField), n.Atom.Field.Includes(tasksearch.DescriptionField)
	}
	lt, ld := fields(n.Left)
	rt, rd := fields(n.Right)
	return lt || rt, ld || rd
}

// index scans overlapping windows so cancellation is observed even for large text.
func index(ctx context.Context, text, term string) (int, error) {
	const window = 65536
	for start := 0; start < len(text); start += window {
		if err := ctx.Err(); err != nil {
			return -1, err
		}
		end := start + window + len(term) - 1
		if end > len(text) {
			end = len(text)
		}
		if found := strings.Index(text[start:end], term); found >= 0 {
			return start + found, nil
		}
	}
	if err := ctx.Err(); err != nil {
		return -1, err
	}
	if term == "" {
		return 0, nil
	}
	return -1, nil
}

func evaluate(ctx context.Context, n *tasksearch.Node, taskID string, resolve func(tasksearch.Atom) (Hit, error)) (Evidence, error) {
	if err := ctx.Err(); err != nil {
		return Evidence{}, err
	}
	if n == nil {
		return Evidence{}, errors.New("missing search expression")
	}
	if n.Kind == tasksearch.Leaf {
		hit, err := resolve(n.Atom)
		if err != nil {
			return Evidence{}, err
		}
		f := n.Atom.Field
		if !f.Valid() || hit.ID && !f.Includes(tasksearch.IDField) || hit.Title && !f.Includes(tasksearch.TitleField) || hit.Description && !f.Includes(tasksearch.DescriptionField) {
			return Evidence{}, errors.New("search evidence contains an excluded field")
		}
		if hit.ID != (f.Includes(tasksearch.IDField) && strings.Contains(taskID, n.Atom.Term)) {
			return Evidence{}, errors.New("search ID evidence differs from task ID")
		}
		matched := hit.ID || hit.Title || hit.Description
		if n.Negated {
			return Evidence{Matches: !matched}, nil
		}
		e := Evidence{Matches: matched, ID: hit.ID, ExactID: hit.ID && n.Atom.Term == taskID, Title: hit.Title, Description: hit.Description}
		if hit.Description {
			e.DescriptionTerms = []string{n.Atom.Term}
		}
		return e, nil
	}
	if n.Kind != tasksearch.And && n.Kind != tasksearch.Or {
		return Evidence{}, errors.New("invalid search expression")
	}
	left, err := evaluate(ctx, n.Left, taskID, resolve)
	if err != nil {
		return Evidence{}, err
	}
	right, err := evaluate(ctx, n.Right, taskID, resolve)
	if err != nil {
		return Evidence{}, err
	}
	if n.Kind == tasksearch.And && (!left.Matches || !right.Matches) || n.Kind == tasksearch.Or && !left.Matches && !right.Matches {
		return Evidence{}, nil
	}
	e := Evidence{Matches: true}
	for _, child := range []Evidence{left, right} {
		if child.Matches {
			e.ID = e.ID || child.ID
			e.ExactID = e.ExactID || child.ExactID
			e.Title = e.Title || child.Title
			e.Description = e.Description || child.Description
			e.DescriptionTerms = append(e.DescriptionTerms, child.DescriptionTerms...)
		}
	}
	return e, nil
}

// EvaluateHits applies the same expression semantics to DAO-projected hits.
func EvaluateHits(ctx context.Context, n *tasksearch.Node, taskID string, hits map[tasksearch.Atom]Hit) (Evidence, error) {
	visited := make(map[tasksearch.Atom]struct{})
	e, err := evaluate(ctx, n, taskID, func(atom tasksearch.Atom) (Hit, error) {
		hit, ok := hits[atom]
		if !ok {
			return Hit{}, errors.New("search evidence is missing an atom")
		}
		visited[atom] = struct{}{}
		return hit, nil
	})
	if err != nil {
		return Evidence{}, err
	}
	if len(visited) != len(hits) {
		return Evidence{}, errors.New("search evidence contains an extra atom")
	}
	return e, nil
}

// Snippet selects up to 160 original characters around the first contributing
// description hit. Ellipses indicate omitted text on either side.
func Snippet(description string, evidence Evidence) *string {
	snippet, _ := SnippetContext(context.Background(), description, evidence)
	return snippet
}

// SnippetContext observes cancellation while searching the description.
func SnippetContext(ctx context.Context, description string, evidence Evidence) (*string, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !evidence.Matches || !evidence.Description || len(evidence.DescriptionTerms) == 0 {
		return nil, nil
	}
	folded, err := foldASCIIContext(ctx, description)
	if err != nil {
		return nil, err
	}
	hit, err := index(ctx, folded, evidence.DescriptionTerms[0])
	if err != nil {
		return nil, err
	}
	if hit < 0 {
		return nil, nil
	}
	start := hit
	for i := 0; i < 80 && start > 0; i++ {
		_, width := utf8.DecodeLastRuneInString(description[:start])
		start -= width
	}
	end, count := start, 0
	for end < len(description) && count < 160 {
		_, width := utf8.DecodeRuneInString(description[end:])
		end += width
		count++
	}
	for count < 160 && start > 0 {
		_, width := utf8.DecodeLastRuneInString(description[:start])
		start -= width
		count++
	}
	result := description[start:end]
	if start > 0 {
		result = "…" + result
	}
	if end < len(description) {
		result += "…"
	}
	return &result, ctx.Err()
}

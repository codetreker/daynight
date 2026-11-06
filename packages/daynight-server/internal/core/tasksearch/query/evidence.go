package query

import (
	"context"
	"strings"
	"unicode/utf8"
)

// Evidence describes positive hits on branches that satisfy the expression.
type Evidence struct {
	Matches          bool
	Title            bool
	Description      bool
	DescriptionTerms []string
}

// Evaluate applies an NNF expression to complete, original task text.
func Evaluate(root *Node, title, description string) Evidence {
	evidence, _ := EvaluateContext(context.Background(), root, title, description)
	return evidence
}

// EvaluateContext observes cancellation during folding and substring scans.
func EvaluateContext(ctx context.Context, root *Node, title, description string) (Evidence, error) {
	needTitle, needDescription := fields(root)
	var err error
	if needTitle {
		title, err = foldASCIIContext(ctx, title)
		if err != nil {
			return Evidence{}, err
		}
	}
	if needDescription {
		description, err = foldASCIIContext(ctx, description)
		if err != nil {
			return Evidence{}, err
		}
	}
	return evaluate(ctx, root, title, description)
}

func fields(n *Node) (bool, bool) {
	if n.Kind == Leaf {
		return n.Atom.Field != DescriptionField, n.Atom.Field != TitleField
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

func evaluate(ctx context.Context, n *Node, title, description string) (Evidence, error) {
	if err := ctx.Err(); err != nil {
		return Evidence{}, err
	}
	if n.Kind == Leaf {
		var titleHit, descriptionHit bool
		if n.Atom.Field != DescriptionField {
			i, err := index(ctx, title, n.Atom.Term)
			if err != nil {
				return Evidence{}, err
			}
			titleHit = i >= 0
		}
		if n.Atom.Field != TitleField {
			i, err := index(ctx, description, n.Atom.Term)
			if err != nil {
				return Evidence{}, err
			}
			descriptionHit = i >= 0
		}
		matched := titleHit || descriptionHit
		if n.Negated {
			return Evidence{Matches: !matched}, nil
		}
		e := Evidence{Matches: matched, Title: titleHit, Description: descriptionHit}
		if descriptionHit {
			e.DescriptionTerms = []string{n.Atom.Term}
		}
		return e, nil
	}
	left, err := evaluate(ctx, n.Left, title, description)
	if err != nil {
		return Evidence{}, err
	}
	right, err := evaluate(ctx, n.Right, title, description)
	if err != nil {
		return Evidence{}, err
	}
	if n.Kind == And && (!left.Matches || !right.Matches) {
		return Evidence{}, nil
	}
	if n.Kind == Or && !left.Matches && !right.Matches {
		return Evidence{}, nil
	}
	e := Evidence{Matches: true}
	if left.Matches {
		e.Title, e.Description = left.Title, left.Description
		e.DescriptionTerms = append(e.DescriptionTerms, left.DescriptionTerms...)
	}
	if right.Matches {
		e.Title = e.Title || right.Title
		e.Description = e.Description || right.Description
		e.DescriptionTerms = append(e.DescriptionTerms, right.DescriptionTerms...)
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

// Package query parses and evaluates the task search expression language.
package query

import "context"

// Kind identifies an NNF expression node.
type Kind uint8

const (
	Leaf Kind = iota
	And
	Or
)

// Field identifies the text searched by an atom.
type Field uint8

const (
	AnyField Field = iota
	TitleField
	DescriptionField
)

// Atom identifies a literal substring after ASCII case folding.
type Atom struct {
	Field Field
	Term  string
}

// Node is in negation normal form: only a leaf may be negated.
type Node struct {
	Kind        Kind
	Left, Right *Node
	Atom        Atom
	Negated     bool
	// Position and Length locate this expression in the original input.
	Position, Length int
}

// Error identifies a syntax error without exposing the search expression.
// Position and Length count Unicode code points; Position is one-based.
type Error struct {
	Reason   string
	Position int
	Length   int
}

func (e *Error) Error() string { return "invalid search expression: " + e.Reason }

// FoldASCII folds only ASCII uppercase letters, matching PostgreSQL's C collation.
func FoldASCII(s string) string {
	result, _ := foldASCIIContext(context.Background(), s)
	return result
}

func foldASCIIContext(ctx context.Context, s string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	bytes := []byte(s)
	for i, b := range bytes {
		if i%65536 == 0 {
			if err := ctx.Err(); err != nil {
				return "", err
			}
		}
		if b >= 'A' && b <= 'Z' {
			bytes[i] = b + ('a' - 'A')
		}
	}
	return string(bytes), ctx.Err()
}

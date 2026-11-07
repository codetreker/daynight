// Package query parses and evaluates the task search expression language.
package query

import "context"

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

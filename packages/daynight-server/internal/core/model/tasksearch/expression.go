// Package tasksearch defines the shared task search expression data.
package tasksearch

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

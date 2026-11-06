package query

import (
	"unicode"
	"unicode/utf8"
)

const (
	maxBytes = 8 * 1024
	maxTerms = 128
	maxDepth = 32
)

type tokenKind uint8

const (
	tEOF tokenKind = iota
	tWord
	tPhrase
	tLeft
	tRight
	tColon
	tAnd
	tOr
	tNot
)

type token struct {
	kind        tokenKind
	value       string
	pos, length int
	space       bool
}

func syntax(reason string, t token) error {
	return &Error{Reason: reason, Position: t.pos, Length: t.length}
}

func tokenize(raw string) ([]token, error) {
	position := 1
	for offset, r := range raw {
		if offset+utf8.RuneLen(r) > maxBytes {
			return nil, &Error{Reason: "query_too_large", Position: position, Length: 1}
		}
		position++
	}
	runes := []rune(raw)
	tokens := make([]token, 0)
	i := 0
	for i < len(runes) {
		space := false
		for i < len(runes) && unicode.IsSpace(runes[i]) {
			space = true
			i++
		}
		if i == len(runes) {
			break
		}
		start := i
		t := token{pos: start + 1, space: space}
		switch runes[i] {
		case '(':
			t.kind, i = tLeft, i+1
		case ')':
			t.kind, i = tRight, i+1
		case ':':
			t.kind, i = tColon, i+1
		case '"':
			t.kind = tPhrase
			i++
			value := make([]rune, 0)
			for i < len(runes) && runes[i] != '"' {
				if runes[i] == '\\' {
					if i+1 >= len(runes) || (runes[i+1] != '\\' && runes[i+1] != '"') {
						length := 1
						if i+1 < len(runes) {
							length = 2
						}
						return nil, &Error{Reason: "invalid_escape", Position: i + 1, Length: length}
					}
					i++
				}
				value = append(value, runes[i])
				i++
			}
			if i == len(runes) {
				return nil, &Error{Reason: "unclosed_quote", Position: start + 1, Length: 1}
			}
			i++
			if len(value) == 0 {
				return nil, &Error{Reason: "empty_phrase", Position: start + 1, Length: 2}
			}
			t.value = string(value)
		default:
			for i < len(runes) && !unicode.IsSpace(runes[i]) && runes[i] != '(' && runes[i] != ')' && runes[i] != ':' && runes[i] != '"' {
				i++
			}
			t.value = string(runes[start:i])
			switch t.value {
			case "AND":
				t.kind = tAnd
			case "OR":
				t.kind = tOr
			case "NOT":
				t.kind = tNot
			default:
				t.kind = tWord
			}
		}
		t.length = i - start
		tokens = append(tokens, t)
	}
	tokens = append(tokens, token{kind: tEOF, pos: len(runes) + 1})
	return tokens, nil
}

type parser struct {
	tokens              []token
	index, terms, depth int
}

func (p *parser) current() token { return p.tokens[p.index] }
func (p *parser) take() token    { t := p.current(); p.index++; return t }

// Parse parses the original expression and returns a negation-normal-form tree.
func Parse(raw string) (*Node, error) {
	tokens, err := tokenize(raw)
	if err != nil {
		return nil, err
	}
	if tokens[0].kind == tEOF {
		return nil, &Error{Reason: "empty_query", Position: 1, Length: 0}
	}
	p := &parser{tokens: tokens}
	n, err := p.parseOr()
	if err != nil {
		return nil, err
	}
	if t := p.current(); t.kind != tEOF {
		if t.kind == tRight {
			return nil, syntax("unexpected_closing_group", t)
		}
		return nil, syntax("unexpected_token", t)
	}
	return n, nil
}

func (p *parser) parseOr() (*Node, error) {
	left, err := p.parseAnd()
	if err != nil {
		return nil, err
	}
	for p.current().kind == tOr {
		p.take()
		right, err := p.parseAnd()
		if err != nil {
			return nil, err
		}
		left = combine(Or, left, right)
	}
	return left, nil
}

func startsOperand(k tokenKind) bool { return k == tWord || k == tPhrase || k == tLeft || k == tNot }

func (p *parser) parseAnd() (*Node, error) {
	left, err := p.parseUnary()
	if err != nil {
		return nil, err
	}
	for {
		t := p.current()
		if t.kind == tAnd {
			p.take()
		} else if !t.space || !startsOperand(t.kind) {
			break
		}
		right, err := p.parseUnary()
		if err != nil {
			return nil, err
		}
		left = combine(And, left, right)
	}
	return left, nil
}

func (p *parser) parseUnary() (*Node, error) {
	negated := false
	start := p.current().pos
	hasNot := false
	for p.current().kind == tNot {
		p.take()
		hasNot = true
		negated = !negated
	}
	n, err := p.parsePrimary()
	if err != nil {
		return nil, err
	}
	if negated {
		negate(n)
	}
	if hasNot {
		n.Length += n.Position - start
		n.Position = start
	}
	return n, nil
}

func combine(kind Kind, left, right *Node) *Node {
	return &Node{Kind: kind, Left: left, Right: right, Position: left.Position, Length: right.Position + right.Length - left.Position}
}

func negate(n *Node) {
	if n.Kind == Leaf {
		n.Negated = !n.Negated
		return
	}
	if n.Kind == And {
		n.Kind = Or
	} else {
		n.Kind = And
	}
	negate(n.Left)
	negate(n.Right)
}

func (p *parser) parsePrimary() (*Node, error) {
	t := p.current()
	if t.kind == tLeft {
		if p.depth == maxDepth {
			return nil, syntax("nesting_too_deep", t)
		}
		p.take()
		p.depth++
		if p.current().kind == tEOF {
			return nil, syntax("unclosed_group", t)
		}
		n, err := p.parseOr()
		if err != nil {
			return nil, err
		}
		if p.current().kind != tRight {
			if p.current().kind == tEOF {
				return nil, syntax("unclosed_group", t)
			}
			return nil, syntax("unexpected_token", p.current())
		}
		end := p.take()
		p.depth--
		n.Position, n.Length = t.pos, end.pos+end.length-t.pos
		return n, nil
	}
	if t.kind != tWord && t.kind != tPhrase {
		if t.kind == tRight && p.depth == 0 {
			return nil, syntax("unexpected_closing_group", t)
		}
		return nil, syntax("expected_operand", t)
	}
	p.take()
	field := AnyField
	start := t
	if t.kind == tWord && p.current().kind == tColon && !p.current().space {
		switch t.value {
		case "title":
			field = TitleField
		case "description":
			field = DescriptionField
		default:
			return nil, syntax("unknown_field", t)
		}
		p.take()
		t = p.current()
		if t.kind == tLeft {
			return nil, syntax("field_group_not_supported", t)
		}
		if t.kind != tWord && t.kind != tPhrase {
			return nil, syntax("missing_field_value", t)
		}
		p.take()
	}
	p.terms++
	if p.terms > maxTerms {
		return nil, syntax("too_many_terms", start)
	}
	return &Node{Kind: Leaf, Atom: Atom{Field: field, Term: FoldASCII(t.value)}, Position: start.pos, Length: t.pos + t.length - start.pos}, nil
}

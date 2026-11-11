package configvalue

import (
	"encoding/json"
	"fmt"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"time"

	"go.yaml.in/yaml/v4"
)

type DurationString string

// Origin identifies a configuration value without exposing its contents.
type Origin struct {
	Source  string
	EnvName string
	Line    int
	Column  int
}

// ResolvePath preserves relative path components, including symlink/.. traversal.
func ResolvePath(root, path string) string {
	if path == "" || filepath.IsAbs(path) {
		return path
	}
	return strings.TrimRight(root, string(filepath.Separator)) + string(filepath.Separator) + path
}

// CheckDuplicates inspects raw mappings, including otherwise ignored subtrees.
func CheckDuplicates(node *yaml.Node) error {
	if node == nil {
		return nil
	}
	if node.Kind == yaml.MappingNode {
		seen := map[string]bool{}
		for i := 0; i+1 < len(node.Content); i += 2 {
			key := node.Content[i]
			k := keyIdentity(key, map[*yaml.Node]bool{})
			if seen[k] {
				return &ConfigurationError{Rule: "contains duplicate mapping keys", Origin: Origin{Line: key.Line, Column: key.Column}}
			}
			seen[k] = true
		}
	}
	for _, child := range node.Content {
		if err := CheckDuplicates(child); err != nil {
			return err
		}
	}
	return nil
}

func keyIdentity(node *yaml.Node, visiting map[*yaml.Node]bool) string {
	node = deref(node)
	if node == nil || visiting[node] {
		return "cycle"
	}
	visiting[node] = true
	defer delete(visiting, node)
	var b strings.Builder
	value := node.Value
	if node.Kind == yaml.ScalarNode && node.ShortTag() != "!!merge" {
		var decoded any
		if err := node.Load(&decoded); err == nil {
			value = fmt.Sprintf("%T:%v", decoded, decoded)
		}
	}
	fmt.Fprintf(&b, "%d:%d:%s:%d:%s", node.Kind, len(node.ShortTag()), node.ShortTag(), len(value), value)
	parts := make([]string, 0, len(node.Content))
	if node.Kind == yaml.MappingNode {
		for i := 0; i+1 < len(node.Content); i += 2 {
			k := keyIdentity(node.Content[i], visiting)
			v := keyIdentity(node.Content[i+1], visiting)
			parts = append(parts, fmt.Sprintf("%d:%s%d:%s", len(k), k, len(v), v))
		}
		sort.Strings(parts)
	} else {
		for _, child := range node.Content {
			parts = append(parts, keyIdentity(child, visiting))
		}
	}
	for _, part := range parts {
		fmt.Fprintf(&b, ":%d:%s", len(part), part)
	}
	return b.String()
}

func deref(node *yaml.Node) *yaml.Node {
	seen := map[*yaml.Node]bool{}
	for node != nil && node.Kind == yaml.AliasNode {
		if seen[node] {
			return nil
		}
		seen[node] = true
		node = node.Alias
	}
	return node
}

// mapping expands YAML merges while preserving the node defining each value.
func mapping(node *yaml.Node, visiting map[*yaml.Node]bool) (map[string]*yaml.Node, error) {
	node = deref(node)
	if node == nil || node.Kind != yaml.MappingNode || node.ShortTag() != "!!map" {
		return nil, fmt.Errorf("mapping required")
	}
	if visiting[node] {
		return nil, fmt.Errorf("cyclic merge")
	}
	visiting[node] = true
	defer delete(visiting, node)
	out := map[string]*yaml.Node{}
	for i := 0; i+1 < len(node.Content); i += 2 {
		k, v := node.Content[i], node.Content[i+1]
		if k.ShortTag() != "!!merge" {
			continue
		}
		merge := deref(v)
		if merge == nil {
			return nil, fmt.Errorf("invalid merge")
		}
		items := []*yaml.Node{merge}
		if merge.Kind == yaml.SequenceNode {
			items = merge.Content
		}
		for _, item := range items {
			m, err := mapping(item, visiting)
			if err != nil {
				return nil, err
			}
			for key, value := range m {
				if _, ok := out[key]; !ok {
					out[key] = value
				}
			}
		}
	}
	for i := 0; i+1 < len(node.Content); i += 2 {
		k, v := node.Content[i], node.Content[i+1]
		if k.ShortTag() == "!!merge" {
			continue
		}
		if k.Kind != yaml.ScalarNode || k.ShortTag() != "!!str" {
			return nil, fmt.Errorf("string key required")
		}
		out[k.Value] = v
	}
	return out, nil
}

var nodeType = reflect.TypeOf(yaml.Node{})
var mappingType = reflect.TypeOf((*yaml.Unmarshaler)(nil)).Elem()
var durationType = reflect.TypeOf(DurationString(""))

// Validate checks known fields against the Patch types before YAML conversion.
// Unknown fields are intentionally not inspected by the schema walk.
func Validate(node *yaml.Node, patch any, source string) (map[string]Origin, error) {
	origins := map[string]Origin{}
	t := reflect.TypeOf(patch)
	for t.Kind() == reflect.Pointer {
		t = t.Elem()
	}
	var walk func(*yaml.Node, reflect.Type, string) error
	walk = func(raw *yaml.Node, t reflect.Type, field string) error {
		n := deref(raw)
		if n == nil {
			return &ConfigurationError{Field: field, Rule: "has an invalid alias", Origin: Origin{Source: source}}
		}
		for t.Kind() == reflect.Pointer {
			t = t.Elem()
		}
		origin := Origin{Source: source, Line: n.Line, Column: n.Column}
		fail := func() error { return &ConfigurationError{Field: field, Rule: "has an invalid type", Origin: origin} }
		if t == nodeType || reflect.PointerTo(t).Implements(mappingType) {
			if n.Kind != yaml.MappingNode || n.ShortTag() != "!!map" {
				return fail()
			}
			if _, err := JSONValue(n); err != nil {
				return fail()
			}
			origins[field] = origin
			return nil
		}
		if t.Kind() == reflect.Struct {
			m, err := mapping(n, map[*yaml.Node]bool{})
			if err != nil {
				return fail()
			}
			fields := map[string]reflect.Type{}
			var collect func(reflect.Type)
			collect = func(st reflect.Type) {
				for i := 0; i < st.NumField(); i++ {
					f := st.Field(i)
					tag := f.Tag.Get("yaml")
					parts := strings.Split(tag, ",")
					if tag == "-" || f.PkgPath != "" {
						continue
					}
					if len(parts) > 1 && parts[1] == "inline" {
						it := f.Type
						for it.Kind() == reflect.Pointer {
							it = it.Elem()
						}
						if it.Kind() == reflect.Struct {
							collect(it)
						}
						continue
					}
					name := parts[0]
					if name == "" {
						name = strings.ToLower(f.Name)
					}
					fields[name] = f.Type
				}
			}
			collect(t)
			for name, ft := range fields {
				if value, ok := m[name]; ok {
					path := name
					if field != "" {
						path = field + "." + name
					}
					if err := walk(value, ft, path); err != nil {
						return err
					}
				}
			}
			return nil
		}
		switch t.Kind() {
		case reflect.String:
			if n.Kind != yaml.ScalarNode || n.ShortTag() != "!!str" {
				return fail()
			}
			if t == durationType {
				if _, err := time.ParseDuration(n.Value); err != nil || !strings.ContainsAny(n.Value, "hmsuµn") {
					return fail()
				}
			}
		case reflect.Bool:
			if n.Kind != yaml.ScalarNode || n.ShortTag() != "!!bool" || (n.Value != "true" && n.Value != "false") {
				return fail()
			}
		case reflect.Int, reflect.Int64:
			if n.Kind != yaml.ScalarNode || n.ShortTag() != "!!int" {
				return fail()
			}
			v, e := strconv.ParseInt(n.Value, 10, 64)
			if e != nil || v < 0 || strconv.FormatInt(v, 10) != n.Value {
				return fail()
			}
		case reflect.Slice:
			if n.Kind != yaml.SequenceNode || n.ShortTag() != "!!seq" {
				return fail()
			}
			for _, item := range n.Content {
				if err := walk(item, t.Elem(), field); err != nil {
					return err
				}
			}
		default:
			return fail()
		}
		origins[field] = origin
		return nil
	}
	if err := walk(node, t, ""); err != nil {
		return nil, err
	}
	return origins, nil
}

// JSONValue converts a YAML metadata subtree only after rejecting non-JSON values.
func JSONValue(raw *yaml.Node) (any, error) {
	var convert func(*yaml.Node, map[*yaml.Node]bool) (any, error)
	convert = func(raw *yaml.Node, visiting map[*yaml.Node]bool) (any, error) {
		n := deref(raw)
		if n == nil || visiting[n] {
			return nil, fmt.Errorf("invalid alias")
		}
		visiting[n] = true
		defer delete(visiting, n)
		switch n.Kind {
		case yaml.MappingNode:
			m, err := mapping(n, map[*yaml.Node]bool{})
			if err != nil {
				return nil, err
			}
			out := map[string]any{}
			for k, v := range m {
				x, e := convert(v, visiting)
				if e != nil {
					return nil, e
				}
				out[k] = x
			}
			return out, nil
		case yaml.SequenceNode:
			if n.ShortTag() != "!!seq" {
				return nil, fmt.Errorf("invalid sequence")
			}
			out := make([]any, 0, len(n.Content))
			for _, v := range n.Content {
				x, e := convert(v, visiting)
				if e != nil {
					return nil, e
				}
				out = append(out, x)
			}
			return out, nil
		case yaml.ScalarNode:
			switch n.ShortTag() {
			case "!!str":
				return n.Value, nil
			case "!!null":
				return nil, nil
			case "!!bool":
				if n.Value == "true" {
					return true, nil
				}
				if n.Value == "false" {
					return false, nil
				}
			case "!!int", "!!float":
				var value any
				if err := n.Load(&value); err != nil {
					return nil, err
				}
				if _, err := json.Marshal(value); err == nil {
					return value, nil
				}
			}
		}
		return nil, fmt.Errorf("non-JSON value")
	}
	return convert(raw, map[*yaml.Node]bool{})
}

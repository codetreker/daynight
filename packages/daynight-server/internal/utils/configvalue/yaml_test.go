package configvalue

import (
	"encoding/json"
	"strings"
	"testing"

	"go.yaml.in/yaml/v4"
)

func TestJSONValuePreservesYAMLMetadata(t *testing.T) {
	var doc yaml.Node
	body := `a: [true, false, 4, 1.5, null, text]
base: &base {nested: value}
copy: *base
`
	if err := yaml.Load([]byte(body), &doc); err != nil {
		t.Fatal(err)
	}
	got, err := JSONValue(doc.Content[0])
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"a":[true,false,4,1.5,null,"text"],"base":{"nested":"value"},"copy":{"nested":"value"}}` {
		t.Fatalf("unexpected JSON: %s", encoded)
	}
}
func TestJSONValueRejectsNonJSONYAML(t *testing.T) {
	for _, body := range []string{
		`a: .nan`, `a: !private secret`, `1: value`, `a: [!private secret]`, `a: {b: !private secret}`, `a: &self [*self]`,
	} {
		t.Run(body, func(t *testing.T) {
			var doc yaml.Node
			if err := yaml.Load([]byte(body), &doc); err != nil {
				t.Fatal(err)
			}
			_, err := JSONValue(doc.Content[0])
			if err == nil || strings.Contains(err.Error(), "secret") {
				t.Fatalf("invalid JSON-compatible YAML accepted or exposed: %v", err)
			}
		})
	}
}

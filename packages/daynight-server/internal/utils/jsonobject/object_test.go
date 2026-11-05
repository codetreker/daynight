package jsonobject

import "testing"

func TestDecodeStrictObject(t *testing.T) {
	fields, err := Decode([]byte(`{"title":"one","description":{"nested":true}}`), "request body", "title", "description")
	if err != nil || string(fields["title"]) != `"one"` || string(fields["description"]) != `{"nested":true}` {
		t.Fatalf("object fields: %v, %v", fields, err)
	}
	for _, invalid := range []string{
		``, `null`, `[]`, `{`, `{"title"`, `{"title":`, `{"title":true,}`, `{"title":"a"]`,
		`{"Title":"a"}`, `{"title":"a","title":"b"}`, `{"title":"a","ti\u0074le":"b"}`, `{} {}`, `{} false`,
	} {
		if _, err := Decode([]byte(invalid), "request body", "title"); err == nil {
			t.Fatalf("invalid object accepted: %s", invalid)
		}
	}
}

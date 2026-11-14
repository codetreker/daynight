package tag

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/store"
)

func code(err error) string {
	var f *model.Fault
	if errors.As(err, &f) {
		return f.Code
	}
	return ""
}
func TestNameRules(t *testing.T) {
	for _, tc := range []struct{ name, input, want, key, code string }{
		{"trim and fold", "\u2003Ab C\u00a0", "Ab C", "ab c", ""},
		{"unicode preserved", "Éé", "Éé", "Éé", ""},
		{"maximum", strings.Repeat("界", 64), strings.Repeat("界", 64), strings.Repeat("界", 64), ""},
		{"too long", strings.Repeat("界", 65), "", "", "invalid_tag_name"},
		{"supplementary maximum", strings.Repeat("😀", 64), strings.Repeat("😀", 64), strings.Repeat("😀", 64), ""},
		{"supplementary too long", strings.Repeat("😀", 65), "", "", "invalid_tag_name"},
		{"combining code points maximum", strings.Repeat("e\u0301", 32), strings.Repeat("e\u0301", 32), strings.Repeat("e\u0301", 32), ""},
		{"combining code points too long", strings.Repeat("e\u0301", 32) + "e", "", "", "invalid_tag_name"},
		{"empty", "\u2003 ", "", "", "invalid_tag_name"},
		{"control", "a\nb", "", "", "invalid_tag_name"},
		{"separator", "a\u2028b", "", "", "invalid_tag_name"},
		{"invalid utf8", string([]byte{0xff}), "", "", "invalid_tag_name"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, key, err := Name(tc.input)
			if got != tc.want || key != tc.key || code(err) != tc.code {
				t.Fatalf("name=%q key=%q err=%v", got, key, err)
			}
		})
	}
}
func TestCursorBindsEveryCatalogFact(t *testing.T) {
	original := Cursor{Version: 1, ProjectID: "project", UserID: "user", CredentialID: "credential", Kind: model.PATCredential, Query: "a", Limit: 50, Epoch: "epoch", NameKey: "name", ID: "99b2ee65-c2b5-48a2-a0db-d6f8fab8a5ba"}
	encoded := EncodeCursor(original)
	position, err := DecodeCursor(encoded, original)
	if err != nil || position.ID != original.ID || position.NameKey != original.NameKey {
		t.Fatalf("%+v %v", position, err)
	}
	cases := []func(*Cursor){func(c *Cursor) { c.ProjectID = "other" }, func(c *Cursor) { c.UserID = "other" }, func(c *Cursor) { c.CredentialID = "other" }, func(c *Cursor) { c.Kind = model.SessionCredential }, func(c *Cursor) { c.Query = "other" }, func(c *Cursor) { c.Limit++ }, func(c *Cursor) { c.Epoch = "other" }}
	for _, change := range cases {
		altered := original
		change(&altered)
		if _, err := DecodeCursor(encoded, altered); code(err) != "catalog_changed" {
			t.Fatalf("accepted changed cursor: %+v %v", altered, err)
		}
	}
	for _, raw := range []string{"!", strings.Repeat("x", 16385)} {
		if _, err := DecodeCursor(raw, original); code(err) != "catalog_changed" {
			t.Fatalf("accepted malformed cursor: %v", err)
		}
	}
}
func TestVersionAndLookup(t *testing.T) {
	if code(Version(0)) != "invalid_input" || code(CheckVersion(model.Tag{Version: 2}, 1)) != "version_conflict" || CheckVersion(model.Tag{Version: 2}, 2) != nil || code(Lookup(model.ErrNotFound)) != "tag_not_found" {
		t.Fatal("wrong version or missing tag result")
	}
}

func TestConflictMappingIsLimitedToNameConstraint(t *testing.T) {
	cause := errors.New("ordinary failure")
	if Unique(cause) != cause || Lookup(cause) != cause || Version(1) != nil {
		t.Fatal("ordinary result changed")
	}
	conflict := errors.Join(store.ErrTagNameConflict, cause)
	if err := Unique(conflict); code(err) != "tag_name_conflict" || !errors.Is(err, cause) {
		t.Fatalf("conflict=%v", err)
	}
	if err := Lookup(store.ErrTagWriteConflict); code(err) != "version_conflict" {
		t.Fatal(err)
	}
}

package tag

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

func TestColorEncodingAndActualLimit(t *testing.T) {
	version, color := int64(9223372036854775807), "#ABCDEF"
	page := api.TagColorPage{CatalogEpoch: "<&", Items: []api.TagColorItem{{ID: "id", State: "found", Version: &version, Color: &color}, {ID: "missing", State: "missing"}}}
	var output bytes.Buffer
	if _, err := EncodeColors(&output, page); err != nil {
		t.Fatal(err)
	}
	expected, err := json.Marshal(page)
	if err != nil || output.String() != string(expected)+"\n" {
		t.Fatalf("wire=%q expected=%q err=%v", output.String(), expected, err)
	}

	page = api.TagColorPage{CatalogEpoch: "", Items: []api.TagColorItem{{ID: "", State: "missing"}}}
	base, err := EncodeColors(io.Discard, page)
	if err != nil {
		t.Fatal(err)
	}
	page.Items[0].ID = strings.Repeat("a", MaxResolveBytes-int(base))
	n, err := EncodeColors(io.Discard, page)
	if err != nil || n != MaxResolveBytes {
		t.Fatalf("exact n=%d err=%v", n, err)
	}
	page.Items[0].ID += "a"
	_, err = EncodeColors(io.Discard, page)
	var violation *limit.Violation
	if !errors.As(err, &violation) {
		t.Fatalf("over budget accepted: %v", err)
	}
	page.Items[0].ID = strings.Repeat("&", MaxResolveBytes/6)
	_, err = EncodeColors(io.Discard, page)
	if !errors.As(err, &violation) {
		t.Fatalf("escaped bytes accepted: %v", err)
	}
}

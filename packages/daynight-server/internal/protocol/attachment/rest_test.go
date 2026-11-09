package attachment

import (
	"bytes"
	"encoding/json"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/measure"
)

func TestRESTPageEncodingMatchesBudgetMeasurement(t *testing.T) {
	stamp := time.Date(2026, 11, 7, 1, 2, 3, 0, time.FixedZone("local", 3600))
	page := api.AttachmentPage{Items: []api.Attachment{REST(model.Attachment{
		Path: "docs/<&.md", ContentType: "text/plain", SizeBytes: 3, CreatedAt: stamp, UpdatedAt: stamp,
	})}}
	var actual, measured bytes.Buffer
	if err := json.NewEncoder(&actual).Encode(page); err != nil {
		t.Fatal(err)
	}
	if _, err := measure.JSON(&measured, "attachments", 1<<20, page, true); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(actual.Bytes(), measured.Bytes()) || !bytes.Contains(actual.Bytes(), []byte(`\u003c\u0026`)) || page.Items[0].CreatedAt.Location() != time.UTC {
		t.Fatalf("actual=%s measured=%s", actual.Bytes(), measured.Bytes())
	}
}

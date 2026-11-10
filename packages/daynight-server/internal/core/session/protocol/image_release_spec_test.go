package sessionprotocol

import (
	"encoding/json"
	"testing"

	"github.com/google/uuid"
)

func TestReleaseMediaBodyPreservesOptionalOriginalPreparation(t *testing.T) {
	var spec ImageUploadSpec
	if err := json.Unmarshal(imageSpecBytes(), &spec); err != nil {
		t.Fatal(err)
	}
	body := map[string]any{"uploadId": spec.UploadID, "spec": spec}
	frame := mediaFrame(t, "image_request", "release", body, nil, nil)
	if _, err := DecodeImageMedia(frame); err != nil {
		t.Fatal("original release spec rejected", err)
	}
	changed := spec
	changed.SHA256 = "invalid"
	for _, invalid := range []any{
		map[string]any{"uploadId": spec.UploadID, "spec": nil},
		map[string]any{"uploadId": uuid.NewString(), "spec": spec},
		map[string]any{"uploadId": spec.UploadID, "spec": changed},
		map[string]any{"uploadId": spec.UploadID, "spec": spec, "extra": true},
	} {
		if _, err := DecodeImageMedia(mediaFrame(t, "image_request", "release", invalid, nil, nil)); err == nil {
			t.Fatal("invalid release spec admitted", invalid)
		}
	}
}

package sessionprotocol

import (
	"encoding/json"
	"testing"
)

func TestImagePreparationStrictStatesAndValidatedOffset(t *testing.T) {
	var spec ImageUploadSpec
	if e := json.Unmarshal(imageSpecBytes(), &spec); e != nil {
		t.Fatal(e)
	}
	value := LocalImagePreparation{UploadID: spec.UploadID, ImageID: spec.ImageID, Target: spec.Target, State: "receiving", AcceptedOffset: "0"}
	check := func(want bool) {
		t.Helper()
		raw, _ := json.Marshal(value)
		if validPreparation(raw) != want {
			t.Fatalf("valid=%v %s", want, raw)
		}
	}
	check(true)
	value.State = "decoding"
	check(false)
	value.State = "validated"
	check(false)
	value.Validated = &ValidatedImage{MediaType: "image/png", ByteLength: "10", SHA256: spec.SHA256, Width: 2, Height: 3, FrameCount: 1}
	check(false)
	value.AcceptedOffset = "10"
	check(true)
	value.State = "failed"
	value.Validated = nil
	check(false)
	value.Error = &ImageError{Code: "image_decode_failed", Message: "Invalid original."}
	check(true)
	value.State = "expired"
	check(true)
	value.Error = nil
	check(false)
	value.State = "released"
	check(true)
	value.Error = &ImageError{Code: "other", Message: "Not allowed."}
	check(false)
}

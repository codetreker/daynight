package codec

import (
	"bytes"
	"encoding/json"
	"errors"
	"math"
	"strings"
	"testing"
	"time"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func fixture() (model.TaskHeader, model.TaskStep) {
	stamp := time.Date(2026, 11, 3, 10, 11, 12, 123456000, time.UTC)
	return model.TaskHeader{ProjectID: "00000000-0000-4000-8000-000000000001", ID: "00000000-0000-4000-8000-000000000002", Version: 9007199254740993},
		model.TaskStep{ID: "00abcdef", Title: " \ufeff ", Description: "# 结果\n<>&\u2028\u2029\t\"\\", Status: model.TaskStepSkipped, CreatedAt: stamp, UpdatedAt: stamp}
}

func TestCanonicalIDAndText(t *testing.T) {
	for _, input := range []string{"00000000", "ABCDEF01", "a1B2c3D4"} {
		value, err := CanonicalID(input)
		if err != nil || value != strings.ToLower(input) {
			t.Fatalf("ID %q: %q, %v", input, value, err)
		}
	}
	for _, input := range []string{"", "abc", "123456789", "0123456g", "ＡＢＣＤ", "00000000-0000-4000-8000-000000000001", "12 34567"} {
		if _, err := CanonicalID(input); err == nil {
			t.Fatalf("accepted ID %q", input)
		}
	}
	for _, input := range []string{" ", "\u0085", "\u2000\t\r\n", "\x00", "\xff"} {
		if ValidateText(input, "") == nil {
			t.Fatalf("accepted title %q", input)
		}
	}
	for _, input := range []string{"\x00", "\xff"} {
		if ValidateText("Title", input) == nil {
			t.Fatalf("accepted description %q", input)
		}
	}
	if err := ValidateText("\ufeff", ""); err != nil {
		t.Fatal(err)
	}
}

func TestCollectionAndItemEncodeExactPublicBytes(t *testing.T) {
	header, step := fixture()
	resource, data, err := EncodeCollection(header, []model.TaskStep{step})
	if err != nil {
		t.Fatal(err)
	}
	var expected bytes.Buffer
	if err := json.NewEncoder(&expected).Encode(resource); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, expected.Bytes()) || data[len(data)-1] != '\n' || !bytes.Contains(data, []byte(`"version":9007199254740993`)) ||
		!bytes.Contains(data, []byte(`\u003c\u003e\u0026\u2028\u2029`)) || !bytes.Contains(data, []byte(`2026-11-03T10:11:12.123456Z`)) ||
		bytes.Contains(data, []byte(`position`)) || resource.Steps[0].Title != step.Title || resource.Steps[0].Description != step.Description {
		t.Fatalf("public representation: %q", data)
	}
	item, single, err := EncodeItem(header, step)
	if err != nil || item.Step.ID != step.ID || !bytes.Contains(single, []byte(`"step":{`)) || bytes.Contains(single, []byte(`"steps"`)) {
		t.Fatalf("single representation: %s, %v", single, err)
	}
	empty, data, err := EncodeCollection(header, []model.TaskStep{})
	if err != nil || empty.Steps == nil || !bytes.Contains(data, []byte(`"steps":[]`)) {
		t.Fatalf("empty: %s, %v", data, err)
	}
}

func TestInvalidStoredDataIsNotRepaired(t *testing.T) {
	header, step := fixture()
	for name, change := range map[string]func(*model.TaskStep){
		"uppercase":          func(s *model.TaskStep) { s.ID = "00ABCDEF" },
		"short ID":           func(s *model.TaskStep) { s.ID = "bad" },
		"negative position":  func(s *model.TaskStep) { s.Position = -1 },
		"blank title":        func(s *model.TaskStep) { s.Title = "\u0085" },
		"nul description":    func(s *model.TaskStep) { s.Description = "secret\x00" },
		"invalid status":     func(s *model.TaskStep) { s.Status = "review" },
		"zero created":       func(s *model.TaskStep) { s.CreatedAt = time.Time{} },
		"nanosecond updated": func(s *model.TaskStep) { s.UpdatedAt = s.UpdatedAt.Add(time.Nanosecond) },
		"unencodable year":   func(s *model.TaskStep) { s.CreatedAt = time.Date(10000, 1, 1, 0, 0, 0, 0, time.UTC) },
	} {
		t.Run(name, func(t *testing.T) {
			candidate := step
			change(&candidate)
			if _, _, err := EncodeCollection(header, []model.TaskStep{candidate}); err == nil {
				t.Fatal("accepted invalid stored collection")
			}
			if _, _, err := EncodeItem(header, candidate); err == nil {
				t.Fatal("accepted invalid stored item")
			}
		})
	}
	for _, candidate := range []model.TaskHeader{
		{ProjectID: "invalid", ID: header.ID, Version: 1},
		{ProjectID: header.ProjectID, ID: "00000000x0000-4000-8000-000000000002", Version: 1},
		{ProjectID: header.ProjectID, ID: strings.ToUpper("abcdef00-0000-4000-8000-000000000002"), Version: 1},
		{ProjectID: header.ProjectID, ID: header.ID},
		{ProjectID: header.ProjectID, ID: header.ID, Version: 1, DeletedAt: &step.CreatedAt},
	} {
		if _, _, err := EncodeCollection(candidate, []model.TaskStep{}); err == nil {
			t.Fatal("accepted invalid parent")
		}
		if _, _, err := EncodeItem(candidate, step); err == nil {
			t.Fatal("accepted invalid item parent")
		}
	}
	if _, _, err := EncodeCollection(header, nil); err == nil {
		t.Fatal("absent collection accepted")
	}
	gap := step
	gap.Position = 1
	if _, _, err := EncodeCollection(header, []model.TaskStep{gap}); err == nil {
		t.Fatal("position gap accepted")
	}
	if _, _, err := EncodeCollection(header, []model.TaskStep{step, gap}); err == nil {
		t.Fatal("duplicate ID accepted")
	}
	if _, err := encode(func() {}, 1); err == nil {
		t.Fatal("JSON encoding failure ignored")
	}
}

func TestCapacityReservesVersionWidthAndIncludesAllEncodedBytes(t *testing.T) {
	for _, version := range []int64{1, 9, 10, 9007199254740993, math.MaxInt64} {
		width := len(strings.TrimSpace(string(mustJSON(t, version))))
		exact := MaxEncodedBytes - (19 - width)
		if err := checkCapacity(exact, version); err != nil {
			t.Fatalf("exact capacity version %d: %v", version, err)
		}
		var limit *LimitError
		if err := checkCapacity(exact+1, version); !errors.As(err, &limit) || limit.EncodedBytes != MaxEncodedBytes+1 || limit.Error() == "" {
			t.Fatalf("oversize version %d: %+v, %v", version, limit, err)
		}
	}
}

func mustJSON(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

package task

import (
	"errors"
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestTagCandidate(t *testing.T) {
	a := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	b := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	current := model.Task{Version: 4, Tags: []model.TagReference{{ID: b}, {ID: a}}}
	for _, tc := range []struct {
		name    string
		version int64
		input   *[]string
		want    []string
		changed bool
		code    string
	}{
		{"omitted", 4, nil, []string{a, b}, false, ""},
		{"canonical duplicate", 4, &[]string{strings.ToUpper(b), a, b}, []string{a, b}, false, ""},
		{"clear", 4, &[]string{}, []string{}, true, ""},
		{"stale no-op", 3, nil, nil, false, "version_conflict"},
		{"invalid", 4, &[]string{"bad"}, nil, false, "invalid_input"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ids, changed, err := TagCandidate(current, tc.version, tc.input)
			if tc.code != "" {
				var fault *model.Fault
				if !errors.As(err, &fault) || fault.Code != tc.code {
					t.Fatalf("fault: %v", err)
				}
				return
			}
			if err != nil || changed != tc.changed || !reflect.DeepEqual(ids, tc.want) {
				t.Fatalf("ids=%v changed=%v err=%v", ids, changed, err)
			}
		})
	}
	current.Version = math.MaxInt64
	if _, changed, err := TagCandidate(current, current.Version, nil); err != nil || changed {
		t.Fatalf("maximum unchanged: %v %v", changed, err)
	}
	_, _, err := TagCandidate(current, current.Version, &[]string{})
	var fault *model.Fault
	if !errors.As(err, &fault) || fault.Code != "version_exhausted" {
		t.Fatalf("exhaustion: %v", err)
	}
}

func TestCreateTagIdentitySet(t *testing.T) {
	a := "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
	b := "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
	input := []string{strings.ToUpper(b), a, b}
	ids, err := NormalizeTagIDs(input)
	if err != nil || !reflect.DeepEqual(ids, []string{a, b}) || input[0] != strings.ToUpper(b) {
		t.Fatalf("normalization changed input or set: %v %v %v", input, ids, err)
	}
	for _, tc := range []struct {
		tags []model.TagReference
		want bool
	}{
		{[]model.TagReference{{ID: b}, {ID: a}}, true},
		{[]model.TagReference{{ID: a}}, false},
		{[]model.TagReference{{ID: a}, {ID: a}}, false},
		{[]model.TagReference{{ID: a}, {ID: b}, {ID: b}}, false},
	} {
		if got := MatchesTagIDs(tc.tags, ids); got != tc.want {
			t.Fatalf("matching %v: got %v want %v", tc.tags, got, tc.want)
		}
	}
	if !MatchesTagIDs(nil, nil) {
		t.Fatal("omitted set did not match empty references")
	}
	if _, err := NormalizeTagIDs([]string{"invalid"}); err == nil {
		t.Fatal("invalid identity admitted")
	}
}

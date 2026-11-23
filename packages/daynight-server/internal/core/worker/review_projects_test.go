package worker

import (
	"encoding/json"
	"reflect"
	"testing"
)

func TestReviewProjectIDs(t *testing.T) {
	a := configurationInputProjectA
	b := configurationInputProjectB
	cases := []struct {
		name string
		raw  string
		want []string
	}{
		{"missing", "", nil},
		{"targets", `{"projects":[{"projectId":"` + b + `","nativeOverrides":{}},{"projectId":"` + a + `","nativeOverrides":{}}],"future":true}`, []string{a, b}},
		{"duplicate", `{"projects":[{"projectId":"` + a + `","nativeOverrides":{}},{"projectId":"` + a + `","nativeOverrides":{}}]}`, []string{}},
		{"invalid item", `{"projects":[{"projectId":"bad","nativeOverrides":{}}]}`, []string{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := ReviewProjectIDs(json.RawMessage(tc.raw)); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
		})
	}
}

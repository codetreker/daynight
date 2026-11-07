package webhook

import (
	"fmt"
	"strings"
	"testing"

	model "github.com/codetreker/daynight/packages/daynight-server/internal/core/webhook/model"
)

func TestBucketStableOwnerScope(t *testing.T) {
	const id = "abcdefab-cdef-4abc-8def-abcdefabcdef"
	for _, tc := range []struct {
		owner model.Owner
		want  int16
	}{
		{model.Owner{Kind: "user", ID: id}, 3},
		{model.Owner{Kind: "user", ID: strings.ToUpper(id)}, 3},
		{model.Owner{Kind: "team", ID: id}, 14},
		{model.Owner{Kind: "user", ID: "11111111-1111-4111-8111-111111111111"}, 6},
	} {
		for i := 0; i < 10; i++ {
			if got := Bucket(tc.owner); got != tc.want {
				t.Fatalf("owner %#v: bucket %d, want %d", tc.owner, got, tc.want)
			}
		}
	}
	// Distinct owners may collide, but all assignments stay within the fixed
	// buckets and this deterministic sample exercises every bucket.
	seen := map[int16]bool{}
	for i := 0; i < 256; i++ {
		owner := model.Owner{Kind: "user", ID: fmt.Sprintf("00000000-0000-4000-8000-%012x", i)}
		bucket := Bucket(owner)
		if bucket < 0 || bucket >= 16 {
			t.Fatalf("owner %#v produced bucket %d", owner, bucket)
		}
		seen[bucket] = true
	}
	if len(seen) != 16 {
		t.Fatalf("sample reached %d buckets, want 16", len(seen))
	}
}

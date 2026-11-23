package session

import (
	"strings"
	"testing"

	sp "github.com/codetreker/daynight/packages/daynight-server/internal/core/session/protocol"
	"github.com/google/uuid"
)

func TestArchiveTimelineChunkUsesSchema3Limit(t *testing.T) {
	for _, n := range []int64{sp.MaxArchiveBytes + 1, sp.MaxArchiveTimelineBytes, sp.MaxArchiveTimelineBytes + 1} {
		t.Run(decimal(n), func(t *testing.T) {
			op, d, _ := archiveFlowFixture(t)
			d.bundle.Phase = "sealed"
			chunk := []byte("x")
			receipt, err := op.PutArchiveFile(t.Context(), "timeline", uuid.NewString(), 0, n, strings.Repeat("a", 64), archiveDigest(chunk), chunk)
			if n <= sp.MaxArchiveTimelineBytes {
				if err != nil || receipt.State != "receiving" || receipt.AcceptedOffset != "1" {
					t.Fatalf("schema3 chunk refused: %+v %v", receipt, err)
				}
			} else if err == nil {
				t.Fatal("schema3 transport limit accepted oversized file")
			}
		})
	}
}

package attachment

import (
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func TestBoundedContentReadsOneByteBeyondMaximum(t *testing.T) {
	for _, size := range []int{int(MaxFileBytes), int(MaxFileBytes) + 1, int(MaxFileBytes) + 1024} {
		t.Run(string(rune(size-int(MaxFileBytes)+'a')), func(t *testing.T) {
			source := strings.NewReader(strings.Repeat("x", size))
			body, err := io.ReadAll(BoundedContent(source))
			if len(body) != int(MaxFileBytes) {
				t.Fatalf("got %d bytes", len(body))
			}
			var fault *model.Fault
			var overflow *ContentOverflowError
			if size == int(MaxFileBytes) && err != nil {
				t.Fatal(err)
			}
			if size > int(MaxFileBytes) && (!errors.As(err, &overflow) || !errors.As(err, &fault) || fault.Code != "payload_too_large" || source.Len() != size-int(MaxFileBytes)-1) {
				t.Fatalf("err=%v remaining=%d", err, source.Len())
			}
		})
	}
}

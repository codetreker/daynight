package attachment

import (
	"io"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

// MaxFileBytes is the largest accepted complete attachment content.
const MaxFileBytes int64 = 5 << 20

// FileTooLarge reports a definite refusal before attachment publication.
func FileTooLarge() error {
	return &model.Fault{Code: "payload_too_large", Message: "Attachment content exceeds 5 MiB."}
}

// ContentOverflowError identifies a byte observed beyond the complete-content
// limit. Its domain fault remains available to non-HTTP consumers.
type ContentOverflowError struct{}

func (e *ContentOverflowError) Error() string { return e.Unwrap().Error() }
func (*ContentOverflowError) Unwrap() error   { return FileTooLarge() }

// BoundedContent preserves an explicit overflow error rather than accepting a
// truncated EOF. It reads at most one byte beyond the limit.
func BoundedContent(source io.Reader) io.Reader {
	return &boundedContent{source: source, remaining: MaxFileBytes}
}

type boundedContent struct {
	source    io.Reader
	remaining int64
}

func (r *boundedContent) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if r.remaining == 0 {
		var probe [1]byte
		n, err := r.source.Read(probe[:])
		if n > 0 {
			return 0, &ContentOverflowError{}
		}
		return 0, err
	}
	if int64(len(p)) > r.remaining {
		p = p[:r.remaining]
	}
	n, err := r.source.Read(p)
	r.remaining -= int64(n)
	return n, err
}

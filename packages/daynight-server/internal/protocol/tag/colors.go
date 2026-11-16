package tag

import (
	"io"

	"github.com/codetreker/daynight/packages/daynight-server/api"
	"github.com/codetreker/daynight/packages/daynight-server/internal/protocol/measure"
)

// EncodeColors bounds the actual response representation, including its newline.
func EncodeColors(w io.Writer, page api.TagColorPage) (int64, error) {
	return measure.JSON(w, "tag color resolution response", MaxResolveBytes, page, true)
}

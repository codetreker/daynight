package webhook

import "github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"

// SetTestTransport replaces network dependencies only in the test binary.
func (r *Runner) SetTestTransport(c *httpoutbound.Client) { r.client = c }

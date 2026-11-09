//go:build webhookfixture

package webhook

import "github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"

// SetFixtureTransport injects an isolated receiver transport into the test host.
func (r *Runner) SetFixtureTransport(c *httpoutbound.Client) { r.client = c }

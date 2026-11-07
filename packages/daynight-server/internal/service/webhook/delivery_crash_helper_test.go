package webhook

import (
	"context"
	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/httpoutbound"
	"net/http"
	"os"
)

type exitAfterHTTP struct{ inner *httpoutbound.Client }

func (x exitAfterHTTP) Do(ctx context.Context, target string, body []byte, headers http.Header) (httpoutbound.Response, error) {
	r, err := x.inner.Do(ctx, target, body, headers)
	if err == nil {
		os.Exit(0)
	}
	return r, err
}
func (r *Runner) SetExitAfterHTTP(c *httpoutbound.Client) { r.client = exitAfterHTTP{inner: c} }

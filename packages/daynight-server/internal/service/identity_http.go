package service

import (
	"errors"
	"io"
	"net/http"
	"time"

	coreidentity "github.com/codetreker/daynight/packages/daynight-server/internal/core/identity"
	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model/limit"
)

var errIdentityResponseTooLarge = errors.New("identity response exceeds 2 MiB")

// identityHTTPClient keeps the SDK's default timeout. The standard transport
// decompresses gzip before this wrapper observes response bytes.
func identityHTTPClient() *http.Client {
	return &http.Client{Timeout: 30 * time.Second, Transport: identityResponseTransport{base: http.DefaultTransport}}
}

type identityResponseTransport struct{ base http.RoundTripper }

func (t identityResponseTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := t.base.RoundTrip(request)
	if err != nil {
		return response, err
	}
	response.Body = &identityResponseBody{body: response.Body, remaining: coreidentity.MaxIdentityResponseBytes}
	return response, nil
}

type identityResponseBody struct {
	body      io.ReadCloser
	remaining int64
	overflow  bool
}

func (b *identityResponseBody) Read(p []byte) (int, error) {
	if len(p) == 0 {
		return 0, nil
	}
	if b.overflow {
		return 0, errIdentityResponseTooLarge
	}
	if b.remaining == 0 {
		var probe [1]byte
		n, err := b.body.Read(probe[:])
		if n != 0 {
			b.overflow = true
			return 0, errors.Join(errIdentityResponseTooLarge, &limit.Violation{Field: "identity.response", Actual: coreidentity.MaxIdentityResponseBytes + 1, Max: coreidentity.MaxIdentityResponseBytes, Unit: "bytes", LowerBound: true}, err)
		}
		return 0, err
	}
	if int64(len(p)) > b.remaining {
		p = p[:b.remaining]
	}
	n, err := b.body.Read(p)
	b.remaining -= int64(n)
	return n, err
}

func (b *identityResponseBody) Close() error { return b.body.Close() }

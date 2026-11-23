package auth

import (
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

func (h *RequestAuthentication) cookieOriginError(r *http.Request) error {
	if r.Method == http.MethodGet || r.Method == http.MethodHead || r.Method == http.MethodOptions {
		return nil
	}
	origins := r.Header.Values("Origin")
	if len(origins) != 1 || origins[0] != h.origin {
		return &model.Fault{Code: "forbidden", Message: "Cookie writes require the exact main-site Origin."}
	}
	return nil
}

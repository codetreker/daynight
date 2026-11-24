package preview

import (
	"errors"
	"net/http"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/model"
)

type authenticatedPreviewKey struct{}
type authenticatedPreview struct {
	secret    string
	principal model.Principal
}

// RenewAuthorized runs only after the protected attachment has been opened. The
// credential remains the exact secret authenticated at this request's entry.
func (h *Routes) RenewAuthorized(r *http.Request, p model.Principal) error {
	if !h.admitsActivity(r) {
		return nil
	}
	admitted, ok := r.Context().Value(authenticatedPreviewKey{}).(authenticatedPreview)
	if !ok || admitted.principal != p {
		return errors.New("preview activity lacks its authenticated request identity")
	}
	return h.ops.Renew(r.Context(), admitted.secret, p)
}

func previewHeader(r *http.Request, name string) (string, bool, bool) {
	values, present := r.Header[http.CanonicalHeaderKey(name)]
	if !present {
		return "", false, true
	}
	if len(values) != 1 || values[0] == "" {
		return "", true, false
	}
	return values[0], true, true
}

func (h *Routes) admitsActivity(r *http.Request) bool {
	if (r.Method != http.MethodGet && r.Method != http.MethodHead) || h.taskHost(r.Host) == "" || h.taskHost(r.Host) != r.PathValue("taskId") {
		return false
	}
	site, hasSite, validSite := previewHeader(r, "Sec-Fetch-Site")
	mode, hasMode, validMode := previewHeader(r, "Sec-Fetch-Mode")
	dest, hasDest, validDest := previewHeader(r, "Sec-Fetch-Dest")
	user, hasUser, validUser := previewHeader(r, "Sec-Fetch-User")
	origin, hasOrigin, validOrigin := previewHeader(r, "Origin")
	if !hasSite || !hasMode || !hasDest || !validSite || !validMode || !validDest || !validUser || !validOrigin || hasUser && user != "?1" {
		return false
	}
	if hasOrigin && (site != "same-origin" || origin != h.preview.Scheme+"://"+r.Host) {
		return false
	}
	switch site {
	case "same-origin":
		switch mode {
		case "cors", "same-origin", "no-cors":
			if hasUser {
				return false
			}
			switch dest {
			case "audio", "audioworklet", "empty", "font", "image", "json", "manifest", "paintworklet", "report", "script", "serviceworker", "sharedworker", "style", "text", "track", "video", "webidentity", "worker", "xslt":
				return true
			}
		case "navigate":
			return r.Method == http.MethodGet && (dest == "document" || dest == "embed" || dest == "frame" || dest == "iframe" || dest == "object")
		}
	case "same-site":
		if r.Method == http.MethodGet && mode == "navigate" && dest == "iframe" {
			return true
		}
	}
	return r.Method == http.MethodGet && mode == "navigate" && dest == "document" && hasUser && (site == "none" || site == "same-site" || site == "cross-site")
}

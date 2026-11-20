package attachment

import (
	"net/http"
	"strings"

	"github.com/codetreker/daynight/packages/daynight-server/internal/core/scopepolicy"
)

// ScopeRoute records the classification attached to one host's registration.
type ScopeRoute struct {
	Pattern           string
	Operations        []scopepolicy.Operation
	PublicNavigation  bool
	PreviewCookieOnly bool
	Fallback          bool
}

type routeClass int

const (
	routeRead routeClass = iota
	routeUpload
	routeDelete
	routePreviewCookie
	routeFallback
	routePreviewCookieFallback
)

type routeRegistry struct {
	mux     *http.ServeMux
	observe func(ScopeRoute)
}

func (r routeRegistry) handle(pattern string, handler http.HandlerFunc, class routeClass, autoHEAD bool) {
	entry := ScopeRoute{Pattern: pattern}
	switch class {
	case routeRead:
		entry.Operations = []scopepolicy.Operation{scopepolicy.AttachmentRead}
	case routeUpload:
		entry.Operations = []scopepolicy.Operation{scopepolicy.AttachmentUpload, scopepolicy.AttachmentRead}
	case routeDelete:
		entry.Operations = []scopepolicy.Operation{scopepolicy.AttachmentDelete}
	case routePreviewCookie:
		entry.PreviewCookieOnly = true
	case routeFallback:
		entry.Fallback = true
	case routePreviewCookieFallback:
		entry.PreviewCookieOnly, entry.Fallback = true, true
	default:
		panic("unclassified attachment route")
	}
	r.mux.HandleFunc(pattern, handler)
	if r.observe != nil {
		r.observe(entry)
		if autoHEAD && strings.HasPrefix(pattern, "GET ") {
			entry.Pattern = "HEAD " + strings.TrimPrefix(pattern, "GET ")
			r.observe(entry)
		}
	}
}

func (r routeRegistry) handlePreview(pattern string, navigate, readHead http.HandlerFunc) {
	// The inherited HEAD match also identifies preview reads to the root CORS
	// adapter, whose explicit HEAD registrations represent protocol refusals.
	r.mux.HandleFunc("GET "+pattern, func(w http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodHead {
			readHead(w, request)
			return
		}
		navigate(w, request)
	})
	if r.observe != nil {
		r.observe(ScopeRoute{Pattern: "GET " + pattern, PublicNavigation: true})
		r.observe(ScopeRoute{Pattern: "HEAD " + pattern, Operations: []scopepolicy.Operation{scopepolicy.AttachmentRead}})
	}
}

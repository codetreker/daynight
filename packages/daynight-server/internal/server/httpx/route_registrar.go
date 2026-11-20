package httpx

import "net/http"

// RouteRegistrar allows production assembly to record the exact routes installed
// by protocol adapters, including fallbacks and implicit HEAD registrations.
type RouteRegistrar interface {
	Handle(string, http.Handler)
	HandleFunc(string, func(http.ResponseWriter, *http.Request))
}

package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"strings"
)

type routeClassification struct {
	Host      string
	Pattern   string
	Admission string
	Profile   string
}

type scopeRegistry struct {
	mux     *http.ServeMux
	host    string
	routes  []routeClassification
	sealed  bool
	details []json.RawMessage
}

func observeScopeRoutes[T any](r *scopeRegistry) func(T) {
	return func(value T) {
		encoded, err := json.Marshal(value)
		if err != nil {
			panic(fmt.Errorf("encode route classification: %w", err))
		}
		r.details = append(r.details, encoded)
	}
}

type classifiedRoutes struct {
	registry  *scopeRegistry
	admission string
	profile   string
}

func newScopeRegistry(mux *http.ServeMux, host string) *scopeRegistry {
	return &scopeRegistry{mux: mux, host: host}
}

// scoped names the domain resolver that owns field-dependent requirements and
// profile exceptions. Fixed entries name the existing public or special profile.
func (r *scopeRegistry) scoped(admission string) classifiedRoutes {
	return classifiedRoutes{registry: r, admission: admission, profile: "business-scope"}
}

func (r *scopeRegistry) fixed(profile string) classifiedRoutes {
	return classifiedRoutes{registry: r, admission: "fixed-profile", profile: profile}
}

func (r *scopeRegistry) Handle(pattern string, handler http.Handler) {
	r.register(pattern, handler, "", "")
}

func (r *scopeRegistry) HandleFunc(pattern string, handler func(http.ResponseWriter, *http.Request)) {
	r.Handle(pattern, http.HandlerFunc(handler))
}

func (r classifiedRoutes) Handle(pattern string, handler http.Handler) {
	r.registry.register(pattern, handler, r.admission, r.profile)
}

func (r classifiedRoutes) HandleFunc(pattern string, handler func(http.ResponseWriter, *http.Request)) {
	r.Handle(pattern, http.HandlerFunc(handler))
}

func (r *scopeRegistry) register(pattern string, handler http.Handler, admission, profile string) {
	if r.sealed {
		panic("route registration after scope inventory validation")
	}
	entry := routeClassification{Host: r.host, Pattern: pattern, Admission: admission, Profile: profile}
	r.routes = append(r.routes, entry)
	if strings.HasPrefix(pattern, "GET ") {
		entry.Pattern = "HEAD " + strings.TrimPrefix(pattern, "GET ")
		r.routes = append(r.routes, entry)
	}
	if admission == "" || profile == "" {
		handler = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "route authorization is unclassified", http.StatusServiceUnavailable)
		})
	}
	r.mux.Handle(pattern, handler)
}

func (r *scopeRegistry) validate() error {
	for _, entry := range r.routes {
		if entry.Admission == "" || entry.Profile == "" {
			return fmt.Errorf("unclassified %s route %s", entry.Host, entry.Pattern)
		}
	}
	r.sealed = true
	return nil
}

func (r *scopeRegistry) inventory() []routeClassification {
	// An explicit HEAD registration supersedes the HEAD implied by GET.
	entries := make(map[string]routeClassification, len(r.routes))
	for _, entry := range r.routes {
		entries[entry.Host+" "+entry.Pattern] = entry
	}
	result := make([]routeClassification, 0, len(entries))
	for _, entry := range entries {
		result = append(result, entry)
	}
	slices.SortFunc(result, func(a, b routeClassification) int { return strings.Compare(a.Host+" "+a.Pattern, b.Host+" "+b.Pattern) })
	return result
}

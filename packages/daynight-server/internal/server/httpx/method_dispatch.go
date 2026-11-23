package httpx

import (
	"context"
	"net/http"
)

type dispatchedMethodKey struct{}

type dispatchedMethod struct {
	method   string
	business bool
}

// MethodDispatch declares the business methods of an internally dispatched
// route before authentication runs. HEAD must be declared when supported.
func MethodDispatch(next http.HandlerFunc, methods ...string) http.HandlerFunc {
	declared := make(map[string]bool, len(methods))
	for _, method := range methods {
		declared[method] = true
	}
	return func(w http.ResponseWriter, r *http.Request) {
		role := dispatchedMethod{method: r.Method, business: declared[r.Method]}
		next(w, r.WithContext(context.WithValue(r.Context(), dispatchedMethodKey{}, role)))
	}
}

func IsDispatchedMethod(r *http.Request) bool {
	role, marked := r.Context().Value(dispatchedMethodKey{}).(dispatchedMethod)
	return marked && role.business && role.method == r.Method
}

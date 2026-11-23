package httpx

import (
	"context"
	"net/http"
)

type methodRejectionKey struct{}

// MethodRejection marks a registered refusal before its authentication wrapper
// runs. Method-qualified refusals can shadow a less-specific business route.
func MethodRejection(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		next(w, r.WithContext(context.WithValue(r.Context(), methodRejectionKey{}, true)))
	}
}

func IsMethodRejection(r *http.Request) bool {
	marked, _ := r.Context().Value(methodRejectionKey{}).(bool)
	return marked
}

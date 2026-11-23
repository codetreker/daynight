package httpx

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMethodDispatchMarksOnlyDeclaredMethodAndPreservesCancellation(t *testing.T) {
	type requestValue struct{}
	ctx, cancel := context.WithCancel(context.WithValue(t.Context(), requestValue{}, "original"))
	cancel()
	for _, method := range []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPatch, http.MethodOptions} {
		request := httptest.NewRequestWithContext(ctx, method, "https://daynight.test/resource", nil)
		request.Pattern = "/resource"
		called := false
		MethodDispatch(func(_ http.ResponseWriter, r *http.Request) {
			called = true
			want := method == http.MethodGet || method == http.MethodHead || method == http.MethodPost
			if IsDispatchedMethod(r) != want || r.Context().Err() != context.Canceled || r.Context().Value(requestValue{}) != "original" || r.Pattern != request.Pattern || r.URL != request.URL {
				t.Fatal("dispatch changed request identity, context or declared method")
			}
			copy := r.Clone(r.Context())
			copy.Method = http.MethodDelete
			if IsDispatchedMethod(copy) {
				t.Fatal("dispatch admitted a changed method")
			}
		}, http.MethodGet, http.MethodHead, http.MethodPost)(httptest.NewRecorder(), request)
		if !called || IsDispatchedMethod(request) {
			t.Fatal("dispatch changed its caller's request")
		}
	}
}

func TestMethodDispatchDoesNotInheritAnotherDispatchersAdmission(t *testing.T) {
	called := false
	inner := MethodDispatch(func(_ http.ResponseWriter, r *http.Request) {
		called = true
		if IsDispatchedMethod(r) {
			t.Fatal("unsupported method inherited business admission")
		}
	}, http.MethodPost)
	MethodDispatch(inner, http.MethodGet)(httptest.NewRecorder(), httptest.NewRequest(http.MethodGet, "https://daynight.test/resource", nil))
	if !called {
		t.Fatal("dispatch did not preserve its refusal handler")
	}
}

package httpx

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestMethodRejectionPreservesRequestAndCancellation(t *testing.T) {
	type requestValue struct{}
	ctx, cancel := context.WithCancel(context.WithValue(t.Context(), requestValue{}, "original"))
	request := httptest.NewRequestWithContext(ctx, http.MethodPatch, "https://daynight.test/refused", nil)
	request.Pattern = "PATCH /refused"
	cancel()
	called := false
	MethodRejection(func(w http.ResponseWriter, r *http.Request) {
		called = true
		if !IsMethodRejection(r) || r.Context().Err() != context.Canceled || r.Context().Value(requestValue{}) != "original" || r.Method != request.Method || r.Pattern != request.Pattern || r.URL != request.URL {
			t.Fatal("method refusal lost request identity or cancellation")
		}
		w.WriteHeader(http.StatusMethodNotAllowed)
	})(httptest.NewRecorder(), request)
	if !called || IsMethodRejection(request) {
		t.Fatal("method refusal changed its caller's request")
	}
}

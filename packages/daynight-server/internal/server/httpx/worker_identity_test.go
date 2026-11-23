package httpx

import (
	"net/http"
	"testing"
)

func TestWorkerIdentityProtocol(t *testing.T) {
	for _, values := range [][]string{nil, {"1"}, {"2"}, {""}, {"1", "1"}, {"1, 1"}} {
		header := http.Header{}
		for _, value := range values {
			header.Add(WorkerIdentityHeader, value)
		}
		enabled, err := WorkerIdentityProtocol(header)
		valid := len(values) == 0 || len(values) == 1 && values[0] == "1"
		if (err == nil) != valid || enabled != (valid && len(values) == 1) {
			t.Fatalf("values=%v enabled=%v err=%v", values, enabled, err)
		}
	}
}

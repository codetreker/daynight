package auth

import (
	"net/http"
	"testing"
)

func TestDeviceSourceWithoutPort(t *testing.T) {
	if source := deviceSource(&http.Request{RemoteAddr: "source-without-port"}); source != "source-without-port" {
		t.Fatalf("source: %s", source)
	}
}

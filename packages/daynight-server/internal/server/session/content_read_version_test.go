package session

import (
	"net/http/httptest"
	"testing"
)

func TestContentReadVersionRequiresOneSupportedHandshakeValue(t *testing.T) {
	for _, test := range []struct {
		name    string
		values  []string
		want    int
		invalid bool
	}{
		{"legacy", nil, 0, false},
		{"supported", []string{"1"}, 1, false},
		{"unsupported", []string{"2"}, 0, true},
		{"duplicate", []string{"1", "1"}, 0, true},
		{"list", []string{"1, 1"}, 0, true},
		{"empty", []string{""}, 0, true},
	} {
		t.Run(test.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/api/v1/controller-channel", nil)
			for _, v := range test.values {
				r.Header.Add("X-Daynight-Content-Read-Version", v)
			}
			got, err := contentReadVersion(r)
			if got != test.want || (err != nil) != test.invalid {
				t.Fatalf("version=%d error=%v", got, err)
			}
		})
	}
}

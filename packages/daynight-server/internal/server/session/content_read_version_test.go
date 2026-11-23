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

func TestOnlineRelayCapabilities(t *testing.T) {
	for _, tc := range []struct {
		name                         string
		relay, body                  []string
		wantRelay, wantBody, invalid bool
	}{
		{"absent", nil, nil, false, false, false},
		{"legacy task body", nil, []string{"1"}, false, true, false},
		{"relay", []string{"1"}, nil, true, false, false},
		{"task body", []string{"1"}, []string{"1"}, true, true, false},
		{"unknown", []string{"2"}, nil, false, false, true},
		{"duplicate", []string{"1", "1"}, nil, false, false, true},
		{"bad body", []string{"1"}, []string{"2"}, false, false, true},
		{"duplicate body", []string{"1"}, []string{"1", "1"}, false, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "/api/v1/controller-channel", nil)
			for _, v := range tc.relay {
				r.Header.Add("Daynight-Online-Relay-Version", v)
			}
			for _, v := range tc.body {
				r.Header.Add("Daynight-Task-Body-History-Version", v)
			}
			relay, body, err := onlineRelayCapabilities(r)
			if relay != tc.wantRelay || body != tc.wantBody || (err != nil) != tc.invalid {
				t.Fatalf("relay=%v body=%v error=%v", relay, body, err)
			}
		})
	}
}

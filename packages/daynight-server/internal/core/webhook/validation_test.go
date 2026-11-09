package webhook

import (
	"errors"
	"strings"
	"testing"
	"time"
)

func TestNormalizeName(t *testing.T) {
	for _, tc := range []struct {
		input, want string
		valid       bool
	}{
		{"  工作通知  ", "工作通知", true},
		{strings.Repeat("界", 120), strings.Repeat("界", 120), true},
		{"\n normal \t", "normal", true},
		{"", "", false},
		{" \t", "", false},
		{strings.Repeat("界", 121), "", false},
		{"a\nb", "", false},
		{string([]byte{0xff}), "", false},
	} {
		got, err := NormalizeName(tc.input)
		if (err == nil) != tc.valid || got != tc.want {
			t.Errorf("NormalizeName(%q) = %q, %v", tc.input, got, err)
		}
	}
}

func TestValidateURL(t *testing.T) {
	for _, tc := range []struct {
		input, origin string
		valid         bool
	}{
		{"https://Example.test:8443/Secret/Case?token=Case%2fX", "https://Example.test:8443", true},
		{"https://[2001:db8::1]/secret?q=a", "https://[2001:db8::1]", true},
		{"https://example.test/路径", "https://example.test", true},
		{"http://example.test/path", "", false},
		{"https://u:p@example.test/path", "", false},
		{"https://example.test/path#", "", false},
		{"https://example.test/path#secret", "", false},
		{"https:example.test", "", false},
		{"https:///path", "", false},
		{"https://example.test/?q=%zz", "", false},
		{"https://example.test/" + strings.Repeat("界", 500), "", false},
		{"https://example.test/" + strings.Repeat("x", 4096), "", false},
		{string([]byte{'h', 0xff}), "", false},
	} {
		origin, err := ValidateURL(tc.input)
		if (err == nil) != tc.valid || origin != tc.origin {
			t.Errorf("ValidateURL(%q) = %q, %v", tc.input, origin, err)
		}
	}
}

func TestUUIDAndVersion(t *testing.T) {
	for _, tc := range []struct {
		value string
		valid bool
	}{
		{"abcdefff-1111-4111-8111-111111111111", true},
		{"ABCDEFFF-1111-4111-8111-111111111111", false},
		{"00000000-0000-0000-0000-000000000000", true},
		{"abcdefff111141118111111111111111", false},
		{"invalid", false},
	} {
		if err := CanonicalUUID(tc.value); (err == nil) != tc.valid {
			t.Errorf("UUID %q: %v", tc.value, err)
		}
	}
	for _, tc := range []struct {
		value string
		want  int64
		valid bool
	}{
		{"1", 1, true}, {"9007199254740993", 9007199254740993, true}, {"9223372036854775807", 9223372036854775807, true},
		{"9223372036854775808", 0, false}, {"01", 0, false}, {"+1", 0, false}, {"0", 0, false}, {"-1", 0, false}, {"1.0", 0, false},
	} {
		got, err := ParseVersion(tc.value)
		if got != tc.want || (err == nil) != tc.valid {
			t.Errorf("Version %q = %d, %v", tc.value, got, err)
		}
	}
}

func TestIssuedAt(t *testing.T) {
	for _, tc := range []struct {
		value string
		valid bool
	}{
		{"2026-11-07T08:00:00Z", true}, {"2026-11-07T08:00:00.123400+00:00", true},
		{"2026-11-07T08:00:00-00:00", false}, {"2026-11-07T09:00:00+01:00", false},
		{"2026-11-07T08:00:00,1Z", false}, {"2026-11-07t08:00:00z", false},
		{"2026-02-30T08:00:00Z", false}, {"2026-11-07T08:00:00", false},
	} {
		_, err := ParseIssuedAt(tc.value)
		if (err == nil) != tc.valid {
			t.Errorf("issuedAt %q: %v", tc.value, err)
		}
	}
	now := time.Date(2026, 11, 7, 8, 0, 0, 0, time.UTC)
	for _, tc := range []struct {
		offset time.Duration
		want   error
	}{
		{-5*time.Minute - time.Nanosecond, ErrOperationExpired}, {-5 * time.Minute, nil},
		{time.Minute, nil}, {time.Minute + time.Nanosecond, ErrOperationInFuture},
	} {
		if err := CheckIssuedAt(now.Add(tc.offset), now); !errors.Is(err, tc.want) {
			t.Errorf("offset %s: %v", tc.offset, err)
		}
	}
	if err := CheckIssuedAtText("2026-11-07T08:01:00.0000000001Z", now); !errors.Is(err, ErrOperationInFuture) {
		t.Fatalf("sub-nanosecond future bound: %v", err)
	}
	if err := CheckIssuedAtText("2026-11-07T08:01:00.0000000000Z", now); err != nil {
		t.Fatalf("exact upper bound: %v", err)
	}
	if err := CheckIssuedAtText("not a time", now); !errors.Is(err, ErrInvalidInput) {
		t.Fatalf("invalid time: %v", err)
	}

}

func TestFingerprintBindsIntent(t *testing.T) {
	name := "name"
	enabled := false
	version := int64(9007199254740993)
	intent := Intent{OperationID: "operation", ActorID: "actor", OwnerKind: "team", OwnerID: "owner", Kind: "endpoint.update", TargetID: "endpoint", IssuedAt: "2026-11-07T08:00:00.00Z", IfVersion: &version, Name: &name, Enabled: &enabled, Destination: &Destination{Kind: "http", AdapterVersion: "1", URL: "https://example.test/Private"}, HasSubscriptions: true, Mode: "overlap"}
	base, err := Fingerprint(intent)
	if err != nil || len(base) != 64 {
		t.Fatalf("fingerprint: %q, %v", base, err)
	}
	mutations := []func(*Intent){
		func(v *Intent) { v.OperationID = "other" }, func(v *Intent) { v.ActorID = "other" },
		func(v *Intent) { v.OwnerKind = "user" }, func(v *Intent) { v.OwnerID = "other" },
		func(v *Intent) { v.Kind = "other" }, func(v *Intent) { v.TargetID = "other" },
		func(v *Intent) { v.IssuedAt = "2026-11-07T08:00:00Z" }, func(v *Intent) { v.IfVersion = nil },
		func(v *Intent) { v.Name = nil }, func(v *Intent) { v.Enabled = nil },
		func(v *Intent) {
			v.Destination = &Destination{Kind: "http", AdapterVersion: "1", URL: "https://example.test/private"}
		},
		func(v *Intent) { v.HasSubscriptions = false }, func(v *Intent) { v.Mode = "immediate" },
	}
	for i, mutate := range mutations {
		changed := intent
		mutate(&changed)
		got, err := Fingerprint(changed)
		if err != nil || got == base {
			t.Errorf("field %d did not bind: %q, %v", i, got, err)
		}
	}
	copy := intent
	if got, err := Fingerprint(copy); err != nil || got != base {
		t.Fatalf("same semantic input: %q, %v", got, err)
	}
}

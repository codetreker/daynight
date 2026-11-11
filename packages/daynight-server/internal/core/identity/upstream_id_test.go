package identity

import "testing"

func TestCanonicalUniAuthID(t *testing.T) {
	for _, test := range []struct{ input, want string }{
		{"microsoft:tenant:object", "msft:object@tenant"},
		{"msft:object@tenant", "msft:object@tenant"},
		{"microsoft:another-tenant:object", "msft:object@another-tenant"},
		{"microsoft:tenant:another-object", "msft:another-object@tenant"},
		{"google:123", "google:123"},
		{"github:123", "github:123"},
		{"opaque-upstream-key", "opaque-upstream-key"},
		{"google:microsoft:tenant:object", "google:microsoft:tenant:object"},
	} {
		t.Run(test.input, func(t *testing.T) {
			got, err := CanonicalUniAuthID(test.input)
			if err != nil || got != test.want {
				t.Fatalf("canonical identity = %q, %v; want %q", got, err, test.want)
			}
			repeated, err := CanonicalUniAuthID(got)
			if err != nil || repeated != got {
				t.Fatalf("canonical identity changed on repetition: %q, %v", repeated, err)
			}
		})
	}
}

func TestCanonicalUniAuthIDRejectsAmbiguousMicrosoftKeys(t *testing.T) {
	for _, input := range []string{
		"microsoft:", "microsoft:tenant", "microsoft::object", "microsoft:tenant:",
		"microsoft:tenant:object:extra", "microsoft:tenant@other:object", "microsoft:tenant:object@other",
		"msft:", "msft:object", "msft:@tenant", "msft:object@", "msft:object@tenant@extra",
		"msft:object:extra@tenant", "msft:object@tenant:extra",
	} {
		t.Run(input, func(t *testing.T) {
			if got, err := CanonicalUniAuthID(input); err == nil || got != "" {
				t.Fatalf("malformed identity accepted: %q, %v", got, err)
			}
		})
	}
}

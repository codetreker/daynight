package config

import (
	"errors"
	"strings"
	"testing"

	"github.com/codetreker/daynight/packages/daynight-server/internal/utils/configvalue"
)

func TestGitHubFieldsInYAMLMergeSequences(t *testing.T) {
	for _, tc := range []struct {
		name, extra string
		wantErr     bool
	}{
		{"section aliases", `first: &first {enabled: false}
second: &second {app_id: 7}
github:
  <<: [*first, *second, *first]
`, false},
		{"section unknown alias", `first: &first {enabled: false}
second: &second {not_a_setting: private-secret}
github:
  <<: [*first, *second]
`, true},
		{"root aliases", `first: &first {github: {enabled: false}}
second: &second {webhook: {enabled: false}}
<<: [*first, *second, *first]
`, false},
		{"root unknown alias", `first: &first {github: {enabled: false}}
second: &second {github: {not_a_setting: private-secret}}
<<: [*first, *second]
`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			root := t.TempDir()
			writeLayer(t, root, "config.yml", validBase+tc.extra)
			_, err := LoadServer(root, lookupValues(nil))
			if !tc.wantErr {
				if err != nil {
					t.Fatalf("valid merge: %v", err)
				}
				return
			}
			var failure *configvalue.ConfigurationError
			if !errors.As(err, &failure) || failure.Field != "github" || failure.Phase != "decode" || failure.Origin.Source != "config.yml" || strings.Contains(err.Error(), "private-secret") {
				t.Fatalf("unexpected merge error: %v", err)
			}
		})
	}
}

func TestGitHubSectionRejectsScalarAndNonMappingRoot(t *testing.T) {
	for _, content := range []string{"github: 1\n", "not-a-mapping\n"} {
		root := t.TempDir()
		writeLayer(t, root, "config.yml", content)
		if _, err := LoadServer(root, lookupValues(nil)); err == nil {
			t.Fatalf("accepted %q", content)
		}
	}
}
